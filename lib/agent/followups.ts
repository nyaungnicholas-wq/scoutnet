import { oneLine } from "@/lib/sending";

/* The follow-up sequence. After the opener (ordinal 0), a lead that hasn't
   replied gets a gentle bump (ordinal 1) and then a final note (ordinal 2), after
   which the thread closes itself. Deterministic copy, no LLM — and like the
   opener, every email ends with a real, easy out.

   Cadence: in production the bumps are days apart (a fresh domain that fires three
   emails in a minute looks like spam). In dev the delays are zero so the whole
   thread is testable against the outbox in one sitting. */

export const FOLLOWUP_STEPS = 2; // follow-ups after the opener (total emails = 3)

const DAY = 1440; // minutes

function delaysMinutes(): number[] {
  // Index by the ordinal just sent: [after opener → bump, after bump → final].
  if (process.env.NODE_ENV === "production") return [3 * DAY, 5 * DAY];
  return [0, 0];
}

/** When the next step is due after sending `ordinalJustSent`, or null when the
    sequence is complete (the final note just went out). */
export function followupDueAt(ordinalJustSent: number, now: Date = new Date()): Date | null {
  if (ordinalJustSent >= FOLLOWUP_STEPS) return null;
  return new Date(now.getTime() + delaysMinutes()[ordinalJustSent] * 60_000);
}

export type FollowupLead = {
  businessName: string;
  primaryGap: "web" | "marketing" | "both" | "none";
};

export type FollowupSender = {
  businessName: string;
  ownerName: string;
  businessPhone: string;
};

/** Compose the email for a given follow-up ordinal (1 = bump, 2 = final note).
    Same lean, audience-first voice as the opener — short, no self-pitch (the
    owner pitches live), first-name sign-off, threaded subject. */
export function buildFollowup(lead: FollowupLead, profile: FollowupSender, ordinal: number): { subject: string; body: string } {
  const me = (profile.ownerName || "").trim().split(/\s+/)[0] || "";
  const sign = me ? `Thanks,\n\n${me}` : `Thanks,`;

  if (ordinal >= FOLLOWUP_STEPS) {
    // Final note — the honest breakup. No guilt, a clean close.
    return {
      subject: oneLine(`Re: ${threadSubject(lead)}`),
      body: [
        `Hi,`,
        ``,
        `I'll keep this short and leave you to it — if getting found online ever moves up your list, just reply and I'd be glad to help.`,
        ``,
        `Either way, wishing you continued success.`,
        ``,
        sign,
      ].join("\n"),
    };
  }

  // Bump — resurface the question professionally, no pressure.
  return {
    subject: oneLine(`Re: ${threadSubject(lead)}`),
    body: [
      `Hi,`,
      ``,
      `Just wanted to float this back up in case it got buried — no problem at all if now isn't the right time.`,
      ``,
      `Would a quick 10-minute conversation this week be worth it?`,
      ``,
      sign,
    ].join("\n"),
  };
}

/* Mirror the opener's 2-word subjects so the follow-up threads cleanly. */
function threadSubject(lead: FollowupLead): string {
  switch (lead.primaryGap) {
    case "web":
      return "your site";
    case "both":
      return "your website";
    case "marketing":
      return "getting found";
    default:
      return "your business online";
  }
}
