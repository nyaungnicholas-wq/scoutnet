import { desc, eq } from "drizzle-orm";
import { leads } from "@/db/schema";
import { getSessionAccount } from "@/lib/auth";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

/* One-click lead export, laid out as a CALL SHEET — phone up front, the pitch
   angle next, then empty tracking columns to fill in as you dial. Opens straight
   into Google Sheets (File → Import) or Excel. UTF-8 BOM so accents/emoji survive. */

function cell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function opportunity(gap: string): string {
  switch (gap) {
    case "web":
      return "Needs a website";
    case "marketing":
      return "Needs marketing";
    case "both":
      return "Website + marketing";
    default:
      return "—";
  }
}

export async function GET() {
  const account = await getSessionAccount();
  if (!account) return new Response("Unauthorized", { status: 401 });

  const db = await getDb();
  const rows = await db.select().from(leads).where(eq(leads.accountId, account.id)).orderBy(desc(leads.score));

  const header = [
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
    // blank columns to track your calls:
    "Called?",
    "Reached owner?",
    "Interested?",
    "Notes",
    "Follow-up date",
  ];

  const lines = [header.map(cell).join(",")];
  for (const l of rows) {
    const s = l.signals;
    lines.push(
      [
        l.businessName,
        l.contactFirstName,
        l.phone,
        l.score,
        opportunity(l.primaryGap),
        s?.reviewCount ?? "",
        s?.rating ?? "",
        s?.hasWebsite === false ? "no" : s?.hasWebsite === true ? "yes" : "",
        l.website,
        l.email,
        l.address,
        l.location,
        l.status,
        l.mapsUrl,
        "",
        "",
        "",
        "",
        "",
      ]
        .map(cell)
        .join(",")
    );
  }

  const csv = "﻿" + lines.join("\r\n");
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="scoutnet-leads.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
