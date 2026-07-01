import { and, desc, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";
import { discoveryRuns, leads, profiles } from "@/db/schema";
import { ButtonLink, Card, EmptyState, SectionTitle, Stat } from "@/components/ui";
import { GapChip, ScoreBadge } from "@/components/lead-bits";
import { getSessionAccount } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { senderReady } from "@/lib/sending";

export const metadata = { title: "Home — ScoutNet" };

export default async function DashboardHome() {
  const account = await getSessionAccount();
  if (!account) redirect("/signin");
  const db = await getDb();

  const profile = (await db.select().from(profiles).where(eq(profiles.accountId, account.id)))[0];
  const ready = senderReady(profile);
  const profileSet = Boolean(profile?.businessName && profile?.ownerName);

  const allLeads = await db.select().from(leads).where(eq(leads.accountId, account.id));
  const runs = await db
    .select()
    .from(discoveryRuns)
    .where(eq(discoveryRuns.accountId, account.id))
    .orderBy(desc(discoveryRuns.createdAt))
    .limit(5);

  const toReview = allLeads.filter((l) => ["drafted", "queued"].includes(l.status)).length;
  const sent = allLeads.filter((l) => ["sent", "replied", "won", "lost"].includes(l.status)).length;

  const topLeads = await db
    .select()
    .from(leads)
    .where(and(eq(leads.accountId, account.id), inArray(leads.status, ["drafted", "queued"])))
    .orderBy(desc(leads.score))
    .limit(3);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900">
            {profile?.businessName ? `Welcome back, ${profile.ownerName || profile.businessName}` : "Welcome to ScoutNet"}
          </h1>
          <p className="mt-1 text-sm text-slate-600">Find stable local businesses that need your help — and reach them honestly.</p>
        </div>
        <ButtonLink href="/dashboard/discover" variant="primary" size="lg">
          Discover businesses →
        </ButtonLink>
      </div>

      {/* Setup nudges */}
      {(!profileSet || !ready.ok) && (
        <Card className="border-accent-100 bg-accent-50/40">
          <p className="font-display font-semibold text-slate-900">Finish setup to start sending</p>
          <ul className="mt-2 space-y-1 text-sm text-slate-700">
            {!profileSet && (
              <li>
                • Add your name and business in{" "}
                <Link href="/dashboard/settings" className="font-semibold underline">
                  Settings
                </Link>{" "}
                so drafts read as you.
              </li>
            )}
            {!ready.ok && <li>• Connect sending: {ready.missing.join(", ")}.</li>}
          </ul>
          <p className="mt-2 text-xs text-slate-500">
            You can discover and draft right now — sending unlocks once these are done (or instantly in dev, via the Outbox).
          </p>
        </Card>
      )}

      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Leads found" value={String(allLeads.length)} tone="sky" />
        <Stat label="To review" value={String(toReview)} tone="amber" />
        <Stat label="Sent" value={String(sent)} tone="emerald" />
        <Stat label="Searches" value={String(runs.length)} tone="slate" />
      </div>

      {/* Top opportunities */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <SectionTitle>Top opportunities</SectionTitle>
          <Link href="/dashboard/leads" className="text-sm font-medium text-sky-800 hover:underline">
            All leads →
          </Link>
        </div>
        {topLeads.length === 0 ? (
          <EmptyState title="No leads yet" action={<ButtonLink href="/dashboard/discover">Run your first search</ButtonLink>}>
            Pick a trade and a city — ScoutNet finds the businesses, scores them, and drafts the pitch.
          </EmptyState>
        ) : (
          <ul className="space-y-3">
            {topLeads.map((l) => (
              <li key={l.id}>
                <Link href={`/dashboard/leads/${l.id}`} className="card-soft flex items-center gap-4 p-4 transition-colors hover:bg-slate-50">
                  <ScoreBadge score={l.score} />
                  <div className="min-w-0 flex-1">
                    <p className="font-display font-bold text-slate-900">{l.businessName}</p>
                    <p className="truncate text-sm text-slate-500">
                      {l.website ? l.website.replace(/^https?:\/\//, "") : "no website"} · {l.location}
                    </p>
                  </div>
                  <GapChip gap={l.primaryGap} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Recent runs */}
      {runs.length > 0 && (
        <section className="space-y-3">
          <SectionTitle>Recent searches</SectionTitle>
          <Card className="p-0">
            <ul className="divide-y divide-slate-100">
              {runs.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
                  <span className="font-medium text-slate-800">
                    {r.vertical} · {r.location}
                  </span>
                  <span className="text-slate-500">
                    {r.added} kept of {r.found} found · via {r.provider} · {r.createdAt.toLocaleDateString()}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      )}
    </div>
  );
}
