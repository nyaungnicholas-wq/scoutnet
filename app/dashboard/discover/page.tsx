import { desc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { discoveryJobs, profiles } from "@/db/schema";
import { buttonClass, Card, SectionTitle } from "@/components/ui";
import { enqueueDiscoveryAction, runDiscoveryAction } from "@/lib/actions";
import { JobRunner } from "@/components/job-runner";
import { getSessionAccount } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { availableProviders, defaultProvider } from "@/lib/agent/discovery";
import { senderReady } from "@/lib/sending";
import { VERTICALS } from "@/lib/verticals";
import Link from "next/link";

export const metadata = { title: "Discover — ScoutNet" };

const INPUT =
  "mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-sky-600 focus:ring-2 focus:ring-sky-600/20";
const LABEL = "text-sm font-medium text-slate-700";
const HELP = "mt-1 text-xs text-slate-500";

export default async function DiscoverPage({ searchParams }: { searchParams: Promise<{ job?: string }> }) {
  const account = await getSessionAccount();
  if (!account) redirect("/signin");
  const { job } = await searchParams;
  const db = await getDb();
  const profile = (await db.select().from(profiles).where(eq(profiles.accountId, account.id)))[0];
  const ready = senderReady(profile);

  const providers = availableProviders();
  const fallbackProvider = defaultProvider();

  const jobs = await db
    .select()
    .from(discoveryJobs)
    .where(eq(discoveryJobs.accountId, account.id))
    .orderBy(desc(discoveryJobs.createdAt))
    .limit(5);
  const hasActive = jobs.some((j) => j.status === "enriching" || j.status === "staging");

  return (
    <div className="max-w-2xl space-y-8">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900">Discover businesses</h1>
        <p className="mt-1 text-sm text-slate-600">
          Pick a trade and a place. ScoutNet searches the web, reads each business&rsquo;s website,
          scores it on stable-income vs. digital-gap signals, and drafts a pitch for the ones worth
          your time.
        </p>
      </div>

      {!ready.ok && (
        <p className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900">
          You can discover and draft now, but sending is blocked until you finish{" "}
          <Link href="/dashboard/settings" className="font-semibold underline">
            Settings
          </Link>{" "}
          (missing: {ready.missing.join(", ")}).
        </p>
      )}

      {job === "started" && (
        <p role="status" className="rounded-lg bg-sky-50 px-4 py-3 text-sm text-sky-900">
          Background sweep queued. Leads will stream into{" "}
          <Link href="/dashboard/leads" className="font-semibold underline">
            Leads
          </Link>{" "}
          as they&rsquo;re scored — watch the progress below.
        </p>
      )}

      {jobs.length > 0 && (
        <section className="space-y-3">
          <SectionTitle>Background sweeps</SectionTitle>
          <Card>
            <ul className="space-y-3">
              {jobs.map((j) => {
                const pct = j.total ? Math.round((j.processed / j.total) * 100) : j.status === "done" ? 100 : 0;
                const active = j.status === "enriching" || j.status === "staging";
                return (
                  <li key={j.id} className="text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium text-slate-800">
                        {j.vertical} · {j.location} · {j.radiusMiles}mi · {j.provider}
                      </span>
                      <span className={active ? "text-sky-700" : "text-slate-500"}>
                        {j.status === "staging"
                          ? "fetching businesses…"
                          : `${j.added} leads · ${j.processed}/${j.total} scanned${j.status === "done" ? " · done" : ""}`}
                      </span>
                    </div>
                    <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-100">
                      <div
                        className={`h-full rounded-full ${active ? "bg-sky-500" : "bg-emerald-500"}`}
                        style={{ width: `${Math.max(pct, j.status === "staging" ? 8 : 0)}%` }}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
            <JobRunner hasActive={hasActive} />
          </Card>
        </section>
      )}

      <section className="space-y-3">
        <SectionTitle>New search</SectionTitle>
        <Card>
          <form action={runDiscoveryAction} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="vertical" className={LABEL}>
                  Trade / vertical
                </label>
                <select id="vertical" name="vertical" defaultValue="hvac" className={`${INPUT} cursor-pointer bg-white`}>
                  {VERTICALS.map((v) => (
                    <option key={v.key} value={v.key}>
                      {v.label}
                    </option>
                  ))}
                </select>
                <p className={HELP}>Recession-resistant trades score highest on income stability.</p>
              </div>
              <div>
                <label htmlFor="location" className={LABEL}>
                  Location
                </label>
                <input
                  id="location"
                  name="location"
                  type="text"
                  required
                  maxLength={120}
                  placeholder="Tucson, AZ"
                  className={INPUT}
                />
                <p className={HELP}>A city, region, or “City, ST”.</p>
              </div>
            </div>

            <div>
              <label htmlFor="provider" className={LABEL}>
                Data source
              </label>
              <select id="provider" name="provider" defaultValue={fallbackProvider} className={`${INPUT} cursor-pointer bg-white`}>
                {providers.map((p) => (
                  <option key={p.key} value={p.key} disabled={!p.ready}>
                    {p.label}
                    {p.ready ? "" : " — unavailable"}
                  </option>
                ))}
              </select>
              <ul className={`${HELP} space-y-0.5`}>
                {providers.map((p) => (
                  <li key={p.key}>
                    <span className="font-semibold text-slate-600">{p.label}:</span> {p.note}
                  </li>
                ))}
              </ul>
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <label htmlFor="radiusMiles" className={LABEL}>
                  Radius (miles)
                </label>
                <input id="radiusMiles" name="radiusMiles" type="number" min={1} max={50} defaultValue={25} className={`${INPUT}`} />
                <p className={HELP}>1–50 mi around the location. OSM only.</p>
              </div>
              <div>
                <label htmlFor="count" className={LABEL}>
                  How many to scan
                </label>
                <input id="count" name="count" type="number" min={1} max={150} defaultValue={50} className={`${INPUT}`} />
                <p className={HELP}>1–150 per run. Each is fetched &amp; scored.</p>
              </div>
              <div>
                <label htmlFor="minScore" className={LABEL}>
                  Min score to keep
                </label>
                <input id="minScore" name="minScore" type="number" min={0} max={100} defaultValue={50} className={`${INPUT}`} />
                <p className={HELP}>Below this: scanned, not saved.</p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button type="submit" className={buttonClass("primary", "lg")}>
                Search &amp; score
              </button>
              <button type="submit" formAction={enqueueDiscoveryAction} className={buttonClass("secondary", "lg")}>
                Background sweep (unlimited)
              </button>
            </div>
            <p className="mt-1 text-xs text-slate-500">
              <strong>Search &amp; score</strong> runs now (up to 150, ~a couple minutes).{" "}
              <strong>Background sweep</strong> stages up to 600 businesses and scores them in the
              background — leave the tab open and they stream into Leads.
            </p>
            <p className="text-xs text-slate-500">
              For a wide &ldquo;every business near me&rdquo; sweep, pick{" "}
              <strong>All local businesses</strong> + <strong>OpenStreetMap</strong> with a 25–50 mi radius.
              A 150-business scan can take a couple of minutes (each site is fetched). Re-running never
              duplicates a business you already have.
            </p>
          </form>
        </Card>
      </section>
    </div>
  );
}
