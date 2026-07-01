import { eq } from "drizzle-orm";
import type { DiscoveryProvider } from "@/db/schema";
import { discoveryRuns, leads, profiles } from "@/db/schema";
import type { Db } from "@/lib/db";
import { isSuppressed } from "@/lib/suppression";
import { discover } from "@/lib/agent/discovery";
import { enrich } from "@/lib/agent/enrich";
import { scoreLead, dedupeKey } from "@/lib/agent/score";
import { buildDraft } from "@/lib/agent/copywriter";
import { verifyEmail } from "@/lib/verify";

/* One discovery run, end to end: search → enrich each candidate's site → score
   against the rubric → draft a personalised email for the qualified ones →
   dedupe + suppression-check → insert. Bounded concurrency keeps a 25-business
   run from opening 25 sockets at once. Resilient by design: one bad candidate
   degrades to a low score, it never aborts the run. */

export type RunInput = {
  accountId: string;
  provider: DiscoveryProvider;
  vertical: string;
  location: string;
  count: number;
  minScore: number;
  /** Search radius in miles (OSM provider). Defaults to 25. */
  radiusMiles?: number;
};

export type RunSummary = {
  runId: string;
  found: number;
  qualified: number;
  added: number;
  suppressed: number;
  note: string;
};

const CONCURRENCY = 8;

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

export async function runDiscovery(db: Db, input: RunInput): Promise<RunSummary> {
  const profile = (await db.select().from(profiles).where(eq(profiles.accountId, input.accountId)))[0];
  const sender = {
    businessName: profile?.businessName ?? "",
    ownerName: profile?.ownerName ?? "",
    offer: profile?.offer ?? "custom websites and done-for-you marketing",
    businessPhone: profile?.businessPhone ?? "",
  };

  const [run] = await db
    .insert(discoveryRuns)
    .values({
      accountId: input.accountId,
      vertical: input.vertical,
      location: input.location,
      provider: input.provider,
      requested: input.count,
      minScore: input.minScore,
      status: "running",
    })
    .returning({ id: discoveryRuns.id });

  try {
    const { candidates, note } = await discover(input.provider, input.vertical, input.location, input.count, input.radiusMiles ?? 25);

    const scored = await mapPool(candidates, CONCURRENCY, async (c) => {
      const signals = await enrich(c);
      const result = scoreLead(input.vertical, signals);
      /* Verify the email in the same parallel pass so a 25-business run doesn't
         serialize 25 verifier calls. A discovered email that can't be confirmed
         deliverable must never auto-send — it would bounce off the owner's own
         mailbox and burn their reputation. */
      const email = (c.email || signals.emailFound || "").trim().toLowerCase();
      const verify = email ? await verifyEmail(email) : null;
      return { c, signals, result, email, verify };
    });

    let qualified = 0;
    let added = 0;
    let suppressed = 0;

    for (const { c, signals, result, email, verify } of scored) {
      if (result.score < input.minScore) continue;
      qualified++;

      const isSupp = email ? await isSuppressed(db, input.accountId, email) : false;
      if (isSupp) suppressed++;

      const draft = buildDraft(
        { businessName: c.businessName, vertical: input.vertical, primaryGap: result.primaryGap, evidence: result.evidence, signals },
        sender
      );

      const inserted = await db
        .insert(leads)
        .values({
          accountId: input.accountId,
          runId: run.id,
          businessName: c.businessName,
          vertical: input.vertical,
          website: c.website,
          email,
          phone: c.phone,
          address: c.address,
          location: input.location,
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
          dedupeKey: dedupeKey(c.website, c.businessName, input.location),
        })
        .onConflictDoNothing()
        .returning({ id: leads.id });
      if (inserted.length) added++;
    }

    await db
      .update(discoveryRuns)
      .set({ status: "done", found: candidates.length, qualified, added, note })
      .where(eq(discoveryRuns.id, run.id));

    return { runId: run.id, found: candidates.length, qualified, added, suppressed, note };
  } catch (err) {
    await db
      .update(discoveryRuns)
      .set({ status: "failed", note: String(err).slice(0, 200) })
      .where(eq(discoveryRuns.id, run.id));
    throw err;
  }
}
