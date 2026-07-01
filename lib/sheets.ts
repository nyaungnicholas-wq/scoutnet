import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { desc, eq } from "drizzle-orm";
import { leads } from "@/db/schema";
import type { Db } from "@/lib/db";

/* Live Google Sheet sync via a Google Apps Script web-app webhook — no OAuth, no
   service account. The owner deploys a tiny script bound to their sheet (doPost →
   clear + write rows) and pastes its URL here; ScoutNet POSTs the full, ranked
   lead list to it after every discovery run and on a manual "Sync now". The URL
   lives in a .data file (settable in the UI, no env restart, no schema change). */

const WEBHOOK_FILE = path.join(process.cwd(), ".data", "sheet-webhook.txt");

/** The configured webhook URL — env wins, else the saved file, else "". */
export async function getSheetWebhook(): Promise<string> {
  if (process.env.SHEETS_WEBHOOK_URL) return process.env.SHEETS_WEBHOOK_URL.trim();
  try {
    return (await readFile(WEBHOOK_FILE, "utf8")).trim();
  } catch {
    return "";
  }
}

export async function sheetConfigured(): Promise<boolean> {
  return Boolean(await getSheetWebhook());
}

/** Save (or clear) the webhook URL. SSRF-guarded: must be an https Apps Script URL
    on a Google domain, so a saved URL can never point the server at an internal
    host. Returns an error message instead of throwing. */
export async function setSheetWebhook(rawUrl: string): Promise<{ ok: boolean; error?: string }> {
  const url = (rawUrl ?? "").trim();
  await mkdir(path.dirname(WEBHOOK_FILE), { recursive: true });
  if (!url) {
    await writeFile(WEBHOOK_FILE, "", "utf8").catch(() => {});
    return { ok: true };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "That doesn't look like a valid URL." };
  }
  if (parsed.protocol !== "https:") return { ok: false, error: "The URL must start with https://." };
  if (!/(^|\.)google\.com$|(^|\.)googleusercontent\.com$/i.test(parsed.hostname)) {
    return { ok: false, error: "Must be a Google Apps Script URL (script.google.com/macros/…/exec)." };
  }
  await writeFile(WEBHOOK_FILE, url, "utf8");
  return { ok: true };
}

const HEADER = [
  "Business",
  "Owner",
  "Phone",
  "Score",
  "Opportunity",
  "Reviews",
  "Rating",
  "Has website",
  "Website",
  "Email",
  "Address",
  "Area",
  "Status",
  "Maps",
];

type LeadRow = typeof leads.$inferSelect;

function rowFor(l: LeadRow): (string | number)[] {
  const s = l.signals;
  const opp =
    l.primaryGap === "web" ? "Needs a website" : l.primaryGap === "marketing" ? "Needs marketing" : l.primaryGap === "both" ? "Website + marketing" : "—";
  return [
    l.businessName,
    l.contactFirstName,
    l.phone,
    l.score,
    opp,
    s?.reviewCount ?? "",
    s?.rating ?? "",
    s?.hasWebsite === false ? "no" : s?.hasWebsite === true ? "yes" : "",
    l.website,
    l.email,
    l.address,
    l.location,
    l.status,
    l.mapsUrl,
  ];
}

/** Push the account's full, ranked lead list to the connected sheet (replace mode).
    No-ops cleanly when no webhook is set, and never throws into the caller. */
export async function pushAllLeads(db: Db, accountId: string): Promise<{ ok: boolean; count: number; detail?: string }> {
  const url = await getSheetWebhook();
  if (!url) return { ok: false, count: 0, detail: "no sheet connected" };

  const rows = await db.select().from(leads).where(eq(leads.accountId, accountId)).orderBy(desc(leads.score));
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "replace", header: HEADER, rows: rows.map(rowFor) }),
      signal: AbortSignal.timeout(15_000),
      // Apps Script web apps 302 to googleusercontent.com — follow it.
      redirect: "follow",
    });
    if (!res.ok) return { ok: false, count: rows.length, detail: `sheet returned ${res.status}` };
    return { ok: true, count: rows.length };
  } catch (err) {
    return { ok: false, count: rows.length, detail: String(err).slice(0, 140) };
  }
}

/** Fire-and-forget sync used after discovery so a run never blocks on the sheet. */
export async function syncSheetQuietly(db: Db, accountId: string): Promise<void> {
  try {
    if (await sheetConfigured()) await pushAllLeads(db, accountId);
  } catch {
    /* a sheet hiccup must never fail a discovery run */
  }
}
