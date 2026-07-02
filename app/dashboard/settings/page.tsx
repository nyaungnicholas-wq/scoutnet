import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";
import { profiles, verifiedAddresses } from "@/db/schema";
import { Badge, buttonClass, Card, SectionTitle } from "@/components/ui";
import {
  addVerifyAddress,
  connectMockMailbox,
  disconnectMailbox,
  runDeliverabilityCheck,
  saveSheetWebhookAction,
  syncSheetAction,
  updateProfile,
  updateSending,
} from "@/lib/actions";
import { getSessionAccount } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getActiveMailbox } from "@/lib/mailbox";
import { googleConfigured } from "@/lib/mailbox/gmail";
import { effectiveDailyCap, inWarmup, senderReady } from "@/lib/sending";
import { getSheetWebhook } from "@/lib/sheets";

export const metadata = { title: "Settings — ScoutNet" };

const INPUT =
  "mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-sky-600 focus:ring-2 focus:ring-sky-600/20";
const LABEL = "text-sm font-medium text-slate-700";
const HELP = "mt-1 text-xs text-slate-500";

/* The Apps Script the owner pastes into their sheet. Writes the leads AND styles
   the sheet nicely on every sync: navy header, frozen header + first column, zebra
   rows, a red→green color scale on Score, tidy widths, and a sort/filter. */
const APPS_SCRIPT = `function doPost(e) {
  var data = JSON.parse(e.postData.contents);
  if (data.mode !== "replace") {
    return ContentService.createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  var header = data.header;
  var rows = data.rows || [];
  var nCols = header.length;

  // reset everything
  sheet.clear();
  sheet.getBandings().forEach(function (b) { b.remove(); });
  sheet.setConditionalFormatRules([]);
  var existing = sheet.getFilter();
  if (existing) existing.remove();

  // write the data
  var values = [header].concat(rows);
  sheet.getRange(1, 1, values.length, nCols).setValues(values);

  // header bar
  sheet.getRange(1, 1, 1, nCols)
    .setBackground("#0d3050").setFontColor("#ffffff").setFontWeight("bold");
  sheet.setRowHeight(1, 32);
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(1);

  if (rows.length > 0) {
    // zebra striping
    sheet.getRange(2, 1, rows.length, nCols)
      .applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, false, false);

    // color the Score column red -> yellow -> green
    var sc = header.indexOf("Score") + 1;
    if (sc > 0) {
      var scoreRange = sheet.getRange(2, sc, rows.length, 1);
      scoreRange.setHorizontalAlignment("center").setFontWeight("bold");
      var rule = SpreadsheetApp.newConditionalFormatRule()
        .setGradientMinpointWithValue("#f8696b", SpreadsheetApp.InterpolationType.NUMBER, "40")
        .setGradientMidpointWithValue("#ffd666", SpreadsheetApp.InterpolationType.NUMBER, "70")
        .setGradientMaxpointWithValue("#63be7b", SpreadsheetApp.InterpolationType.NUMBER, "95")
        .setRanges([scoreRange]).build();
      sheet.setConditionalFormatRules([rule]);
    }
  }

  // tidy widths + a sort/filter (wrapped so a hiccup never fails the sync)
  try {
    for (var c = 1; c <= nCols; c++) sheet.autoResizeColumn(c);
    ["Website", "Email", "Address", "Maps"].forEach(function (name) {
      var i = header.indexOf(name) + 1;
      if (i > 0 && sheet.getColumnWidth(i) > 230) sheet.setColumnWidth(i, 230);
    });
    sheet.getRange(1, 1, values.length, nCols).createFilter();
  } catch (err) {}

  return ContentService.createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}`;

function isSafeVerifyUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (u.protocol === "http:" || u.protocol === "https:") && u.pathname === "/api/verify-address";
  } catch {
    return false;
  }
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    saved?: string;
    verifySent?: string;
    devLink?: string;
    verifyError?: string;
    authChecked?: string;
    authError?: string;
    connected?: string;
    disconnected?: string;
    mailboxError?: string;
    sheetSaved?: string;
    sheetSynced?: string;
    sheetError?: string;
  }>;
}) {
  const account = await getSessionAccount();
  if (!account) redirect("/signin");
  const { saved, verifySent, devLink, verifyError, authChecked, authError, connected, disconnected, mailboxError, sheetSaved, sheetSynced, sheetError } =
    await searchParams;
  const db = await getDb();
  const dev = process.env.NODE_ENV !== "production";
  const hasPlacesKey = Boolean(process.env.GOOGLE_PLACES_API_KEY);
  const sheetWebhook = await getSheetWebhook(db, account.id);

  const profile = (await db.select().from(profiles).where(eq(profiles.accountId, account.id)))[0];
  const mailbox = await getActiveMailbox(db, account.id);
  const gmailReady = googleConfigured();
  const mailboxErrorText: Record<string, string> = {
    "not-configured": "Gmail isn't configured on this server yet (GOOGLE_CLIENT_ID).",
    "connect-failed": "Couldn't connect that mailbox — please try again.",
    "dev-only": "The test mailbox is only available in development.",
  };
  const addresses = await db
    .select()
    .from(verifiedAddresses)
    .where(eq(verifiedAddresses.accountId, account.id))
    .orderBy(desc(verifiedAddresses.createdAt));

  const ready = senderReady(profile);
  const safeDevLink = dev && devLink && isSafeVerifyUrl(devLink) ? devLink : null;
  const verifyErrorText = verifyError ? verifyError.slice(0, 200) : null;

  return (
    <div className="max-w-2xl space-y-8">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900">Settings</h1>
        <p className="mt-1 text-sm text-slate-600">Who you are, what you offer, and how your outreach sends.</p>
      </div>

      {saved === "1" && (
        <p role="status" className="rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          Settings saved.
        </p>
      )}
      {verifySent === "1" && (
        <p role="status" className="rounded-lg bg-sky-50 px-4 py-3 text-sm text-sky-900">
          Confirmation email sent. Click the link in it to verify the address.
        </p>
      )}
      {verifyErrorText && (
        <p role="alert" className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {verifyErrorText}
        </p>
      )}
      {safeDevLink && (
        <div className="rounded-lg bg-slate-900 px-4 py-3 text-sm text-slate-100">
          <p className="font-semibold">Dev mode — click to verify (no inbox needed):</p>
          <a href={safeDevLink} className="mt-1 inline-block break-all text-sky-300 underline">
            {safeDevLink}
          </a>
        </div>
      )}
      {connected === "1" && (
        <p role="status" className="rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          Mailbox connected. Outreach now sends from it.
        </p>
      )}
      {disconnected === "1" && (
        <p role="status" className="rounded-lg bg-sky-50 px-4 py-3 text-sm text-sky-900">
          Mailbox disconnected.
        </p>
      )}
      {mailboxError && (
        <p role="alert" className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {mailboxErrorText[mailboxError] ?? "Something went wrong with the mailbox."}
        </p>
      )}

      {/* 1. You + your offer */}
      <section className="space-y-3">
        <SectionTitle>You &amp; your offer</SectionTitle>
        <Card>
          <p className="text-sm text-slate-600">
            The emails are kept lean and about the prospect — only <strong>your name</strong> appears
            (in the sign-off). Business name and address aren&rsquo;t shown; you handle the pitch
            yourself on the call.
          </p>
          <form action={updateProfile} className="mt-5 space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="businessName" className={LABEL}>
                  Your business name <span className="font-normal text-slate-400">(optional)</span>
                </label>
                <input id="businessName" name="businessName" type="text" maxLength={120} defaultValue={profile?.businessName ?? ""} className={INPUT} />
              </div>
              <div>
                <label htmlFor="ownerName" className={LABEL}>
                  Your name
                </label>
                <input id="ownerName" name="ownerName" type="text" required maxLength={120} defaultValue={profile?.ownerName ?? ""} className={INPUT} />
              </div>
              <div>
                <label htmlFor="businessPhone" className={LABEL}>
                  Phone
                </label>
                <input id="businessPhone" name="businessPhone" type="tel" maxLength={30} defaultValue={profile?.businessPhone ?? ""} className={INPUT} />
              </div>
              <div>
                <label htmlFor="website" className={LABEL}>
                  Your website
                </label>
                <input id="website" name="website" type="text" maxLength={300} placeholder="https://myagency.com" defaultValue={profile?.website ?? ""} className={INPUT} />
              </div>
            </div>
            <div>
              <label htmlFor="offer" className={LABEL}>
                What you offer
              </label>
              <input
                id="offer"
                name="offer"
                type="text"
                maxLength={160}
                placeholder="custom websites and done-for-you local marketing"
                defaultValue={profile?.offer ?? "custom websites and done-for-you marketing"}
                className={INPUT}
              />
              <p className={HELP}>One line describing what you do — for your own reference (the lean email copy doesn&rsquo;t insert it).</p>
            </div>
            <input type="hidden" name="accent" value={profile?.accent ?? "#0369a1"} />
            <input type="hidden" name="businessAddress" value={profile?.businessAddress ?? ""} />
            <button type="submit" className={buttonClass("primary")}>
              Save details
            </button>
          </form>
        </Card>
      </section>

      {/* 2. Discovery data source */}
      <section className="space-y-3">
        <SectionTitle>Discovery data source</SectionTitle>
        <Card>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="font-display text-sm font-semibold text-slate-900">Google Places API</p>
              <p className="text-xs text-slate-500">Richest local data — ratings, review counts, websites.</p>
            </div>
            {hasPlacesKey ? <Badge tone="emerald">Connected</Badge> : <Badge tone="slate">Not set</Badge>}
          </div>
          {!hasPlacesKey && (
            <p className="mt-3 rounded-lg bg-slate-50 px-4 py-3 text-sm text-slate-600">
              No <code className="rounded bg-slate-100 px-1 text-xs">GOOGLE_PLACES_API_KEY</code> found. ScoutNet
              still runs free on <strong>OpenStreetMap</strong> (real businesses, no key) and{" "}
              <strong>Sample data</strong> (for testing). Add the key to{" "}
              <code className="rounded bg-slate-100 px-1 text-xs">.env.local</code> and restart to unlock Places.
            </p>
          )}
        </Card>
      </section>

      {/* 2b. Live Google Sheet sync */}
      <section className="space-y-3">
        <SectionTitle>Live Google Sheet</SectionTitle>
        <Card>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="font-display text-sm font-semibold text-slate-900">Auto-sync leads to a Google Sheet</p>
              <p className="text-xs text-slate-500">Pushes your full, ranked lead list to your sheet after every discovery run.</p>
            </div>
            {sheetWebhook ? <Badge tone="emerald">Connected</Badge> : <Badge tone="slate">Not set</Badge>}
          </div>

          {sheetSaved && (
            <p role="status" className="mt-3 rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
              {sheetSaved === "cleared" ? "Sheet disconnected." : "Sheet connected — hit “Sync now” to push your leads."}
            </p>
          )}
          {sheetSynced && (
            <p role="status" className="mt-3 rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
              Pushed {sheetSynced} leads to your sheet. ✓
            </p>
          )}
          {sheetError && (
            <p role="alert" className="mt-3 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900">{sheetError.slice(0, 200)}</p>
          )}

          {sheetWebhook ? (
            <div className="mt-4 space-y-3">
              <p className="text-sm text-slate-600">
                Connected and syncing automatically after each discovery run. Push the current list anytime:
              </p>
              <form action={syncSheetAction}>
                <button type="submit" className={buttonClass("primary")}>
                  Sync now
                </button>
              </form>
              <form action={saveSheetWebhookAction} className="border-t border-slate-100 pt-3">
                <input type="hidden" name="sheetWebhook" value="" />
                <button type="submit" className={buttonClass("ghost", "sm")}>
                  Disconnect sheet
                </button>
              </form>
            </div>
          ) : (
            <div className="mt-4 space-y-3 text-sm text-slate-600">
              <p>One-time setup — no API keys, about 2 minutes:</p>
              <ol className="list-decimal space-y-1 pl-5">
                <li>
                  Open a new{" "}
                  <a className="font-semibold underline" href="https://sheets.new" target="_blank" rel="noreferrer">
                    Google Sheet
                  </a>{" "}
                  → <strong>Extensions → Apps Script</strong>.
                </li>
                <li>Delete the sample code, paste this, and Save:</li>
              </ol>
              <pre className="overflow-x-auto rounded-lg bg-slate-900 p-3 font-mono text-xs leading-relaxed text-slate-100">{APPS_SCRIPT}</pre>
              <ol className="list-decimal space-y-1 pl-5" start={3}>
                <li>
                  <strong>Deploy → New deployment → Web app</strong>. Execute as <strong>Me</strong>, Who has access:{" "}
                  <strong>Anyone</strong> → Deploy → authorize.
                </li>
                <li>Copy the <strong>Web app URL</strong> and paste it here:</li>
              </ol>
              <form action={saveSheetWebhookAction} className="flex flex-wrap items-end gap-2">
                <input
                  name="sheetWebhook"
                  type="url"
                  required
                  maxLength={400}
                  placeholder="https://script.google.com/macros/s/…/exec"
                  className={`${INPUT} min-w-72 flex-1`}
                />
                <button type="submit" className={buttonClass("primary")}>
                  Connect sheet
                </button>
              </form>
            </div>
          )}
        </Card>
      </section>

      {/* 3. Connected mailbox — the preferred sending channel */}
      <section className="space-y-3">
        <SectionTitle>Connected mailbox</SectionTitle>
        <Card>
          <p className="text-sm text-slate-600">
            The best way to send cold email is from your own real inbox — best inbox placement, and
            ScoutNet can auto-detect replies and stop the sequence for you. This is the recommended
            channel; the Resend option below is the fallback.
          </p>

          {mailbox ? (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-display text-sm font-semibold text-slate-900">{mailbox.email}</span>
                  <Badge tone={mailbox.provider === "gmail" ? "emerald" : "sky"}>
                    {mailbox.provider === "gmail" ? "Gmail" : "Test mailbox"}
                  </Badge>
                  {mailbox.status === "reauth_required" && <Badge tone="amber">Reconnect needed</Badge>}
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  {mailbox.provider === "mock"
                    ? "Dev mailbox — outreach lands in your Email outbox; use a lead's “Simulate a reply” to test auto-detect."
                    : "Replies are auto-detected from this mailbox and stop the sequence."}
                </p>
              </div>
              <form action={disconnectMailbox}>
                <input type="hidden" name="mailboxId" value={mailbox.id} />
                <button type="submit" className={buttonClass("secondary", "sm")}>
                  Disconnect
                </button>
              </form>
            </div>
          ) : (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              {gmailReady ? (
                <a href="/api/oauth/google/start" className={buttonClass("primary")}>
                  Connect Gmail
                </a>
              ) : (
                <span className="text-sm text-slate-500">
                  Gmail connect needs <code className="rounded bg-slate-100 px-1 text-xs">GOOGLE_CLIENT_ID</code> set on
                  the server.
                </span>
              )}
              {dev && (
                <form action={connectMockMailbox}>
                  <button type="submit" className={buttonClass(gmailReady ? "secondary" : "primary")}>
                    Connect a test mailbox (dev)
                  </button>
                </form>
              )}
            </div>
          )}
        </Card>
      </section>

      {/* 4. Sending + hybrid threshold (fallback when no mailbox is connected) */}
      <section className="space-y-3">
        <SectionTitle>Sending {mailbox ? "(fallback)" : ""}</SectionTitle>
        <Card>
          {mailbox ? (
            <p role="status" className="rounded-lg bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-900">
              Sending through your connected mailbox ({mailbox.email}). The Resend settings below are only used if you
              disconnect it.
            </p>
          ) : ready.ok ? (
            <p role="status" className="rounded-lg bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-900">
              Ready to send from your own domain.
            </p>
          ) : (
            <div role="alert" className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <p className="font-semibold">Not ready to send. Still missing:</p>
              <ul className="mt-1 list-disc pl-5">
                {ready.missing.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </div>
          )}

          {dev && (
            <p className="mt-3 rounded-lg bg-sky-50 px-4 py-3 text-sm text-sky-900">
              Dev mode: no key needed — outreach lands in your{" "}
              <Link href="/dashboard/outbox" className="font-semibold underline">
                Email outbox
              </Link>
              .
            </p>
          )}

          <p className="mt-4 text-sm text-slate-600">
            Cold email only ever leaves through your own Resend key and your own verified domain.
            There is no shared ScoutNet sending domain — your reputation is yours to build and protect.
          </p>

          <form action={updateSending} className="mt-5 space-y-4">
            <div>
              <label htmlFor="fromAddr" className={LABEL}>
                From address
              </label>
              <input id="fromAddr" name="fromAddr" type="text" maxLength={200} placeholder="Dana at Acme <dana@myagency.com>" defaultValue={profile?.fromAddr ?? ""} className={INPUT} />
              <p className={HELP}>An address on a domain you&rsquo;ve verified in Resend.</p>
            </div>
            <div>
              <label htmlFor="replyTo" className={LABEL}>
                Reply-to
              </label>
              <input id="replyTo" name="replyTo" type="email" maxLength={200} placeholder={account.email} defaultValue={profile?.replyTo ?? ""} className={INPUT} />
              <p className={HELP}>Falls back to your login address until verified.</p>
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <label htmlFor="resendKey" className={LABEL}>
                  Resend API key
                </label>
                {profile?.resendKeyEnc && <Badge tone="emerald">Key on file ✓</Badge>}
              </div>
              <input id="resendKey" name="resendKey" type="password" maxLength={200} autoComplete="off" placeholder="re_… — stored encrypted, never shown again" className={INPUT} />
              <p className={HELP}>Leave empty to keep your current key.</p>
              {profile?.resendKeyEnc && (
                <label className="mt-2 flex w-fit cursor-pointer items-center gap-2 text-sm font-medium text-slate-700">
                  <input type="checkbox" name="clearKey" value="1" className="h-4 w-4 cursor-pointer rounded border-slate-300 accent-sky-600" />
                  Remove stored key
                </label>
              )}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="autoSendThreshold" className={LABEL}>
                  Auto-send threshold
                </label>
                <input id="autoSendThreshold" name="autoSendThreshold" type="number" min={0} max={100} defaultValue={profile?.autoSendThreshold ?? 80} className={`${INPUT} sm:max-w-40`} />
                <p className={HELP}>Leads scoring ≥ this auto-send. Everything below waits for your review. (Hybrid mode.)</p>
              </div>
              <div>
                <label htmlFor="dailyCap" className={LABEL}>
                  Daily send cap
                </label>
                <input id="dailyCap" name="dailyCap" type="number" min={1} max={200} defaultValue={profile?.dailyCap ?? 25} className={`${INPUT} sm:max-w-40`} />
                <p className={HELP}>Your target volume. The warm-up ramp climbs to it automatically.</p>
              </div>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  name="followupsEnabled"
                  value="1"
                  defaultChecked={profile?.followupsEnabled ?? true}
                  className="mt-0.5 h-4 w-4 cursor-pointer rounded border-slate-300 accent-sky-600"
                />
                <span className="text-sm">
                  <span className="font-medium text-slate-800">Send follow-ups</span>
                  <span className="block text-xs text-slate-500">
                    A sent lead that doesn&rsquo;t reply gets a gentle bump, then a final note (3 and 5 days out),
                    then the thread closes itself. Marking a lead replied/won/lost stops it instantly.
                  </span>
                </span>
              </label>
            </div>
            <button type="submit" className={buttonClass("primary")}>
              Save sending settings
            </button>
          </form>

          {profile && (
            <div className="mt-5 rounded-lg border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-center justify-between gap-3">
                <span className={LABEL}>Warm-up</span>
                {inWarmup(profile) ? (
                  <Badge tone="amber">Ramping</Badge>
                ) : profile.warmupStartedAt ? (
                  <Badge tone="emerald">At full volume</Badge>
                ) : (
                  <Badge tone="slate">Starts on first send</Badge>
                )}
              </div>
              <p className="mt-2 text-sm text-slate-600">
                Today&rsquo;s cap is <strong className="text-slate-900">{effectiveDailyCap(profile)}</strong> of your {profile.dailyCap} target.{" "}
                {profile.warmupStartedAt
                  ? inWarmup(profile)
                    ? "It rises a little each day — new domains that jump to full volume get filtered as spam."
                    : "Your domain has finished warming up."
                  : "The ramp begins the moment your first outreach email goes out."}
              </p>
            </div>
          )}
        </Card>
      </section>

      {/* 4. Inbox deliverability */}
      <section className="space-y-3">
        <SectionTitle>Inbox deliverability</SectionTitle>
        <Card>
          <p className="text-sm text-slate-600">
            Whether your mail lands in the inbox or spam comes down to three DNS records:{" "}
            <strong>SPF</strong>, <strong>DKIM</strong>, and <strong>DMARC</strong>. Run the check below before you
            send for real. Every email also carries a one-click{" "}
            <code className="rounded bg-slate-100 px-1 text-xs">List-Unsubscribe</code> header.
          </p>

          {authChecked === "1" && (
            <p role="status" className="mt-4 rounded-lg bg-sky-50 px-4 py-3 text-sm text-sky-900">
              Deliverability check complete.
            </p>
          )}
          {authError && (
            <p role="alert" className="mt-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900">
              {authError.slice(0, 200)}
            </p>
          )}

          {profile?.authCheck ? (
            <div className="mt-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-display text-sm font-semibold text-slate-900">{profile.authCheck.domain}</p>
                  <p className="text-xs text-slate-500">Checked {new Date(profile.authCheck.checkedAt).toLocaleString()}</p>
                </div>
                <span
                  className={`font-display text-2xl font-bold ${
                    profile.authCheck.score >= 80 ? "text-emerald-700" : profile.authCheck.score >= 50 ? "text-accent-600" : "text-red-600"
                  }`}
                >
                  {profile.authCheck.score}
                  <span className="text-sm font-medium text-slate-400">/100</span>
                </span>
              </div>
              <ul className="mt-4 space-y-2">
                {(["spf", "dkim", "dmarc", "mx"] as const).map((k) => {
                  const part = profile.authCheck![k];
                  const tone = part.state === "pass" ? "bg-emerald-500" : part.state === "warn" ? "bg-accent-500" : "bg-red-500";
                  return (
                    <li key={k} className="flex items-start gap-3">
                      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${tone}`} aria-hidden />
                      <span className="text-sm">
                        <strong className="uppercase text-slate-800">{k}</strong> <span className="text-slate-600">— {part.detail}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : (
            <p className="mt-4 text-sm text-slate-500">
              Not checked yet. {ready.ok ? "" : "Add your from address first, then "}run the check to see how your domain scores.
            </p>
          )}

          <form action={runDeliverabilityCheck} className="mt-5">
            <button type="submit" className={buttonClass(profile?.authCheck ? "secondary" : "primary")}>
              {profile?.authCheck ? "Re-run deliverability check" : "Check my domain"}
            </button>
          </form>
        </Card>
      </section>

      {/* 5. Reply-to addresses */}
      <section className="space-y-3">
        <SectionTitle>Reply-to addresses</SectionTitle>
        <Card>
          <p className="text-sm text-slate-600">
            Replies only route to addresses you&rsquo;ve confirmed. Your login address is verified
            automatically the first time you sign in.
          </p>

          {addresses.length === 0 ? (
            <p className="mt-4 text-sm text-slate-500">No addresses yet — your login address is added automatically when you sign in.</p>
          ) : (
            <ul className="mt-4 divide-y divide-slate-100">
              {addresses.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-3 py-3">
                  <span className="break-all text-sm text-slate-800">{a.email.slice(0, 200)}</span>
                  {a.verified ? <Badge tone="emerald">Verified</Badge> : <Badge tone="amber">Pending</Badge>}
                </li>
              ))}
            </ul>
          )}

          <form action={addVerifyAddress} className="mt-5 flex flex-wrap items-end gap-3">
            <div className="min-w-64 flex-1">
              <label htmlFor="verifyEmail" className={LABEL}>
                Add another address
              </label>
              <input id="verifyEmail" name="email" type="email" required maxLength={200} placeholder="inbox@myagency.com" className={INPUT} />
            </div>
            <button type="submit" className={buttonClass("primary")}>
              Send confirmation
            </button>
          </form>
        </Card>
      </section>
    </div>
  );
}
