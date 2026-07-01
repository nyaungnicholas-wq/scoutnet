import { NextRequest, NextResponse } from "next/server";
import { confirmAddressToken } from "@/lib/addresses";
import { getDb } from "@/lib/db";

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const db = await getDb();
  const ok = token ? await confirmAddressToken(db, token) : false;
  return NextResponse.redirect(
    new URL(`/dashboard/settings?verified=${ok ? "1" : "0"}`, req.nextUrl)
  );
}
