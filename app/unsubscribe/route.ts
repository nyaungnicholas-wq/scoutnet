import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { parseUnsubToken, suppress } from "@/lib/suppression";

/* One-click unsubscribe. The actual suppression happens on POST, not GET, because
   email clients and security scanners pre-fetch GET links — a GET that suppressed
   immediately would unsubscribe people who never clicked. GET renders a one-button
   confirmation form that POSTs the same token. Stateless signed token →
   idempotent suppression insert. No auth — the recipient isn't a user. */

function page(title: string, inner: string, status: number): NextResponse {
  return new NextResponse(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribe</title><div style="font-family:system-ui,sans-serif;max-width:34rem;margin:14vh auto;padding:0 1.5rem;color:#1e293b"><h1>${title}</h1>${inner}<p style="margin-top:2rem;color:#94a3b8;font-size:.8rem">Secured by ScoutNet</p></div>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  if (!parseUnsubToken(token)) {
    return page("Link expired or invalid.", "<p>If you keep receiving emails, reply to one and ask to be removed.</p>", 400);
  }
  const escaped = token.replace(/"/g, "&quot;");
  return page(
    "Unsubscribe?",
    `<p>Click below to stop receiving these emails.</p><form method="post" action="/unsubscribe"><input type="hidden" name="token" value="${escaped}"><button type="submit" style="margin-top:1rem;padding:.7rem 1.4rem;font:inherit;font-weight:700;color:#fff;background:#0c4a6e;border:0;border-radius:.6rem;cursor:pointer">Unsubscribe</button></form>`,
    200
  );
}

export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  const token = String(form?.get("token") ?? req.nextUrl.searchParams.get("token") ?? "");
  const parsed = parseUnsubToken(token);
  if (!parsed) {
    return page("Link expired or invalid.", "<p>If you keep receiving emails, reply to one and ask to be removed.</p>", 400);
  }
  try {
    const db = await getDb();
    await suppress(db, parsed.accountId, parsed.email, "unsubscribed");
  } catch (err) {
    console.error("[unsubscribe] suppression failed:", err);
    return page(
      "Something went wrong on our end.",
      "<p>Please try again in a moment — your link is still valid.</p>",
      503
    );
  }
  return page("You're unsubscribed.", "<p>You won't receive any more outreach from this sender. You can close this tab.</p>", 200);
}
