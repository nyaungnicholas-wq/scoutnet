import { NextRequest, NextResponse } from "next/server";
import { requestMagicLink } from "@/lib/auth";

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request" }, { status: 400 });
  }
  const email =
    typeof body === "object" && body !== null
      ? String((body as Record<string, unknown>).email ?? "")
      : "";
  const result = await requestMagicLink(email, req.nextUrl.origin);
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
