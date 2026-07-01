import type { Evidence, LeadSignals } from "@/db/schema";
import { oneLine } from "@/lib/sending";

/* The draft writer — deterministic, no LLM. Matches the owner's preferred voice:
   a natural, professional cold email that opens with a neutral question, explains
   the cost at the prospect's own moment of need (search → competitor wins), offers
   a soft "there may be an opportunity" bridge, and asks for a quick 10-minute call.
   Audience-first throughout (you/your), no hard self-pitch. The footer/opt-out is
   appended centrally at send time. The owner can edit any draft before sending. */

export type DraftInput = {
  businessName: string;
  vertical: string;
  primaryGap: "web" | "marketing" | "both" | "none";
  evidence: Evidence[];
  signals: LeadSignals | null;
  /** The prospect owner's first name, if known — greets "Hi {name}," when set. */
  contactFirstName?: string | null;
};

export type SenderProfile = {
  businessName: string;
  ownerName: string;
  offer: string;
  businessPhone: string;
};

export function buildDraft(lead: DraftInput, profile: SenderProfile): { subject: string; body: string } {
  const firstName = (profile.ownerName || "").trim().split(/\s+/)[0] || "";

  const gaps = lead.evidence.filter((e) => e.polarity === "gap").sort((a, b) => b.weight - a.weight);
  const top = gaps[0]?.label ?? "";
  const noSite = top === "No website found";
  const parked = top === "Parked / placeholder page";

  const subject = subjectFor(lead.primaryGap, noSite || parked);
  const opener = openerLine(lead.primaryGap, gaps, noSite, parked);
  const cost = costLine(lead.vertical, lead.primaryGap, noSite, parked);
  const greetName = (lead.contactFirstName || "").trim().split(/\s+/)[0];

  const body = [
    greetName ? `Hi ${greetName},` : `Hi,`,
    ``,
    opener,
    ``,
    cost,
    ``,
    `I think there may be an opportunity to help you capture more of those customers.`,
    ``,
    `Would you be open to a quick 10-minute conversation sometime this week?`,
    ``,
    firstName ? `Thanks,\n\n${firstName}` : `Thanks,`,
  ]
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n");

  return { subject: oneLine(subject), body };
}

/* Subject: 2 words, lowercase, looks like it came from a colleague. */
function subjectFor(gap: DraftInput["primaryGap"], noWeb: boolean): string {
  if (noWeb) return "your website";
  switch (gap) {
    case "web":
      return "your site";
    case "marketing":
      return "getting found";
    case "both":
      return "your website";
    default:
      return "your business online";
  }
}

/* Opener — a neutral, easy-to-answer question, second person, no business name. */
function openerLine(gap: DraftInput["primaryGap"], gaps: Evidence[], noSite: boolean, parked: boolean): string {
  if (noSite) return `Quick question—are you intentionally operating without a website, or has it just not made it to the top of your priority list yet?`;
  if (parked) return `Quick question—is the "coming soon" page on your site meant to be there, or has the website been on pause for a while?`;
  if (gaps[0]?.label === "Website won't load") return `Quick question—did you know your website isn't loading right now?`;
  if (gap === "marketing") return `Quick question—when people nearby search for what you do, are you happy with where you turn up?`;

  const phrases = gaps.slice(0, 2).map(gapPhrase).filter(Boolean);
  if (phrases.length) return `Quick question—were you aware that ${joinList(phrases)}?`;
  return `Quick question—are you happy with how your business is showing up online these days?`;
}

/* The cost — explained at the prospect's own moment of need, with the competitor
   winning the job. */
function costLine(vertical: string, gap: DraftInput["primaryGap"], noSite: boolean, parked: boolean): string {
  const moment = searchMoment(vertical);
  if (noSite) {
    return `I only ask because ${moment}. If they can't find you, that call often ends up going to a competitor—even if your service is better.`;
  }
  if (parked) {
    return `I only ask because ${moment}. If all they find is a placeholder page, that call often ends up going to a competitor—even if your service is better.`;
  }
  if (gap === "marketing") {
    return `I only ask because ${moment}. If you're not near the top of those results, those customers usually go to a competitor—even if your service is better.`;
  }
  return `I only ask because ${moment}. When they land on a site that feels dated or hard to use, they often click straight to a competitor—even if your service is better.`;
}

/* The prospect's own moment of need, written as a natural sentence. Keyed by the
   vertical the lead was found under. */
const MOMENTS: Record<string, string> = {
  hvac: `when someone's AC or heating system stops working, the first thing they usually do is search online for a local company`,
  plumbing: `when someone's dealing with a burst pipe or a backed-up drain, the first thing they do is search online for a local plumber`,
  electrical: `when someone runs into an electrical problem, they usually jump online to find a local electrician`,
  roofing: `after a storm or a leak, most people start by searching online for a local roofer`,
  landscaping: `when someone's ready to invest in their yard, they usually start by searching online for a local landscaper`,
  auto_repair: `when someone's car starts acting up, the first thing they do is search online for a local mechanic`,
  dentist: `when someone's dealing with a toothache, they usually search online for a local dentist right away`,
  law_firm: `when someone suddenly needs legal help, the first thing they do is search online for a local attorney`,
  accounting: `when someone needs help with their taxes or books, they usually search online for a local accountant`,
  med_spa: `when someone's considering a treatment, they almost always research local providers online first`,
  veterinary: `when someone's pet gets sick, the first thing they do is search online for a local vet`,
  restaurant: `when someone's deciding where to eat, they almost always look the place up online first`,
  all: `when someone hears about a business, the first thing they usually do is look it up online`,
  generic: `when someone hears about a business, the first thing they usually do is look it up online`,
};

function searchMoment(vertical: string): string {
  return MOMENTS[vertical] ?? MOMENTS.generic;
}

/* Second-person phrasing for a site gap (used only when the site exists). */
function gapPhrase(e: Evidence): string {
  const map: Record<string, string> = {
    "No SSL (http only)": "your site shows up as “not secure” in browsers",
    "Not mobile-friendly": "your site doesn't display right on phones",
    "No contact form": "there's no quick way for a visitor to reach you",
    "No online booking": "there's no way to book or get a quote online",
    "Slow / heavy page": "the site is slow to load",
  };
  if (map[e.label]) return map[e.label];
  if (/^Copyright stuck at/.test(e.label)) return `the footer still says ${e.label.replace(/\D+/g, "")}`;
  if (/^DIY /.test(e.label)) return "the site is on a basic drag-and-drop template";
  return e.label.charAt(0).toLowerCase() + e.label.slice(1);
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
