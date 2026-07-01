import { and, asc, eq, sql } from "drizzle-orm";
import type { DiscoveryProvider } from "@/db/schema";
import { discoveryJobs, discoveryRuns, leads, profiles } from "@/db/schema";
import type { Db } from "@/lib/db";
import { isSuppressed } from "@/lib/suppression";
import { discover, type RawCandidate } from "@/lib/agent/discovery";
import { enrich } from "@/lib/agent/enrich";
import { scoreLead, dedupeKey } from "@/lib/agent/score";
import { buildDraft } from "@/lib/agent/copywriter";
import { verifyEmail } from "@/lib/verify";

/* Background discovery for large / "unlimited" sweeps. A synchronous run fetches
   AND enriches up to ~150 businesses inside one request — fine for a quick scan,
   too slow for "every business in 50 miles" (that's thousands of site fetches).
   So a job splits the work:

     1. enqueue  — hit the provider ONCE, stage every candidate (up to 600) in the
                   job row, and return immediately.
     2. process  — a worker (cron or the in-app poller) enriches + scores + inserts
                   a small batch at a time, advancing a cursor, across as many
                   invocations as it takes. No request ever runs longer than a batch.

   Re-runnable and idempotent: leads dedupe on (account, dedupeKey), and the cursor
   means a crashed batch just resumes where it left off. */

const STAGE_CAP = 600; // most candidates one job will stage
const BATCH = 12; // candidates enriched per batch (each fetches a website)
const POOL = 6; // concurrent site fetches within a batch

export type EnqueueInput = {
  accountId: string;
  provider: DiscoveryProvider;
  vertical: string;
  location: string;
  radiusMiles: number;
  minScore: number;
};

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Create a job, fetch every candidate once, and stage them for batched
    enrichment. Returns the job id and how many were staged. */
export async function enqueueDiscovery(db: Db, input: EnqueueInput): Promise<{ jobId: string; total: number; note: string }> {
  const [run] = await db
    .insert(discoveryRuns)
    .values({
      accountId: input.accountId,
      vertical: input.vertical,
      location: input.location,
      provider: input.provider,
      requested: STAGE_CAP,
      minScore: input.minScore,
      status: "running",
    })
    .returning({ id: discoveryRuns.id });

  const [job] = await db
    .insert(discoveryJobs)
    .values({
      accountId: input.accountId,
      runId: run.id,
      provider: input.provider,
      vertical: input.vertical,
      location: input.location,
      radiusMiles: input.radiusMiles,
      minScore: input.minScore,
      status: "staging",
    })
    .returning({ id: discoveryJobs.id });

  let candidates: RawCandidate[] = [];
  let note = "";
  try {
    const r = await discover(input.provider, input.vertical, input.location, STAGE_CAP, input.radiusMiles);
    candidates = r.candidates;
    note = r.note;
  } catch (err) {
    note = `Provider error: ${String(err).slice(0, 160)}`;
  }

  await db
    .update(discoveryJobs)
    .set({
      candidates,
      total: candidates.length,
      status: candidates.length ? "enriching" : "done",
      note,
      updatedAt: new Date(),
    })
    .where(eq(discoveryJobs.id, job.id));

  if (!candidates.length) {
    await db.update(discoveryRuns).set({ status: "done", found: 0, note }).where(eq(discoveryRuns.id, run.id));
  }
  return { jobId: job.id, total: candidates.length, note };
}

/** Enrich + score + insert the next batch of one job. Returns whether the job is
    now finished and how many leads this batch added. */
export async function processJobBatch(
  db: Db,
  jobId: string,
  batchSize = BATCH
): Promise<{ done: boolean; addedDelta: number; processed: number; total: number }> {
  const job = (await db.select().from(discoveryJobs).where(eq(discoveryJobs.id, jobId)))[0];
  if (!job || job.status !== "enriching" || job.processed >= job.total) {
    const fin = !job || job.processed >= job.total || job.status === "done";
    return { done: fin, addedDelta: 0, processed: job?.processed ?? 0, total: job?.total ?? 0 };
  }

  const start = job.processed;
  const sliceLen = Math.min(batchSize, job.total - start);

  /* Atomically CLAIM this slice: advance the cursor only if it STILL equals what
     we read and the job is still enriching. If a concurrent tick (another browser
     tab, or the cron) already advanced it, this updates 0 rows and we back off —
     so no two ticks ever enrich the same candidates, and the cursor can't regress.
     This is the compare-and-swap that makes the job engine concurrency-safe. */
  const claim = await db
    .update(discoveryJobs)
    .set({ processed: start + sliceLen, updatedAt: new Date() })
    .where(and(eq(discoveryJobs.id, jobId), eq(discoveryJobs.status, "enriching"), eq(discoveryJobs.processed, start)))
    .returning({ id: discoveryJobs.id });
  if (claim.length === 0) {
    const fresh = (await db.select({ processed: discoveryJobs.processed, total: discoveryJobs.total }).from(discoveryJobs).where(eq(discoveryJobs.id, jobId)))[0];
    return { done: (fresh?.processed ?? 0) >= (fresh?.total ?? 0), addedDelta: 0, processed: fresh?.processed ?? start, total: fresh?.total ?? job.total };
  }

  // We own [start, start+sliceLen). Enrich + score + insert exactly this slice.
  const profile = (await db.select().from(profiles).where(eq(profiles.accountId, job.accountId)))[0];
  const sender = {
    businessName: profile?.businessName ?? "",
    ownerName: profile?.ownerName ?? "",
    offer: profile?.offer ?? "custom websites and done-for-you marketing",
    businessPhone: profile?.businessPhone ?? "",
  };

  const all = (job.candidates ?? []) as RawCandidate[];
  const slice = all.slice(start, start + sliceLen);

  const scored = await mapPool(slice, POOL, async (c) => {
    const signals = await enrich(c);
    const result = scoreLead(job.vertical, signals);
    const email = (c.email || signals.emailFound || "").trim().toLowerCase();
    const verify = email ? await verifyEmail(email) : null;
    return { c, signals, result, email, verify };
  });

  let addedDelta = 0;
  let qualifiedDelta = 0;
  for (const { c, signals, result, email, verify } of scored) {
    if (result.score < job.minScore) continue;
    qualifiedDelta++;
    const isSupp = email ? await isSuppressed(db, job.accountId, email) : false;
    const draft = buildDraft(
      { businessName: c.businessName, vertical: job.vertical, primaryGap: result.primaryGap, evidence: result.evidence, signals },
      sender
    );
    const inserted = await db
      .insert(leads)
      .values({
        accountId: job.accountId,
        runId: job.runId,
        businessName: c.businessName,
        vertical: job.vertical,
        website: c.website,
        email,
        phone: c.phone,
        address: c.address,
        location: job.location,
        mapsUrl: c.mapsUrl,
        source: c.source,
        signals,
        evidence: result.evidence,
        incomeScore: result.incomeScore,
        needScore: result.needScore,
        score: result.score,
        primaryGap: result.primaryGap,
        draftSubject: draft.subject,
        draftBody: draft.body,
        verifyStatus: verify?.status ?? "unverified",
        verifyScore: verify?.score ?? null,
        verifyProvider: verify?.provider ?? null,
        verifiedAt: verify ? new Date() : null,
        status: isSupp ? "suppressed" : "drafted",
        dedupeKey: dedupeKey(c.website, c.businessName, job.location),
      })
      .onConflictDoNothing()
      .returning({ id: leads.id });
    if (inserted.length) addedDelta++;
  }

  /* Atomic counter increments — disjoint slices, but the counter writes still
     interleave across concurrent ticks, so increment in-DB rather than read-add-write. */
  await db
    .update(discoveryJobs)
    .set({ qualified: sql`${discoveryJobs.qualified} + ${qualifiedDelta}`, added: sql`${discoveryJobs.added} + ${addedDelta}`, updatedAt: new Date() })
    .where(eq(discoveryJobs.id, jobId));
  if (job.runId) {
    await db
      .update(discoveryRuns)
      .set({ qualified: sql`${discoveryRuns.qualified} + ${qualifiedDelta}`, added: sql`${discoveryRuns.added} + ${addedDelta}` })
      .where(eq(discoveryRuns.id, job.runId));
  }

  const newProcessed = start + sliceLen;
  let done = false;
  if (newProcessed >= job.total) {
    // Flip to done exactly once (gated on status), then finalize the run.
    const finished = await db
      .update(discoveryJobs)
      .set({ status: "done", updatedAt: new Date() })
      .where(and(eq(discoveryJobs.id, jobId), eq(discoveryJobs.status, "enriching")))
      .returning({ id: discoveryJobs.id });
    done = true;
    if (finished.length && job.runId) {
      await db.update(discoveryRuns).set({ status: "done", found: job.total }).where(eq(discoveryRuns.id, job.runId));
    }
  }
  return { done, addedDelta, processed: newProcessed, total: job.total };
}

/** Drive job processing for up to `maxBatches` batches (bounds per-invocation
    work so a cron tick or a button click can't run unbounded). Returns progress. */
export async function processJobs(
  db: Db,
  opts: { accountId?: string; maxBatches?: number; batchSize?: number } = {}
): Promise<{ batches: number; added: number; active: number }> {
  const maxBatches = opts.maxBatches ?? 30;
  let batches = 0;
  let added = 0;

  while (batches < maxBatches) {
    const conds = [eq(discoveryJobs.status, "enriching")];
    if (opts.accountId) conds.push(eq(discoveryJobs.accountId, opts.accountId));
    const next = (await db.select({ id: discoveryJobs.id }).from(discoveryJobs).where(and(...conds)).orderBy(asc(discoveryJobs.createdAt)).limit(1))[0];
    if (!next) break;
    const r = await processJobBatch(db, next.id, opts.batchSize ?? BATCH);
    added += r.addedDelta;
    batches++;
  }

  const activeConds = [eq(discoveryJobs.status, "enriching")];
  if (opts.accountId) activeConds.push(eq(discoveryJobs.accountId, opts.accountId));
  const active = (await db.select({ id: discoveryJobs.id }).from(discoveryJobs).where(and(...activeConds))).length;
  return { batches, added, active };
}
