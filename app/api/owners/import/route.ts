import { NextRequest, NextResponse } from "next/server";
import { getSessionAccount } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { applyOwnerPaste } from "@/lib/agent/owners";

/* Programmatic owner-import: POST a body of "Business | FirstName" lines (text or
   {paste} JSON) for the signed-in account. Same matcher as the dashboard's
   bulk-paste box. Session-scoped — never trusts an account id from the request. */
export async function POST(req: NextRequest) {
  const account = await getSessionAccount();
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const ct = req.headers.get("content-type") ?? "";
  let paste = "";
  if (ct.includes("application/json")) {
    const body = (await req.json().catch(() => ({}))) as { paste?: unknown };
    paste = typeof body.paste === "string" ? body.paste : "";
  } else {
    paste = await req.text();
  }
  if (!paste.trim()) return NextResponse.json({ error: "empty" }, { status: 400 });

  const db = await getDb();
  const { matched, unmatched } = await applyOwnerPaste(db, account.id, paste.slice(0, 40000));
  return NextResponse.json({ ok: true, matched, unmatched });
}
