import { outboxEmails } from "@/db/schema";
import { redactEmails } from "@/lib/crypto";
import type { Db } from "@/lib/db";

export type EmailKind = "magic-link" | "verify" | "outreach" | "reply" | "test";

export type OutgoingEmail = {
  to: string;
  subject: string;
  body: string;
  kind: EmailKind;
  accountId?: string;
  from?: string;
  replyTo?: string;
  /** The owner's own Resend key (decrypted). REQUIRED for outreach/reply/test —
      campaign mail never falls back to the platform key. */
  resendKey?: string;
  /** Extra SMTP headers (e.g. List-Unsubscribe / List-Unsubscribe-Post). These
      are what move bulk mail from spam to inbox under the Gmail/Yahoo 2024 rules,
      so outreach always sets them. */
  headers?: Record<string, string>;
  /** Stored in the outbox instead of `body` — use to keep secrets (e.g. raw
      magic-link tokens) out of the database audit trail. */
  bodyForRecord?: string;
};

export type SendResult = { ok: boolean; sentVia?: "resend" | "dev-outbox"; detail?: string };

const PLATFORM_FROM = () =>
  process.env.PLATFORM_FROM ?? "ScoutNet <onboarding@resend.dev>";

/** Only sign-in and address-confirmation mail may ride the platform domain.
    Outreach goes through the owner's own key + domain or it does not go. */
const TRANSACTIONAL: ReadonlySet<EmailKind> = new Set(["magic-link", "verify"]);

function devTransportEnabled(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.DEV_OUTBOX === "1";
}

/* Every email goes through here. Transactional mail uses the platform Resend key;
   outreach uses the owner's own key only. With no usable key, dev mode lands the
   mail in the outbox table (visible at /dashboard/outbox) so the full product
   loop is testable without any account; production fails honestly. */
export async function sendEmail(db: Db, msg: OutgoingEmail): Promise<SendResult> {
  const key =
    msg.resendKey ?? (TRANSACTIONAL.has(msg.kind) ? process.env.RESEND_API_KEY : undefined);
  const from = msg.from ?? PLATFORM_FROM();

  if (key) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: msg.to,
          subject: msg.subject,
          text: msg.body,
          ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
          ...(msg.headers ? { headers: msg.headers } : {}),
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        const raw = await res.text();
        let detail = raw.slice(0, 300);
        try {
          const j = JSON.parse(raw) as { name?: string; message?: string };
          if (j.message) detail = [j.name, j.message].filter(Boolean).join(" ");
        } catch {
          /* not JSON — keep the raw slice */
        }
        return { ok: false, detail: `Resend ${res.status}: ${redactEmails(detail)}` };
      }
      try {
        await recordOutbox(db, msg, from, "resend");
      } catch (err) {
        /* The email IS sent — losing the audit row must not fail the delivery. */
        console.error("[email] outbox write failed after successful send:", err);
      }
      return { ok: true, sentVia: "resend" };
    } catch (err) {
      return { ok: false, detail: redactEmails(String(err)) };
    }
  }

  if (devTransportEnabled()) {
    /* Here the outbox row IS the delivery — a write failure is a send failure. */
    try {
      await recordOutbox(db, msg, from, "dev-outbox");
    } catch (err) {
      return { ok: false, detail: `dev outbox write failed: ${redactEmails(String(err))}` };
    }
    console.log(`[email dev-outbox] ${msg.kind} → (recipient redacted): ${msg.subject}`);
    return { ok: true, sentVia: "dev-outbox" };
  }

  return {
    ok: false,
    detail: TRANSACTIONAL.has(msg.kind)
      ? "No email transport configured (RESEND_API_KEY unset)"
      : "No sending domain connected — add your Resend key in Settings",
  };
}

async function recordOutbox(
  db: Db,
  msg: OutgoingEmail,
  from: string,
  sentVia: "resend" | "dev-outbox"
): Promise<void> {
  let body = msg.bodyForRecord ?? msg.body;
  /* In dev the outbox row IS the only place to inspect the message, so surface
     the deliverability headers the real send would carry. Real Resend sends keep
     the stored body clean — the headers travel in the API call. */
  if (sentVia === "dev-outbox" && msg.headers && Object.keys(msg.headers).length) {
    const lines = Object.entries(msg.headers).map(([k, v]) => `${k}: ${v}`);
    body = `[headers]\n${lines.join("\n")}\n\n${body}`;
  }
  await db.insert(outboxEmails).values({
    accountId: msg.accountId ?? null,
    toAddr: msg.to,
    fromAddr: from,
    subject: msg.subject,
    body,
    kind: msg.kind,
    sentVia,
  });
}
