import { and, asc, desc, eq, gte, lte, ne } from "drizzle-orm";
import { leads, leadSends, mailboxConnections, profiles } from "@/db/schema";
import { verifiedOrFallback } from "@/lib/addresses";
import type { Db } from "@/lib/db";
import { sendEmail } from "@/lib/email";
import {
  accountEmail,
  accountSendStatus,
  baseUrl,
  devTransport,
  effectiveDailyCap,
  oneLine,
  ownKey,
  sendsInLastDay,
  withFooter,
} from "@/lib/sending";
import { getActiveMailbox, getFreshAccessToken, sendViaMailbox } from "@/lib/mailbox";
import { gmailListReplies } from "@/lib/mailbox/gmail";
import { isSuppressed, unsubToken } from "@/lib/suppression";
import { buildFollowup, followupDueAt, FOLLOWUP_STEPS } from "@/lib/agent/followups";

type LeadRow = typeof leads.$inferSelect;
type ProfileRow = typeof profiles.$inferSelect;

export type SendOutcome =
  | "sent"
  | "capped"
  | "not-ready"
  | "no-email"
  | "bad-email"
  | "suppressed"
  | "already-sent"
  | "bad-status"
  | "failed";

/* Send the next due email in a lead's thread — the opener (step 0) or a follow-up
   (step 1+). Idempotent and concurrency-safe: a unique row on
   lead_sends(leadId, ordinal) makes any single step un-sendable twice. We CLAIM
   the row before sending and RELEASE it on failure, so a transient error can be
   retried; a success leaves a permanent ledger row that also feeds the daily cap.
   On success the next follow-up is scheduled (or the thread is closed). */
export async function sendLead(
  db: Db,
  leadId: string,
  mode: "auto" | "manual",
  origin?: string
): Promise<{ outcome: SendOutcome; detail?: string }> {
  const lead = (await db.select().from(leads).where(eq(leads.id, leadId)))[0];
  if (!lead) return { outcome: "bad-status", detail: "lead not found" };

  const ordinal = lead.step;
  // Opener may only fire from the review states; follow-ups only from "sent".
  const openerOk = ordinal === 0 && (lead.status === "drafted" || lead.status === "queued");
  const followupOk = ordinal >= 1 && ordinal <= FOLLOWUP_STEPS && lead.status === "sent";
  if (!openerOk && !followupOk) {
    return { outcome: lead.status === "sent" && ordinal > FOLLOWUP_STEPS ? "already-sent" : "bad-status" };
  }

  const email = lead.email.trim().toLowerCase();
  if (!email) return { outcome: "no-email" };

  /* Never send to an address verification flagged as undeliverable — a hard
     bounce off the owner's own mailbox damages their sending reputation. (Auto
     openers are pre-filtered to "valid" in runDispatch; this guards manual sends
     and any stale row.) "accept_all"/"unknown" are allowed through for the
     human-reviewed manual path but never auto-sent. */
  if (lead.verifyStatus === "invalid" || lead.verifyStatus === "disposable") {
    return { outcome: "bad-email", detail: `email verified ${lead.verifyStatus}` };
  }

  const profile = (await db.select().from(profiles).where(eq(profiles.accountId, lead.accountId)))[0];
  const status = await accountSendStatus(db, profile);
  if (!status.ok || !profile) return { outcome: "not-ready", detail: status.missing.join(", ") };

  if (await isSuppressed(db, lead.accountId, email)) {
    await db.update(leads).set({ status: "suppressed", nextFollowupAt: null }).where(eq(leads.id, lead.id));
    return { outcome: "suppressed" };
  }

  // Reputation guard — enforced here, not just in the UI, for every step.
  if ((await sendsInLastDay(db, lead.accountId)) >= effectiveDailyCap(profile)) {
    return { outcome: "capped" };
  }

  // Claim this step's send slot.
  const claim = await db
    .insert(leadSends)
    .values({ leadId: lead.id, accountId: lead.accountId, ordinal, mode, ok: false })
    .onConflictDoNothing()
    .returning({ id: leadSends.id });
  if (claim.length === 0) {
    // This step already went out — advance the pointer and stand down.
    await db.update(leads).set({ step: ordinal + 1 }).where(and(eq(leads.id, lead.id), eq(leads.step, ordinal)));
    return { outcome: "already-sent" };
  }

  const acctEmail = await accountEmail(db, lead.accountId);
  const replyTo = await verifiedOrFallback(db, lead.accountId, profile.replyTo, acctEmail);
  const unsubUrl = `${origin ?? baseUrl()}/unsubscribe?token=${unsubToken(lead.accountId, email)}`;

  // Opener uses the reviewed draft; follow-ups are generated for the step.
  const content =
    ordinal === 0
      ? { subject: lead.draftSubject || `A quick note about ${lead.businessName}`, body: lead.draftBody }
      : buildFollowup(
          { businessName: lead.businessName, primaryGap: lead.primaryGap },
          { businessName: profile.businessName, ownerName: profile.ownerName, businessPhone: profile.businessPhone },
          ordinal
        );

  const subject = oneLine(content.subject);
  const body = withFooter(content.body, profile, unsubUrl);
  const headers = {
    "List-Unsubscribe": `<${unsubUrl}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };

  /* Two channels, one envelope. A connected mailbox (Gmail) sends from the
     owner's real inbox — best cold deliverability and the thread id lets us
     auto-detect replies; otherwise fall back to Resend + own domain. */
  let ok = false;
  let detail: string | undefined;
  let sentVia = "";
  let threadId: string | undefined;

  if (status.via === "mailbox") {
    const mailbox = await getActiveMailbox(db, lead.accountId);
    if (!mailbox) {
      await releaseClaim(db, lead.id, ordinal);
      return { outcome: "not-ready", detail: "no connected mailbox" };
    }
    const fromName = (profile.ownerName || profile.businessName || "").replace(/["<>\r\n]/g, "").trim();
    const from = fromName ? `${fromName} <${mailbox.email}>` : mailbox.email;
    const r = await sendViaMailbox(db, mailbox, { from, to: lead.email, subject, body, replyTo, headers });
    ok = r.ok;
    detail = r.detail;
    threadId = r.threadId;
    sentVia = `mailbox:${mailbox.provider}`;
  } else {
    const key = ownKey(profile);
    if (!key && !devTransport()) {
      await releaseClaim(db, lead.id, ordinal);
      return { outcome: "not-ready", detail: "sender key missing or could not be decrypted" };
    }
    const r = await sendEmail(db, {
      to: lead.email,
      subject,
      body,
      kind: "outreach",
      accountId: lead.accountId,
      resendKey: key,
      from: profile.fromAddr,
      replyTo,
      headers,
    });
    ok = r.ok;
    detail = r.detail;
    sentVia = r.sentVia ?? "";
  }

  if (!ok) {
    await releaseClaim(db, lead.id, ordinal);
    return { outcome: "failed", detail };
  }

  await db.update(leadSends).set({ ok: true, detail: sentVia || null }).where(and(eq(leadSends.leadId, lead.id), eq(leadSends.ordinal, ordinal)));

  // Advance the thread: schedule the next follow-up, or close it out.
  const nextAt = profile.followupsEnabled ? followupDueAt(ordinal) : null;
  await db
    .update(leads)
    .set({
      step: ordinal + 1,
      status: "sent",
      lastTouchAt: new Date(),
      nextFollowupAt: nextAt,
      // Remember the thread so an inbound reply on it auto-stops the sequence.
      ...(threadId && ordinal === 0 ? { providerThreadId: threadId } : {}),
    })
    .where(eq(leads.id, lead.id));

  // Start the warm-up clock on the very first send that goes out.
  if (!profile.warmupStartedAt) {
    await db.update(profiles).set({ warmupStartedAt: new Date() }).where(eq(profiles.accountId, lead.accountId));
  }

  return { outcome: "sent" };
}

async function releaseClaim(db: Db, leadId: string, ordinal: number): Promise<void> {
  try {
    await db.delete(leadSends).where(and(eq(leadSends.leadId, leadId), eq(leadSends.ordinal, ordinal), eq(leadSends.ok, false)));
  } catch (err) {
    console.error(`[dispatch] failed to release claim for lead ${leadId} step ${ordinal}:`, err);
  }
}

/* The HYBRID opener pass. Only leads scoring at or above the account's
   autoSendThreshold are eligible — everything below stays in the review queue.
   Respects the daily cap per account. This is what the cron calls first. */
export async function runDispatch(
  db: Db,
  opts: { accountId?: string; origin?: string } = {}
): Promise<{ accounts: number; sent: number; capped: number; held: number }> {
  const profileRows = opts.accountId
    ? await db.select().from(profiles).where(eq(profiles.accountId, opts.accountId))
    : await db.select().from(profiles);

  let totalSent = 0;
  let totalCapped = 0;
  let totalHeld = 0;
  let accountsTouched = 0;

  for (const profile of profileRows as ProfileRow[]) {
    if (!(await accountSendStatus(db, profile)).ok) continue;
    let remaining = effectiveDailyCap(profile) - (await sendsInLastDay(db, profile.accountId));
    if (remaining <= 0) {
      totalCapped++;
      continue;
    }

    /* Auto-send only addresses verification confirmed deliverable ("valid").
       Catch-all / unknown / unverified leads stay in the review queue for a
       human — they never auto-fire and risk the owner's mailbox reputation. */
    const eligible = await db
      .select({ id: leads.id })
      .from(leads)
      .where(
        and(
          eq(leads.accountId, profile.accountId),
          eq(leads.status, "drafted"),
          ne(leads.email, ""),
          eq(leads.verifyStatus, "valid"),
          gte(leads.score, profile.autoSendThreshold)
        )
      )
      .orderBy(desc(leads.score))
      .limit(remaining);
    if (eligible.length === 0) continue;
    accountsTouched++;

    for (const { id } of eligible) {
      if (remaining <= 0) break;
      const { outcome } = await sendLead(db, id, "auto", opts.origin);
      if (outcome === "sent") {
        totalSent++;
        remaining--;
      } else if (outcome === "capped") {
        totalCapped++;
        break;
      } else {
        totalHeld++;
      }
    }
  }

  return { accounts: accountsTouched, sent: totalSent, capped: totalCapped, held: totalHeld };
}

/* The FOLLOW-UP pass. Sends the next due step for sent-but-silent leads (one step
   per lead per run, so a backlog never blasts a whole thread at once). A reply or
   opt-out flips the lead off "sent", which removes it here automatically. */
export async function runFollowups(
  db: Db,
  opts: { accountId?: string; origin?: string } = {}
): Promise<{ sent: number; capped: number }> {
  const profileRows = opts.accountId
    ? await db.select().from(profiles).where(eq(profiles.accountId, opts.accountId))
    : await db.select().from(profiles);

  let sent = 0;
  let capped = 0;

  for (const profile of profileRows as ProfileRow[]) {
    if (!profile.followupsEnabled || !(await accountSendStatus(db, profile)).ok) continue;
    let remaining = effectiveDailyCap(profile) - (await sendsInLastDay(db, profile.accountId));
    if (remaining <= 0) {
      capped++;
      continue;
    }

    const due = await db
      .select({ id: leads.id })
      .from(leads)
      .where(
        and(
          eq(leads.accountId, profile.accountId),
          eq(leads.status, "sent"),
          ne(leads.email, ""),
          gte(leads.step, 1),
          lte(leads.step, FOLLOWUP_STEPS),
          lte(leads.nextFollowupAt, new Date())
        )
      )
      .orderBy(asc(leads.nextFollowupAt))
      .limit(remaining);

    for (const { id } of due) {
      if (remaining <= 0) break;
      const { outcome } = await sendLead(db, id, "auto", opts.origin);
      if (outcome === "sent") {
        sent++;
        remaining--;
      } else if (outcome === "capped") {
        capped++;
        break;
      }
    }
  }

  return { sent, capped };
}

/** Stop a thread because the prospect engaged (or the owner decided). Clears any
    pending follow-up so nothing else goes out. */
export async function stopSequence(
  db: Db,
  accountId: string,
  leadId: string,
  status: "replied" | "won" | "lost"
): Promise<void> {
  await db
    .update(leads)
    .set({ status, nextFollowupAt: null })
    .where(and(eq(leads.id, leadId), eq(leads.accountId, accountId)));
}

/* The REPLY-DETECTION pass. For each connected Gmail mailbox, read recent inbox
   metadata (headers only — gmail.metadata scope, never the body, so no CASA), and
   if a message lands on a thread we sent, flip that lead to "replied" and stop the
   sequence. A real human reply is the strongest signal there is, and auto-stopping
   means the owner never accidentally follows up on someone who already answered.
   Mock mailboxes are skipped here — their replies are simulated from the UI. */
export async function pollReplies(
  db: Db,
  opts: { accountId?: string } = {}
): Promise<{ mailboxes: number; replied: number }> {
  const conns = await db
    .select()
    .from(mailboxConnections)
    .where(
      opts.accountId
        ? and(eq(mailboxConnections.status, "connected"), eq(mailboxConnections.accountId, opts.accountId))
        : eq(mailboxConnections.status, "connected")
    );

  let mailboxes = 0;
  let replied = 0;

  for (const conn of conns) {
    if (conn.provider !== "gmail") continue; // mock replies come from the dev "simulate reply" action
    const token = await getFreshAccessToken(db, conn);
    if (!token) continue;
    mailboxes++;

    let signals;
    try {
      signals = await gmailListReplies(token);
    } catch (err) {
      console.error(`[dispatch] reply poll failed for mailbox ${conn.id}:`, err);
      continue;
    }

    for (const sig of signals) {
      const matched = (
        await db
          .select({ id: leads.id })
          .from(leads)
          .where(
            and(
              eq(leads.accountId, conn.accountId),
              eq(leads.providerThreadId, sig.threadId),
              eq(leads.status, "sent")
            )
          )
      )[0];
      if (matched) {
        await stopSequence(db, conn.accountId, matched.id, "replied");
        replied++;
      }
    }

    await db.update(mailboxConnections).set({ lastPolledAt: new Date() }).where(eq(mailboxConnections.id, conn.id));
  }

  return { mailboxes, replied };
}
