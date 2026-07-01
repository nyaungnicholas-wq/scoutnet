import { asc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { leads, leadSends, profiles } from "@/db/schema";
import { buttonClass, Card, SectionTitle } from "@/components/ui";
import { EvidenceList, GapChip, ScoreBadge, StatusBadge } from "@/components/lead-bits";
import {
  findOwnerAction,
  markLeadAction,
  saveDraftAction,
  sendLeadAction,
  setContactNameAction,
  simulateReplyAction,
  skipLeadAction,
  suppressLeadAction,
} from "@/lib/actions";
import { getSessionAccount } from "@/lib/auth";
import { getDb, isUuid } from "@/lib/db";
import { getActiveMailbox } from "@/lib/mailbox";
import { accountSendStatus } from "@/lib/sending";
import { buildFollowup, FOLLOWUP_STEPS } from "@/lib/agent/followups";

const STEP_LABEL = ["Opener", "Follow-up", "Final note"];

export const metadata = { title: "Lead — ScoutNet" };

const INPUT =
  "mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-sky-600 focus:ring-2 focus:ring-sky-600/20";

export default async function LeadDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string; sent?: string; detail?: string; marked?: string; nameSaved?: string; ownerSuggest?: string }>;
}) {
  const account = await getSessionAccount();
  if (!account) redirect("/signin");
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { saved, sent, detail, marked, nameSaved, ownerSuggest } = await searchParams;
  const suggestedName = ownerSuggest && !["none", "nosite"].includes(ownerSuggest) ? ownerSuggest : "";

  const db = await getDb();
  const lead = (await db.select().from(leads).where(eq(leads.id, id)))[0];
  if (!lead || lead.accountId !== account.id) notFound();

  const profile = (await db.select().from(profiles).where(eq(profiles.accountId, account.id)))[0];
  const ready = await accountSendStatus(db, profile);
  const mailbox = await getActiveMailbox(db, account.id);
  const s = lead.signals;
  const alreadySent = ["sent", "replied", "won", "lost"].includes(lead.status);
  // A known-bad email is never sendable; catch-all/unknown can be sent manually.
  const emailSendable = lead.verifyStatus !== "invalid" && lead.verifyStatus !== "disposable";
  const canSend =
    ready.ok && Boolean(lead.email) && emailSendable && (lead.status === "drafted" || lead.status === "queued");
  const open = lead.status === "sent"; // thread still live (no reply/win/loss yet)

  const sends = alreadySent
    ? await db.select().from(leadSends).where(eq(leadSends.leadId, id)).orderBy(asc(leadSends.ordinal))
    : [];

  return (
    <div className="max-w-3xl space-y-6">
      <Link href="/dashboard/leads" className="text-sm font-medium text-slate-500 hover:text-slate-800">
        ← Back to leads
      </Link>

      {saved === "1" && (
        <p role="status" className="rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          Draft saved.
        </p>
      )}
      {sent && (
        <p
          role="status"
          className={`rounded-lg px-4 py-3 text-sm ${sent === "sent" ? "bg-emerald-50 text-emerald-900" : "bg-amber-50 text-amber-900"}`}
        >
          {sent === "sent" ? "Email sent — nicely done." : `Didn't send (${sent}${detail ? `: ${detail}` : ""}).`}
        </p>
      )}
      {marked && (
        <p role="status" className="rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          Marked <strong>{marked}</strong>. Any pending follow-ups for this lead are stopped.
        </p>
      )}

      {/* header */}
      <div className="flex items-start gap-4">
        <ScoreBadge score={lead.score} />
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900">{lead.businessName}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <GapChip gap={lead.primaryGap} />
            <StatusBadge status={lead.status} />
            <span className="text-xs text-slate-500">
              income {lead.incomeScore} · need {lead.needScore}
            </span>
          </div>
        </div>
      </div>

      {/* contact facts */}
      <Card>
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <Fact label="Website">
            {lead.website ? (
              <a href={lead.website} target="_blank" rel="noreferrer" className="break-all text-sky-800 hover:underline">
                {lead.website}
              </a>
            ) : (
              <span className="text-accent-600">none found</span>
            )}
          </Fact>
          <Fact label="Email">
            {lead.email ? (
              <span className="inline-flex flex-wrap items-center gap-2">
                <span className="break-all">{lead.email}</span>
                <VerifyChip status={lead.verifyStatus} />
              </span>
            ) : (
              <span className="text-amber-600">none — find one to send</span>
            )}
          </Fact>
          <Fact label="Phone">{lead.phone || "—"}</Fact>
          <Fact label="Address">{lead.address || "—"}</Fact>
          <Fact label="Source">{lead.source || "—"}</Fact>
          <Fact label="Maps">
            {lead.mapsUrl ? (
              <a href={lead.mapsUrl} target="_blank" rel="noreferrer" className="text-sky-800 hover:underline">
                open
              </a>
            ) : (
              "—"
            )}
          </Fact>
        </dl>
      </Card>

      {/* owner's first name → email greeting */}
      <Card>
        <label htmlFor="contactFirstName" className="text-sm font-medium text-slate-700">
          Owner&rsquo;s first name{" "}
          <span className="font-normal text-slate-400">— greets the email &ldquo;Hi {lead.contactFirstName?.trim() || "…"},&rdquo;</span>
        </label>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <form action={setContactNameAction} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="leadId" value={lead.id} />
            <input
              id="contactFirstName"
              name="contactFirstName"
              type="text"
              maxLength={60}
              defaultValue={lead.contactFirstName?.trim() || suggestedName}
              placeholder="e.g. Mike"
              className={`${INPUT} mt-0 max-w-44`}
            />
            <button type="submit" className={buttonClass("secondary", "sm")}>
              Save name
            </button>
          </form>
          {lead.website && (
            <form action={findOwnerAction}>
              <input type="hidden" name="leadId" value={lead.id} />
              <button type="submit" className={buttonClass("ghost", "sm")}>
                Try their website
              </button>
            </form>
          )}
        </div>
        {lead.contactFirstName?.trim() && lead.contactEvidence && (
          <p className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
            Why <strong className="text-slate-700">{lead.contactFirstName}</strong>
            {lead.contactSource === "ai"
              ? " — AI read it off their site"
              : lead.contactSource === "parsed"
                ? " — read from the business name"
                : ""}
            : <span className="italic">“{lead.contactEvidence}”</span>
          </p>
        )}
        {nameSaved && <p role="status" className="mt-2 text-xs text-emerald-700">Saved — greeting updated.</p>}
        {suggestedName && (
          <p role="status" className="mt-2 text-xs text-emerald-700">
            Found <strong>{suggestedName}</strong> on their website — review it above and hit Save (verify it's the owner).
          </p>
        )}
        {ownerSuggest === "none" && (
          <p className="mt-2 text-xs text-amber-700">No owner name found on their site (many are app-built or don&rsquo;t list it) — try the links below or ask on the call.</p>
        )}
        {ownerSuggest === "nosite" && (
          <p className="mt-2 text-xs text-amber-700">No website on file to scan — use the links below or ask on the call.</p>
        )}
        <p className="mt-3 text-xs text-slate-500">
          Find the owner in one click:{" "}
          <a className="font-medium text-sky-700 underline" target="_blank" rel="noreferrer" href={`https://www.google.com/search?q=${encodeURIComponent(`"${lead.businessName}" ${lead.location || ""} owner`)}`}>
            Google
          </a>{" "}
          ·{" "}
          <a className="font-medium text-sky-700 underline" target="_blank" rel="noreferrer" href={`https://www.google.com/search?q=${encodeURIComponent(`${lead.businessName} ${lead.location || ""}`)}+site:facebook.com`}>
            Facebook
          </a>{" "}
          ·{" "}
          <a className="font-medium text-sky-700 underline" target="_blank" rel="noreferrer" href={`https://opencorporates.com/companies?q=${encodeURIComponent(lead.businessName)}&type=companies`}>
            OpenCorporates
          </a>
          {["hvac", "plumbing", "electrical", "roofing", "landscaping"].includes(lead.vertical) && (
            <>
              {" "}·{" "}
              <a className="font-medium text-sky-700 underline" target="_blank" rel="noreferrer" href={`https://www.google.com/search?q=${encodeURIComponent(`"${lead.businessName}" CSLB license`)}`}>
                CSLB license
              </a>
            </>
          )}
        </p>
        <p className="mt-1 text-xs text-slate-400">
          Places &amp; OSM never include the owner&rsquo;s name — grab it from one of these (or just ask on the call) and the
          email personalizes itself.
        </p>
      </Card>

      {/* the evidence */}
      <section className="space-y-3">
        <SectionTitle>Why ScoutNet flagged this — the evidence</SectionTitle>
        <Card>
          <EvidenceList evidence={lead.evidence} />
          {s && (
            <div className="mt-5 flex flex-wrap gap-2 border-t border-slate-100 pt-4 text-xs text-slate-500">
              {chip(s.hasWebsite ? (s.https ? "SSL ✓" : "no SSL") : "no website")}
              {s.mobileFriendly === false && chip("not mobile")}
              {s.parking && chip("parked page")}
              {s.builder && chip(`builder: ${s.builder}`)}
              {s.staleCopyright && s.copyrightYear ? chip(`© ${s.copyrightYear}`) : null}
              {s.hasContactForm === false && chip("no contact form")}
              {s.hasBooking === false && chip("no booking")}
              {s.hasEmailCapture === false && chip("no email capture")}
              {s.reviewCount != null && chip(`${s.reviewCount} reviews`)}
              {s.rating != null && chip(`${s.rating.toFixed(1)}★`)}
              {s.ageYears != null && chip(`~${s.ageYears}y old`)}
            </div>
          )}
        </Card>
      </section>

      {/* the draft / the thread */}
      <section className="space-y-3">
        <SectionTitle>{alreadySent ? "The thread" : "Your draft"}</SectionTitle>
        <Card>
          {alreadySent ? (
            <div className="space-y-4">
              {/* sent steps */}
              <ol className="space-y-3">
                {sends.map((row) => {
                  const content =
                    row.ordinal === 0
                      ? { subject: lead.draftSubject, body: lead.draftBody }
                      : buildFollowup(
                          { businessName: lead.businessName, primaryGap: lead.primaryGap },
                          { businessName: profile?.businessName ?? "", ownerName: profile?.ownerName ?? "", businessPhone: profile?.businessPhone ?? "" },
                          row.ordinal
                        );
                  return (
                    <li key={row.id} className="rounded-lg border border-slate-200 p-3">
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="font-bold uppercase tracking-wide text-sky-800">
                          {STEP_LABEL[row.ordinal] ?? `Step ${row.ordinal}`}
                        </span>
                        <span className="text-slate-400">
                          {row.ok ? "sent" : "failed"} · {row.sentAt.toLocaleString()}
                        </span>
                      </div>
                      <p className="mt-1.5 text-sm font-semibold text-slate-900">{content.subject}</p>
                      <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded bg-slate-50 p-2 font-mono text-xs text-slate-600">
                        {content.body}
                      </pre>
                    </li>
                  );
                })}
              </ol>

              {/* next step / sequence state */}
              {open && lead.nextFollowupAt && lead.step <= FOLLOWUP_STEPS ? (
                <p className="rounded-lg bg-sky-50 px-4 py-3 text-sm text-sky-900">
                  Next: <strong>{STEP_LABEL[lead.step] ?? `step ${lead.step}`}</strong>{" "}
                  {lead.nextFollowupAt > new Date()
                    ? `scheduled for ${lead.nextFollowupAt.toLocaleString()}`
                    : "due now — runs on the next dispatch"}
                  {profile && !profile.followupsEnabled ? " (follow-ups are off in Settings)" : ""}.
                </p>
              ) : open ? (
                <p className="rounded-lg bg-slate-50 px-4 py-3 text-sm text-slate-600">
                  Sequence complete — all follow-ups sent, no reply yet.
                </p>
              ) : (
                <p className="rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
                  Thread closed — marked <strong>{lead.status}</strong>.
                </p>
              )}

              {/* outcome controls */}
              {open && (
                <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-4">
                  <span className="text-sm text-slate-600">Heard back? Mark it to stop follow-ups:</span>
                  {(["replied", "won", "lost"] as const).map((st) => (
                    <form key={st} action={markLeadAction}>
                      <input type="hidden" name="leadId" value={lead.id} />
                      <input type="hidden" name="status" value={st} />
                      <button type="submit" className={buttonClass(st === "lost" ? "ghost" : "secondary", "sm")}>
                        Mark {st}
                      </button>
                    </form>
                  ))}
                  {process.env.NODE_ENV !== "production" && mailbox?.provider === "mock" && (
                    <form action={simulateReplyAction}>
                      <input type="hidden" name="leadId" value={lead.id} />
                      <button type="submit" className={buttonClass("ghost", "sm")} title="Dev: stand in for Gmail reply auto-detection">
                        Simulate a reply
                      </button>
                    </form>
                  )}
                </div>
              )}
            </div>
          ) : (
            <>
              <p className="text-sm text-slate-600">
                Drafted from the evidence above — every claim traces to something real. Edit freely;
                a CAN-SPAM footer with your address and a one-click unsubscribe is added automatically
                when it sends.
              </p>
              <form action={saveDraftAction} className="mt-4 space-y-3">
                <input type="hidden" name="leadId" value={lead.id} />
                <div>
                  <label htmlFor="subject" className="text-sm font-medium text-slate-700">
                    Subject
                  </label>
                  <input id="subject" name="subject" type="text" maxLength={200} defaultValue={lead.draftSubject} className={INPUT} />
                </div>
                <div>
                  <label htmlFor="body" className="text-sm font-medium text-slate-700">
                    Body
                  </label>
                  <textarea id="body" name="body" rows={14} maxLength={4000} defaultValue={lead.draftBody} className={`${INPUT} font-mono`} />
                </div>
                <button type="submit" className={buttonClass("secondary")}>
                  Save draft
                </button>
              </form>

              <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-5">
                <form action={sendLeadAction}>
                  <input type="hidden" name="leadId" value={lead.id} />
                  <button type="submit" disabled={!canSend} className={buttonClass("primary")}>
                    Send this email
                  </button>
                </form>
                <form action={skipLeadAction}>
                  <input type="hidden" name="leadId" value={lead.id} />
                  <button type="submit" className={buttonClass("ghost")}>
                    Skip
                  </button>
                </form>
                <form action={suppressLeadAction}>
                  <input type="hidden" name="leadId" value={lead.id} />
                  <button type="submit" className={buttonClass("danger")}>
                    Suppress (never contact)
                  </button>
                </form>
                {!ready.ok && (
                  <span className="text-xs text-amber-700">
                    Sending blocked: {ready.missing.join(", ")}.{" "}
                    <Link href="/dashboard/settings" className="underline">
                      Settings
                    </Link>
                  </span>
                )}
                {ready.ok && !lead.email && <span className="text-xs text-amber-700">No email on file — add one to send.</span>}
                {ready.ok && lead.email && !emailSendable && (
                  <span className="text-xs text-amber-700">
                    Email verified {lead.verifyStatus} — sending is blocked to protect your reputation.
                  </span>
                )}
                {ready.ok && emailSendable && lead.verifyStatus === "accept_all" && (
                  <span className="text-xs text-slate-500">
                    Catch-all domain — can&rsquo;t confirm this inbox, so it won&rsquo;t auto-send. Send manually if you trust it.
                  </span>
                )}
              </div>
            </>
          )}
        </Card>
      </section>
    </div>
  );
}

function VerifyChip({ status }: { status: string }) {
  const map: Record<string, { tone: string; label: string }> = {
    valid: { tone: "bg-emerald-100 text-emerald-800", label: "verified ✓" },
    accept_all: { tone: "bg-amber-100 text-amber-800", label: "catch-all" },
    invalid: { tone: "bg-red-100 text-red-700", label: "invalid" },
    disposable: { tone: "bg-red-100 text-red-700", label: "disposable" },
    unknown: { tone: "bg-slate-200 text-slate-600", label: "unconfirmed" },
    unverified: { tone: "bg-slate-200 text-slate-600", label: "not checked" },
  };
  const v = map[status] ?? map.unverified;
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${v.tone}`}>{v.label}</span>;
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="mt-0.5 text-slate-800">{children}</dd>
    </div>
  );
}

function chip(text: string) {
  return <span className="rounded-full bg-slate-100 px-2 py-0.5">{text}</span>;
}
