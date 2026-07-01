import type { Evidence, LeadSignals } from "@/db/schema";
import { Badge } from "@/components/ui";

/* Small presentational helpers shared across the Leads screens. Server-component
   friendly — pure functions of their props, no client state. */

export function scoreTone(score: number): "emerald" | "sky" | "amber" | "slate" {
  if (score >= 80) return "emerald";
  if (score >= 60) return "sky";
  if (score >= 40) return "amber";
  return "slate";
}

export function ScoreBadge({ score }: { score: number }) {
  const tone = scoreTone(score);
  const ring =
    tone === "emerald"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
      : tone === "sky"
        ? "border-sky-200 bg-sky-50 text-sky-900"
        : tone === "amber"
          ? "border-accent-100 bg-accent-50 text-accent-600"
          : "border-slate-200 bg-slate-50 text-slate-600";
  return (
    <span className={`inline-grid h-12 w-12 place-items-center rounded-xl border font-display text-lg font-bold ${ring}`}>
      {score}
    </span>
  );
}

export function GapChip({ gap }: { gap: "web" | "marketing" | "both" | "none" }) {
  switch (gap) {
    case "web":
      return <Badge tone="sky">Website gap</Badge>;
    case "marketing":
      return <Badge tone="violet">Marketing gap</Badge>;
    case "both":
      return <Badge tone="amber">Web + marketing</Badge>;
    default:
      return <Badge tone="slate">Dialled in</Badge>;
  }
}

const STATUS_TONE: Record<string, "sky" | "violet" | "amber" | "emerald" | "slate" | "red"> = {
  discovered: "slate",
  drafted: "sky",
  queued: "amber",
  sent: "emerald",
  skipped: "slate",
  suppressed: "red",
  replied: "violet",
  won: "emerald",
  lost: "slate",
};

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status] ?? "slate"}>{status}</Badge>;
}

/* Human label + tone for where an owner name came from, so every name is
   self-explanatory at a glance. */
const OWNER_SOURCE: Record<string, { label: string; tone: "violet" | "sky" | "emerald" | "amber" | "slate" }> = {
  ai: { label: "AI · website", tone: "violet" },
  parsed: { label: "from name", tone: "sky" },
  manual: { label: "you added", tone: "emerald" },
  bulk: { label: "imported", tone: "emerald" },
  website: { label: "website", tone: "amber" },
};

/** The owner cell shown on every lead — the first name we have plus where it came
    from, with the supporting sentence on hover. When unknown it stays a quiet,
    honest blank (a neutral "Hi," greeting) rather than a guess. */
export function OwnerCell({
  firstName,
  source,
  evidence,
  tried,
}: {
  firstName: string;
  source: string;
  evidence?: string;
  tried?: boolean;
}) {
  const name = firstName?.trim();
  if (!name) {
    return (
      <span
        className="inline-flex items-center gap-1.5 text-sm text-slate-400"
        title={tried ? "No owner name published anywhere we could read." : "Not checked yet."}
      >
        <span aria-hidden>👤</span>
        <span className="italic">no name{tried ? "" : " yet"}</span>
      </span>
    );
  }
  const meta = OWNER_SOURCE[source] ?? { label: source || "set", tone: "slate" as const };
  return (
    <span className="inline-flex items-center gap-2" title={evidence || undefined}>
      <span className="text-sm font-semibold text-slate-800">
        <span aria-hidden>👤</span> {name}
      </span>
      <Badge tone={meta.tone}>{meta.label}</Badge>
    </span>
  );
}

export function EvidenceList({ evidence }: { evidence: Evidence[] }) {
  const stable = evidence.filter((e) => e.polarity === "stable");
  const gaps = evidence.filter((e) => e.polarity === "gap").sort((a, b) => b.weight - a.weight);
  return (
    <div className="grid gap-5 sm:grid-cols-2">
      <div>
        <p className="text-xs font-bold uppercase tracking-wider text-emerald-700">Why it&rsquo;s worth it</p>
        <ul className="mt-2 space-y-2">
          {stable.length === 0 && <li className="text-sm text-slate-500">No stability signals found.</li>}
          {stable.map((e, i) => (
            <li key={i} className="flex gap-2 text-sm">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden />
              <span>
                <span className="font-semibold text-slate-800">{e.label}</span>
                <span className="text-slate-500"> — {e.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <p className="text-xs font-bold uppercase tracking-wider text-accent-600">Gaps you can fix</p>
        <ul className="mt-2 space-y-2">
          {gaps.length === 0 && <li className="text-sm text-slate-500">No obvious gaps — already dialled in.</li>}
          {gaps.map((e, i) => (
            <li key={i} className="flex gap-2 text-sm">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-accent-500" aria-hidden />
              <span>
                <span className="font-semibold text-slate-800">{e.label}</span>
                <span className="text-slate-500"> — {e.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function SignalSummary({ signals }: { signals: LeadSignals | null }) {
  if (!signals) return null;
  const items: string[] = [];
  if (!signals.hasWebsite) items.push("No website");
  else if (signals.parking) items.push("Parked page");
  else if (!signals.reachable) items.push("Site won't load");
  else {
    items.push(signals.https ? "SSL ✓" : "No SSL");
    if (signals.mobileFriendly === false) items.push("Not mobile");
    if (signals.builder) items.push(signals.builder);
    if (signals.staleCopyright && signals.copyrightYear) items.push(`© ${signals.copyrightYear}`);
  }
  if (signals.reviewCount != null) items.push(`${signals.reviewCount} reviews`);
  if (signals.rating != null) items.push(`${signals.rating.toFixed(1)}★`);
  return <span className="text-xs text-slate-500">{items.join(" · ")}</span>;
}
