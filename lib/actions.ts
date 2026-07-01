"use server";

import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { DiscoveryProvider, discoveryJobs, leads, mailboxConnections, profiles } from "@/db/schema";
import { normalizeEmail, requestAddressVerification } from "@/lib/addresses";
import { encryptSecret } from "@/lib/crypto";
import { getSessionAccount } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { checkDomainAuth, domainFromAddress } from "@/lib/deliverability";
import { sendLead, runDispatch, runFollowups, stopSequence } from "@/lib/dispatch";
import { buildDraft } from "@/lib/agent/copywriter";
import { runDiscovery } from "@/lib/agent/pipeline";
import { enqueueDiscovery, processJobs } from "@/lib/agent/jobs";
import { pushAllLeads, setSheetWebhook, sheetConfigured, syncSheetQuietly } from "@/lib/sheets";
import { findOwnerFromWebsite } from "@/lib/owner-finder";
import { applyOwnerPaste, enrichOwners } from "@/lib/agent/owners";
import { suppress } from "@/lib/suppression";
import { isVerticalKey } from "@/lib/verticals";

/* Re-render every auto-drafted (un-edited, not-yet-sent) lead from the current
   sender profile. Called whenever the profile changes so a draft written before
   the owner filled in their name/offer stops reading "I'm me with my studio".
   Hand-edited drafts (draftEdited) are left exactly as the owner wrote them. */
async function regenerateAutoDrafts(db: Awaited<ReturnType<typeof getDb>>, accountId: string) {
  const profile = (await db.select().from(profiles).where(eq(profiles.accountId, accountId)))[0];
  if (!profile) return;
  const rows = await db
    .select()
    .from(leads)
    .where(
      and(
        eq(leads.accountId, accountId),
        eq(leads.draftEdited, false),
        inArray(leads.status, ["discovered", "drafted", "queued"])
      )
    );
  for (const lead of rows) {
    const { subject, body } = buildDraft(lead, profile);
    await db.update(leads).set({ draftSubject: subject, draftBody: body }).where(eq(leads.id, lead.id));
  }
}

/* Server actions — the dashboard's write path. Each re-checks the session
   (never trusts a hidden form field for identity) and revalidates the affected
   route so the UI reflects the change immediately. */

async function requireAccount() {
  const account = await getSessionAccount();
  if (!account) redirect("/signin");
  return account;
}

async function ensureProfile(db: Awaited<ReturnType<typeof getDb>>, accountId: string) {
  const existing = (await db.select().from(profiles).where(eq(profiles.accountId, accountId)))[0];
  if (existing) return existing;
  const [created] = await db.insert(profiles).values({ accountId }).returning();
  return created;
}

const str = (v: FormDataEntryValue | null, max = 300) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/* The origin used to build unsubscribe / verification links that ship inside real
   emails. A spoofed Host header must never end up in those links, so in production
   we ONLY trust the request host when it matches the configured APP_BASE_URL —
   otherwise we return undefined and the caller falls back to baseUrl() (which is
   APP_BASE_URL in prod). In dev, the localhost origin is fine. */
function originFromHeaders(h: Headers): string | undefined {
  const proto = h.get("x-forwarded-proto") ?? "https";
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (!host) return undefined;
  const origin = `${proto}://${host}`;
  if (process.env.NODE_ENV !== "production") return origin;
  try {
    const allowed = process.env.APP_BASE_URL ? new URL(process.env.APP_BASE_URL).host : null;
    if (allowed && new URL(origin).host === allowed) return origin;
  } catch {
    /* malformed APP_BASE_URL or origin — fall through to the trusted base URL */
  }
  return undefined;
}

/* ───────────────────────────── discovery ──────────────────────────────── */

export async function runDiscoveryAction(formData: FormData) {
  const account = await requireAccount();
  const db = await getDb();
  await ensureProfile(db, account.id);

  const verticalRaw = str(formData.get("vertical"), 40);
  const vertical = isVerticalKey(verticalRaw) ? verticalRaw : "generic";
  const location = str(formData.get("location"), 120) || "United States";
  const providerRaw = str(formData.get("provider"), 16);
  const provider: DiscoveryProvider = ["places", "osm", "sample"].includes(providerRaw)
    ? (providerRaw as DiscoveryProvider)
    : "sample";
  const count = clampNum(formData.get("count"), 25, 1, 150);
  const minScore = clampNum(formData.get("minScore"), 50, 0, 100);
  const radiusMiles = clampNum(formData.get("radiusMiles"), 25, 1, 50);

  const summary = await runDiscovery(db, { accountId: account.id, provider, vertical, location, count, minScore, radiusMiles });
  await syncSheetQuietly(db, account.id); // push the fresh list to the live sheet
  revalidatePath("/dashboard/leads");
  revalidatePath("/dashboard");
  redirect(`/dashboard/leads?run=${summary.runId}`);
}

/** Queue a large "unlimited" sweep: stage candidates now, enrich in the
    background. Shares the discover form fields (count is ignored — a job stages
    up to its own cap). */
export async function enqueueDiscoveryAction(formData: FormData) {
  const account = await requireAccount();
  const db = await getDb();
  await ensureProfile(db, account.id);

  const verticalRaw = str(formData.get("vertical"), 40);
  const vertical = isVerticalKey(verticalRaw) ? verticalRaw : "generic";
  const location = str(formData.get("location"), 120) || "United States";
  const providerRaw = str(formData.get("provider"), 16);
  const provider: DiscoveryProvider = ["places", "osm", "sample"].includes(providerRaw)
    ? (providerRaw as DiscoveryProvider)
    : "osm";
  const minScore = clampNum(formData.get("minScore"), 50, 0, 100);
  const radiusMiles = clampNum(formData.get("radiusMiles"), 25, 1, 50);

  await enqueueDiscovery(db, { accountId: account.id, provider, vertical, location, radiusMiles, minScore });
  revalidatePath("/dashboard/discover");
  redirect("/dashboard/discover?job=started");
}

/** Process a few batches of the account's background jobs. Returns progress so an
    in-app poller can keep ticking until the queue drains. Called from the client
    JobRunner and re-used by the cron. */
export async function tickJobsAction(): Promise<{ active: number; added: number }> {
  const account = await requireAccount();
  const db = await getDb();
  const r = await processJobs(db, { accountId: account.id, maxBatches: 3 });
  if (r.active === 0) await syncSheetQuietly(db, account.id); // sweep finished → sync
  revalidatePath("/dashboard/discover");
  revalidatePath("/dashboard/leads");
  return { active: r.active, added: r.added };
}

/** Save (or clear) the Google Sheet webhook URL the owner pasted in Settings. */
export async function saveSheetWebhookAction(formData: FormData) {
  await requireAccount();
  const url = str(formData.get("sheetWebhook"), 400);
  const result = await setSheetWebhook(url);
  revalidatePath("/dashboard/settings");
  if (!result.ok) {
    redirect("/dashboard/settings?sheetError=" + encodeURIComponent(result.error ?? "Could not save."));
  }
  redirect(`/dashboard/settings?sheetSaved=${url ? "1" : "cleared"}`);
}

/** Manual "Sync now" — push the full lead list to the connected sheet. */
export async function syncSheetAction() {
  const account = await requireAccount();
  const db = await getDb();
  if (!(await sheetConfigured())) {
    redirect("/dashboard/settings?sheetError=" + encodeURIComponent("Connect a sheet first."));
  }
  const r = await pushAllLeads(db, account.id);
  revalidatePath("/dashboard/settings");
  if (!r.ok) {
    redirect("/dashboard/settings?sheetError=" + encodeURIComponent(r.detail ?? "Sync failed."));
  }
  redirect(`/dashboard/settings?sheetSynced=${r.count}`);
}

/* ─────────────────────────── lead actions ─────────────────────────────── */

export async function sendLeadAction(formData: FormData) {
  const account = await requireAccount();
  const leadId = str(formData.get("leadId"), 40);
  const db = await getDb();
  const lead = (await db.select().from(leads).where(eq(leads.id, leadId)))[0];
  if (!lead || lead.accountId !== account.id) redirect("/dashboard/leads");

  const origin = originFromHeaders(await headers());
  const { outcome, detail } = await sendLead(db, leadId, "manual", origin);
  revalidatePath(`/dashboard/leads/${leadId}`);
  revalidatePath("/dashboard/leads");
  redirect(`/dashboard/leads/${leadId}?sent=${outcome}${detail ? `&detail=${encodeURIComponent(detail.slice(0, 160))}` : ""}`);
}

export async function saveDraftAction(formData: FormData) {
  const account = await requireAccount();
  const leadId = str(formData.get("leadId"), 40);
  const subject = str(formData.get("subject"), 200);
  const body = str(formData.get("body"), 4000);
  const db = await getDb();
  const lead = (await db.select().from(leads).where(eq(leads.id, leadId)))[0];
  if (!lead || lead.accountId !== account.id) redirect("/dashboard/leads");
  await db.update(leads).set({ draftSubject: subject, draftBody: body, draftEdited: true }).where(eq(leads.id, leadId));
  revalidatePath(`/dashboard/leads/${leadId}`);
  redirect(`/dashboard/leads/${leadId}?saved=1`);
}

/** Save the prospect owner's first name on a lead, and refresh its draft greeting
    ("Hi {name},") — unless the owner has hand-edited that draft. */
export async function setContactNameAction(formData: FormData) {
  const account = await requireAccount();
  const leadId = str(formData.get("leadId"), 40);
  const name = str(formData.get("contactFirstName"), 60);
  const db = await getDb();
  const lead = (await db.select().from(leads).where(eq(leads.id, leadId)))[0];
  if (!lead || lead.accountId !== account.id) redirect("/dashboard/leads");

  await db
    .update(leads)
    .set({
      contactFirstName: name,
      contactSource: "manual",
      contactEvidence: name ? "You entered this name." : "",
      ownerTried: true,
    })
    .where(eq(leads.id, leadId));

  // Re-render the greeting unless the draft was hand-edited.
  if (!lead.draftEdited) {
    const profile = (await db.select().from(profiles).where(eq(profiles.accountId, account.id)))[0];
    if (profile) {
      const { subject, body } = buildDraft({ ...lead, contactFirstName: name }, profile);
      await db.update(leads).set({ draftSubject: subject, draftBody: body }).where(eq(leads.id, leadId));
    }
  }
  revalidatePath(`/dashboard/leads/${leadId}`);
  redirect(`/dashboard/leads/${leadId}?nameSaved=1`);
}

const OWNER_BATCH = 6; // leads attempted per background tick (website fetches are slow)

/** Background owner-finder tick (in-page poller). Attempts the FREE auto-finder on
    a few not-yet-tried leads via the shared `enrichOwners` core, then returns the
    names found + how many remain so the live feed can update. */
export async function tickOwnersAction(): Promise<{
  remaining: number;
  found: { business: string; firstName: string; source: string }[];
}> {
  const account = await requireAccount();
  const db = await getDb();
  const { found, remaining } = await enrichOwners(db, account.id, OWNER_BATCH);
  revalidatePath("/dashboard/leads");
  return { remaining, found };
}

/** Wipe ALL of this account's leads (and, via cascade, their send ledger) plus any
    pending discovery jobs — a clean slate when the list gets messy. Account-scoped
    and irreversible; the dashboard button gates it behind a typed confirm. */
export async function deleteAllLeadsAction() {
  const account = await requireAccount();
  const db = await getDb();
  await db.delete(leads).where(eq(leads.accountId, account.id)); // cascades to leadSends
  await db.delete(discoveryJobs).where(eq(discoveryJobs.accountId, account.id));
  await syncSheetQuietly(db, account.id).catch(() => {});
  revalidatePath("/dashboard/leads");
  revalidatePath("/dashboard");
  redirect("/dashboard/leads?cleared=1");
}

/** Bulk-paste import: one "Business | FirstName | ..." line per lead. Delegates to
    the shared `applyOwnerPaste` matcher, then reports a summary via querystring. */
export async function bulkSetOwnersAction(formData: FormData) {
  const account = await requireAccount();
  const raw = str(formData.get("paste"), 40000);
  const db = await getDb();
  const { matched, unmatched } = await applyOwnerPaste(db, account.id, raw);
  revalidatePath("/dashboard/leads");
  redirect(`/dashboard/leads?owners=${matched}_${unmatched}`);
}

/** Best-effort: try to find the owner's name on the lead's own website. Pre-fills
    a suggestion for the owner to confirm — never saves silently (low confidence). */
export async function findOwnerAction(formData: FormData) {
  const account = await requireAccount();
  const leadId = str(formData.get("leadId"), 40);
  const db = await getDb();
  const lead = (await db.select().from(leads).where(eq(leads.id, leadId)))[0];
  if (!lead || lead.accountId !== account.id) redirect("/dashboard/leads");
  if (!lead.website.trim()) redirect(`/dashboard/leads/${leadId}?ownerSuggest=nosite`);
  const guess = await findOwnerFromWebsite(lead.website, lead.businessName);
  redirect(`/dashboard/leads/${leadId}?ownerSuggest=${guess ? encodeURIComponent(guess.firstName) : "none"}`);
}

export async function skipLeadAction(formData: FormData) {
  const account = await requireAccount();
  const leadId = str(formData.get("leadId"), 40);
  const db = await getDb();
  const lead = (await db.select().from(leads).where(eq(leads.id, leadId)))[0];
  if (!lead || lead.accountId !== account.id) redirect("/dashboard/leads");
  await db.update(leads).set({ status: "skipped" }).where(eq(leads.id, leadId));
  revalidatePath("/dashboard/leads");
  redirect("/dashboard/leads");
}

export async function suppressLeadAction(formData: FormData) {
  const account = await requireAccount();
  const leadId = str(formData.get("leadId"), 40);
  const db = await getDb();
  const lead = (await db.select().from(leads).where(eq(leads.id, leadId)))[0];
  if (!lead || lead.accountId !== account.id) redirect("/dashboard/leads");
  if (lead.email) await suppress(db, account.id, lead.email, "manually suppressed");
  await db.update(leads).set({ status: "suppressed" }).where(eq(leads.id, leadId));
  revalidatePath("/dashboard/leads");
  redirect("/dashboard/leads");
}

/** Manual "run the send pass now" — the hybrid opener auto-send AND any due
    follow-ups, account-scoped. */
export async function runDispatchAction() {
  const account = await requireAccount();
  const db = await getDb();
  const origin = originFromHeaders(await headers());
  const opener = await runDispatch(db, { accountId: account.id, origin });
  const follow = await runFollowups(db, { accountId: account.id, origin });
  revalidatePath("/dashboard/leads");
  revalidatePath("/dashboard");
  redirect(`/dashboard/leads?dispatched=${opener.sent}&followups=${follow.sent}`);
}

/** Stop a thread because the prospect engaged (or the owner decided). Halts any
    pending follow-up. */
export async function markLeadAction(formData: FormData) {
  const account = await requireAccount();
  const leadId = str(formData.get("leadId"), 40);
  const statusRaw = str(formData.get("status"), 12);
  const status = (["replied", "won", "lost"] as const).find((s) => s === statusRaw);
  if (!status) redirect("/dashboard/leads");
  const db = await getDb();
  const lead = (await db.select().from(leads).where(eq(leads.id, leadId)))[0];
  if (!lead || lead.accountId !== account.id) redirect("/dashboard/leads");
  await stopSequence(db, account.id, leadId, status);
  revalidatePath(`/dashboard/leads/${leadId}`);
  revalidatePath("/dashboard/leads");
  redirect(`/dashboard/leads/${leadId}?marked=${status}`);
}

/* ─────────────────────────── settings ─────────────────────────────────── */

export async function updateProfile(formData: FormData) {
  const account = await requireAccount();
  const db = await getDb();
  await ensureProfile(db, account.id);
  await db
    .update(profiles)
    .set({
      businessName: str(formData.get("businessName"), 120),
      ownerName: str(formData.get("ownerName"), 120),
      businessPhone: str(formData.get("businessPhone"), 30),
      businessAddress: str(formData.get("businessAddress"), 300),
      website: str(formData.get("website"), 300),
      offer: str(formData.get("offer"), 160) || "custom websites and done-for-you marketing",
      accent: str(formData.get("accent"), 9) || "#0369a1",
    })
    .where(eq(profiles.accountId, account.id));
  /* The name/offer/phone here all appear in drafts — refresh the un-edited ones. */
  await regenerateAutoDrafts(db, account.id);
  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard/leads");
  redirect("/dashboard/settings?saved=1");
}

export async function updateSending(formData: FormData) {
  const account = await requireAccount();
  const db = await getDb();
  await ensureProfile(db, account.id);

  const fromAddr = str(formData.get("fromAddr"), 200);
  const replyTo = str(formData.get("replyTo"), 200);
  const dailyCap = clampNum(formData.get("dailyCap"), 25, 1, 200);
  const autoSendThreshold = clampNum(formData.get("autoSendThreshold"), 80, 0, 100);
  const clearKey = formData.get("clearKey") === "1";
  const rawKey = str(formData.get("resendKey"), 200);
  const followupsEnabled = formData.get("followupsEnabled") === "1";

  const patch: Record<string, unknown> = { fromAddr, replyTo, dailyCap, autoSendThreshold, followupsEnabled };
  if (clearKey) patch.resendKeyEnc = null;
  else if (rawKey) patch.resendKeyEnc = encryptSecret(rawKey);

  await db.update(profiles).set(patch).where(eq(profiles.accountId, account.id));
  revalidatePath("/dashboard/settings");
  redirect("/dashboard/settings?saved=1");
}

export async function runDeliverabilityCheck() {
  const account = await requireAccount();
  const db = await getDb();
  const profile = (await db.select().from(profiles).where(eq(profiles.accountId, account.id)))[0];
  if (!profile || !profile.fromAddr.trim() || !domainFromAddress(profile.fromAddr)) {
    redirect("/dashboard/settings?authError=" + encodeURIComponent("Add a valid from address on your own domain first."));
  }
  const result = await checkDomainAuth(profile!.fromAddr);
  if ("error" in result) {
    redirect("/dashboard/settings?authError=" + encodeURIComponent(result.error.slice(0, 160)));
  }
  await db.update(profiles).set({ authCheck: result }).where(eq(profiles.accountId, account.id));
  revalidatePath("/dashboard/settings");
  redirect("/dashboard/settings?authChecked=1");
}

export async function addVerifyAddress(formData: FormData) {
  const account = await requireAccount();
  const email = normalizeEmail(str(formData.get("email"), 200));
  const origin = originFromHeaders(await headers()) ?? "http://localhost:3000";
  const db = await getDb();
  const result = await requestAddressVerification(db, account.id, email, origin);
  revalidatePath("/dashboard/settings");
  if (!result.ok) {
    redirect("/dashboard/settings?verifyError=" + encodeURIComponent(result.error ?? "Could not send confirmation."));
  }
  redirect(`/dashboard/settings?verifySent=1${result.devLink ? `&devLink=${encodeURIComponent(result.devLink)}` : ""}`);
}

/* --- connected mailbox ------------------------------------------------- */

/** Dev-only: connect a "mock" mailbox so the connect→send→reply loop is testable
    with no Google app. Outreach routes through it to the in-app outbox, and the
    "Simulate a reply" button stands in for Gmail's reply auto-detection. */
export async function connectMockMailbox() {
  const account = await requireAccount();
  if (process.env.NODE_ENV === "production") redirect("/dashboard/settings?mailboxError=dev-only");
  const db = await getDb();
  await db
    .insert(mailboxConnections)
    .values({ accountId: account.id, provider: "mock", email: account.email, status: "connected" })
    .onConflictDoUpdate({
      target: [mailboxConnections.accountId, mailboxConnections.email],
      set: { status: "connected", provider: "mock" },
    });
  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard/leads");
  redirect("/dashboard/settings?connected=1");
}

export async function disconnectMailbox(formData: FormData) {
  const account = await requireAccount();
  const id = str(formData.get("mailboxId"), 40);
  const db = await getDb();
  await db.delete(mailboxConnections).where(and(eq(mailboxConnections.id, id), eq(mailboxConnections.accountId, account.id)));
  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard/leads");
  redirect("/dashboard/settings?disconnected=1");
}

/** Dev-only stand-in for Gmail reply auto-detection: mark a sent lead as having
    replied, which stops its sequence — exactly what pollReplies() does in prod. */
export async function simulateReplyAction(formData: FormData) {
  const account = await requireAccount();
  if (process.env.NODE_ENV === "production") redirect("/dashboard/leads");
  const leadId = str(formData.get("leadId"), 40);
  const db = await getDb();
  const lead = (await db.select().from(leads).where(eq(leads.id, leadId)))[0];
  if (!lead || lead.accountId !== account.id) redirect("/dashboard/leads");
  if (lead.status === "sent") await stopSequence(db, account.id, leadId, "replied");
  revalidatePath(`/dashboard/leads/${leadId}`);
  revalidatePath("/dashboard/leads");
  redirect(`/dashboard/leads/${leadId}?replied=1`);
}

/* --- helpers ----------------------------------------------------------- */

function clampNum(v: FormDataEntryValue | null, fallback: number, min: number, max: number): number {
  const n = Number(typeof v === "string" ? v : NaN);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}
