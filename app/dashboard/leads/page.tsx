import { and, desc, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";
import { leads, profiles } from "@/db/schema";
import { buttonClass, ButtonLink, EmptyState, Stat } from "@/components/ui";
import { GapChip, OwnerCell, ScoreBadge, SignalSummary, StatusBadge } from "@/components/lead-bits";
import { OwnerFinder } from "@/components/owner-finder";
import { ClearLeadsButton } from "@/components/clear-leads-button";
import { bulkSetOwnersAction, runDispatchAction, sendLeadAction, skipLeadAction } from "@/lib/actions";
import { getSessionAccount } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { accountSendStatus } from "@/lib/sending";
import { geminiKeySource } from "@/lib/owner-ai";

export const metadata = { title: "Leads — ScoutNet" };

type Filter = "review" | "sent" | "dismissed" | "all";

const FILTER_STATUSES: Record<Filter, string[] | null> = {
  review: ["drafted", "queued"],
  sent: ["sent", "replied", "won", "lost"],
  dismissed: ["skipped", "suppressed"],
  all: null,
};

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; sent?: string; detail?: string; dispatched?: string; owners?: string; cleared?: string }>;
}) {
  const account = await getSessionAccount();
  if (!account) redirect("/signin");
  const { filter: filterRaw, sent, detail, dispatched, owners, cleared } = await searchParams;
  const ownerCounts = owners?.match(/^(\d+)_(\d+)$/);
  const filter: Filter = (["review", "sent", "dismissed", "all"] as const).includes(filterRaw as Filter)
    ? (filterRaw as Filter)
    : "review";

  const db = await getDb();
  const profile = (await db.select().from(profiles).where(eq(profiles.accountId, account.id)))[0];
  const ready = await accountSendStatus(db, profile);
  const threshold = profile?.autoSendThreshold ?? 80;

  const all = await db
    .select()
    .from(leads)
    .where(eq(leads.accountId, account.id))
    .orderBy(desc(leads.score));

  const ownerPending = all.filter(
    (l) => !l.ownerTried && !l.contactFirstName && ["discovered", "drafted", "queued"].includes(l.status)
  ).length;
  const ownerFound = all.filter((l) => l.contactFirstName.trim()).length;

  const counts = {
    review: all.filter((l) => ["drafted", "queued"].includes(l.status)).length,
    sent: all.filter((l) => ["sent", "replied", "won", "lost"].includes(l.status)).length,
    autoEligible: all.filter(
      (l) => l.status === "drafted" && l.email && l.verifyStatus === "valid" && l.score >= threshold
    ).length,
  };

  const statuses = FILTER_STATUSES[filter];
  const rows = statuses
    ? await db
        .select()
        .from(leads)
        .where(and(eq(leads.accountId, account.id), inArray(leads.status, statuses as (typeof leads.status.enumValues)[number][])))
        .orderBy(desc(leads.score))
    : all;

  const TABS: { key: Filter; label: string }[] = [
    { key: "review", label: `To review (${counts.review})` },
    { key: "sent", label: `Sent (${counts.sent})` },
    { key: "dismissed", label: "Dismissed" },
    { key: "all", label: "All" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900">Leads</h1>
          <p className="mt-1 text-sm text-slate-600">
            Ranked by opportunity. Strong matches auto-send; the rest wait for your call.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a href="/dashboard/leads/export" className={buttonClass("secondary")}>
            ⬇ Export CSV
          </a>
          <ClearLeadsButton count={all.length} />
          <ButtonLink href="/dashboard/discover" variant="primary">
            + Discover more
          </ButtonLink>
        </div>
      </div>

      {cleared && (
        <p role="status" className="rounded-lg bg-slate-100 px-4 py-3 text-sm text-slate-700">
          All leads cleared. Run a discovery to start fresh.
        </p>
      )}
      {dispatched != null && (
        <p role="status" className="rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          Auto-send pass complete — {dispatched} email{dispatched === "1" ? "" : "s"} sent. Below-threshold leads stay here for you.
        </p>
      )}
      {sent && (
        <p
          role="status"
          className={`rounded-lg px-4 py-3 text-sm ${
            sent === "sent" ? "bg-emerald-50 text-emerald-900" : "bg-amber-50 text-amber-900"
          }`}
        >
          {sent === "sent"
            ? "Email sent."
            : `Send didn't go out (${sent}${detail ? `: ${detail}` : ""}). Check Settings.`}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="To review" value={String(counts.review)} tone="sky" />
        <Stat label="Auto-send ready" value={String(counts.autoEligible)} hint={`score ≥ ${threshold}`} tone="emerald" />
        <Stat label="Sent" value={String(counts.sent)} tone="slate" />
      </div>

      {/* Hybrid control: send the strong ones, keep the rest for review. */}
      <div className="card-soft flex flex-wrap items-center justify-between gap-3 p-4">
        <p className="text-sm text-slate-600">
          <span className="font-semibold text-slate-800">Hybrid send.</span> Auto-send fires for leads scoring{" "}
          <strong>≥ {threshold}</strong> with an email on file. {counts.autoEligible} ready now.
          {!ready.ok && <span className="text-amber-700"> Sending blocked — finish Settings first.</span>}
        </p>
        <form action={runDispatchAction}>
          <button type="submit" disabled={!ready.ok || counts.autoEligible === 0} className={buttonClass("primary")}>
            Run auto-send now
          </button>
        </form>
      </div>

      {ownerCounts && (
        <p role="status" className="rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          Owners imported — {ownerCounts[1]} name{ownerCounts[1] === "1" ? "" : "s"} matched and applied.
          {Number(ownerCounts[2]) > 0 && <span className="text-amber-700"> {ownerCounts[2]} line(s) didn’t match a lead.</span>}
        </p>
      )}

      {/* Live auto owner-finder: AI + free engine, updates the list as names are found. */}
      <OwnerFinder pending={ownerPending} found={ownerFound} total={all.length} aiKeySource={geminiKeySource()} />

      {/* Bulk owner import: paste a "Business | FirstName" list to personalize greetings. */}
      <details className="card-soft p-4">
        <summary className="cursor-pointer text-sm font-semibold text-slate-800">
          👤 Bulk-add owner names
        </summary>
        <form action={bulkSetOwnersAction} className="mt-3 space-y-2">
          <p className="text-sm text-slate-600">
            Paste one line per business: <code className="rounded bg-slate-100 px-1">Business Name | FirstName</code>{" "}
            (extra columns after the name are ignored). Each match sets the lead’s owner and rewrites the email greeting to “Hi Name,”.
          </p>
          <textarea
            name="paste"
            rows={8}
            placeholder={"Pine Center Dental Group | Hossein\nTerra Vista Dental Care | Keyur\nDay Creek Dental Care | Paul"}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm focus:border-sky-500 focus:outline-none"
          />
          <button type="submit" className={buttonClass("primary")}>
            Import names
          </button>
        </form>
      </details>

      <div className="flex flex-wrap gap-1 border-b border-slate-200">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/dashboard/leads?filter=${t.key}`}
            aria-current={filter === t.key ? "page" : undefined}
            className={`-mb-px rounded-t-lg px-3 py-2 text-sm font-medium ${
              filter === t.key ? "border-b-2 border-sky-700 text-sky-900" : "text-slate-500 hover:text-slate-800"
            }`}
          >
            {t.label}
          </Link>
        ))}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title={filter === "review" ? "No leads to review yet" : "Nothing here"}
          action={<ButtonLink href="/dashboard/discover">Run your first search</ButtonLink>}
        >
          Discovery drops scored, drafted leads right here.
        </EmptyState>
      ) : (
        <ul className="space-y-3">
          {rows.map((l) => {
            const sendable = l.verifyStatus !== "invalid" && l.verifyStatus !== "disposable";
            const canSend = ready.ok && Boolean(l.email) && sendable && l.status === "drafted";
            return (
              <li key={l.id} className="card-soft p-4">
                <div className="flex items-start gap-4">
                  <ScoreBadge score={l.score} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={`/dashboard/leads/${l.id}`} className="font-display font-bold text-slate-900 hover:text-sky-800">
                        {l.businessName}
                      </Link>
                      <GapChip gap={l.primaryGap} />
                      <StatusBadge status={l.status} />
                      {l.score >= threshold && l.status === "drafted" && l.email && l.verifyStatus === "valid" ? (
                        <span className="text-xs font-semibold text-emerald-700">auto-send ready</span>
                      ) : null}
                    </div>
                    <p className="mt-1 truncate text-sm text-slate-600">
                      {l.website ? (
                        <a href={l.website} target="_blank" rel="noreferrer" className="hover:underline">
                          {l.website.replace(/^https?:\/\//, "")}
                        </a>
                      ) : (
                        <span className="text-accent-600">no website</span>
                      )}
                      {l.email ? (
                        <span className="text-slate-400"> · {l.email}</span>
                      ) : l.phone ? (
                        <span className="text-sky-700"> · ☎ {l.phone} — call list</span>
                      ) : (
                        <span className="text-amber-600"> · no contact — review only</span>
                      )}
                    </p>
                    <p className="mt-1.5">
                      <OwnerCell
                        firstName={l.contactFirstName}
                        source={l.contactSource}
                        evidence={l.contactEvidence}
                        tried={l.ownerTried}
                      />
                    </p>
                    <p className="mt-1">
                      <SignalSummary signals={l.signals} />
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-stretch gap-2">
                    <ButtonLink href={`/dashboard/leads/${l.id}`} variant="secondary" size="sm">
                      Review
                    </ButtonLink>
                    {canSend && (
                      <form action={sendLeadAction}>
                        <input type="hidden" name="leadId" value={l.id} />
                        <button type="submit" className={`${buttonClass("primary", "sm")} w-full`}>
                          Send
                        </button>
                      </form>
                    )}
                    {l.status === "drafted" && (
                      <form action={skipLeadAction}>
                        <input type="hidden" name="leadId" value={l.id} />
                        <button type="submit" className={`${buttonClass("ghost", "sm")} w-full`}>
                          Skip
                        </button>
                      </form>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
