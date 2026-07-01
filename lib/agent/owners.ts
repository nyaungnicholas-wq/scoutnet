import { and, eq, inArray } from "drizzle-orm";
import { leads, profiles } from "@/db/schema";
import type { Db } from "@/lib/db";
import { buildDraft } from "@/lib/agent/copywriter";
import { autoFindOwner } from "@/lib/owner-finder";
import { syncSheetQuietly } from "@/lib/sheets";

/* Shared owner-enrichment core, used by BOTH the in-page poller (tickOwnersAction,
   per-account, live) and the cron worker (processOwnersCron, all accounts, 24/7).
   Attempts the FREE auto-finder on not-yet-tried active leads, sets the name +
   source, regenerates the un-edited draft so the greeting personalizes, and marks
   each lead tried so the worker always advances and never re-scrapes endlessly. */

export const OWNER_ACTIVE = ["discovered", "drafted", "queued"] as const;
type ActiveStatus = (typeof leads.status.enumValues)[number];

export type OwnerHit = { business: string; firstName: string; source: string; evidence?: string };

const pendingWhere = (accountId: string) =>
  and(
    eq(leads.accountId, accountId),
    eq(leads.ownerTried, false),
    eq(leads.contactFirstName, ""),
    inArray(leads.status, OWNER_ACTIVE as unknown as ActiveStatus[])
  );

/** Enrich up to `limit` pending leads for one account. Returns the names found and
    how many still remain. Syncs the Google Sheet when anything changed. */
export async function enrichOwners(
  db: Db,
  accountId: string,
  limit: number
): Promise<{ found: OwnerHit[]; attempted: number; remaining: number }> {
  const profile = (await db.select().from(profiles).where(eq(profiles.accountId, accountId)))[0];
  const pending = await db.select().from(leads).where(pendingWhere(accountId)).limit(limit);

  const found: OwnerHit[] = [];
  for (const lead of pending) {
    const guess = await autoFindOwner(lead);
    const patch: Record<string, unknown> = { ownerTried: true };
    if (guess) {
      patch.contactFirstName = guess.firstName;
      patch.contactSource = guess.source;
      patch.contactEvidence = guess.evidence ?? "";
      if (profile && !lead.draftEdited) {
        const { subject, body } = buildDraft({ ...lead, contactFirstName: guess.firstName }, profile);
        patch.draftSubject = subject;
        patch.draftBody = body;
      }
      found.push({
        business: lead.businessName,
        firstName: guess.firstName,
        source: guess.source,
        evidence: guess.evidence,
      });
    }
    await db.update(leads).set(patch).where(eq(leads.id, lead.id));
  }

  if (found.length) await syncSheetQuietly(db, accountId).catch(() => {});

  const remaining = await db.$count(leads, pendingWhere(accountId));
  return { found, attempted: pending.length, remaining };
}

/* Normalize a business name for fuzzy matching: lowercase, drop punctuation,
   common suffixes, collapse whitespace. */
function normBiz(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.,'’&]/g, " ")
    .replace(/\b(inc|llc|ltd|co|corp|dds|dmd|d\.?d\.?s|the|and)\b/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Apply a pasted "Business | FirstName | …" list to an account's leads: fuzzy-match
    each line to a lead by business name, set the owner (source "bulk"), and
    regenerate the un-edited draft so the greeting personalizes. Skips blanks, "?",
    "SKIP". Returns match counts. Shared by the form action and the import API. */
export async function applyOwnerPaste(
  db: Db,
  accountId: string,
  raw: string
): Promise<{ matched: number; unmatched: number }> {
  const rows = await db.select().from(leads).where(eq(leads.accountId, accountId));
  const profile = (await db.select().from(profiles).where(eq(profiles.accountId, accountId)))[0];
  const byNorm = new Map<string, (typeof rows)[number]>();
  for (const l of rows) byNorm.set(normBiz(l.businessName), l);

  let matched = 0;
  let unmatched = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split("|").map((p) => p.trim());
    if (parts.length < 2) continue;
    const bizN = normBiz(parts[0]);
    const first = (parts[1] || "").split(/\s+/)[0].replace(/[^A-Za-z'’.-]/g, "");
    if (!bizN || !first) continue;
    if (/^(skip|none|\?|n\/?a)$/i.test(first) || first.length < 2) continue;

    let lead = byNorm.get(bizN);
    if (!lead) lead = rows.find((l) => {
      const n = normBiz(l.businessName);
      return n.includes(bizN) || bizN.includes(n);
    });
    if (!lead) {
      unmatched++;
      continue;
    }
    await db
      .update(leads)
      .set({ contactFirstName: first, contactSource: "bulk", contactEvidence: "Added from your imported list.", ownerTried: true })
      .where(eq(leads.id, lead.id));
    if (profile && !lead.draftEdited) {
      const { subject, body } = buildDraft({ ...lead, contactFirstName: first }, profile);
      await db.update(leads).set({ draftSubject: subject, draftBody: body }).where(eq(leads.id, lead.id));
    }
    matched++;
  }
  if (matched) await syncSheetQuietly(db, accountId).catch(() => {});
  return { matched, unmatched };
}

/** Self-healing scrub: clear any owner name set by the now-distrusted auto website
    scrape (`contactSource='website'`) and regenerate its un-edited draft back to a
    neutral "Hi,". Runs cheaply each cron pass; a no-op once drained. */
export async function scrubWebsiteOwners(db: Db): Promise<number> {
  const bad = await db.select().from(leads).where(eq(leads.contactSource, "website"));
  if (!bad.length) return 0;
  const profiles_ = new Map<string, typeof profiles.$inferSelect | undefined>();
  for (const lead of bad) {
    if (!profiles_.has(lead.accountId)) {
      profiles_.set(
        lead.accountId,
        (await db.select().from(profiles).where(eq(profiles.accountId, lead.accountId)))[0]
      );
    }
    const profile = profiles_.get(lead.accountId);
    const patch: Record<string, unknown> = { contactFirstName: "", contactSource: "", contactEvidence: "" };
    if (profile && !lead.draftEdited) {
      const { subject, body } = buildDraft({ ...lead, contactFirstName: "" }, profile);
      patch.draftSubject = subject;
      patch.draftBody = body;
    }
    await db.update(leads).set(patch).where(eq(leads.id, lead.id));
  }
  return bad.length;
}

/** Cron entry: drain pending owners across ALL accounts, bounded so a single
    invocation stays short (website fetches are slow). */
export async function processOwnersCron(
  db: Db,
  opts: { maxLeads?: number } = {}
): Promise<{ attempted: number; found: number; scrubbed: number }> {
  const scrubbed = await scrubWebsiteOwners(db);
  const budget = opts.maxLeads ?? 12;
  const accountIds = await db
    .selectDistinct({ id: leads.accountId })
    .from(leads)
    .where(
      and(
        eq(leads.ownerTried, false),
        eq(leads.contactFirstName, ""),
        inArray(leads.status, OWNER_ACTIVE as unknown as ActiveStatus[])
      )
    );

  let attempted = 0;
  let found = 0;
  for (const { id } of accountIds) {
    if (attempted >= budget) break;
    const r = await enrichOwners(db, id, budget - attempted);
    attempted += r.attempted;
    found += r.found.length;
  }
  return { attempted, found, scrubbed };
}
