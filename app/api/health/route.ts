import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

/* Uptime/readiness probe. Confirms the DB is reachable (and migrated). */
export async function GET() {
  try {
    const db = await getDb();
    const { sql } = await import("drizzle-orm");
    await db.execute(sql`SELECT 1`);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503 });
  }
}
