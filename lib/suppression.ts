import { and, eq } from "drizzle-orm";
import { suppressions } from "@/db/schema";
import { signToken, verifySignedToken } from "@/lib/crypto";
import type { Db } from "@/lib/db";
import { normalizeEmail } from "@/lib/addresses";

/* Unsubscribe links are stateless signed tokens: no DB row to issue, and acting
   on one is idempotent (insert-or-ignore into the suppression list). */
export function unsubToken(accountId: string, email: string): string {
  return signToken(`unsub:${accountId}:${normalizeEmail(email)}`);
}

export function parseUnsubToken(token: string): { accountId: string; email: string } | null {
  const payload = verifySignedToken(token);
  if (!payload || !payload.startsWith("unsub:")) return null;
  const rest = payload.slice("unsub:".length);
  const sep = rest.indexOf(":");
  if (sep <= 0) return null;
  return { accountId: rest.slice(0, sep), email: rest.slice(sep + 1) };
}

export async function isSuppressed(db: Db, accountId: string, email: string): Promise<boolean> {
  const rows = await db
    .select({ id: suppressions.id })
    .from(suppressions)
    .where(and(eq(suppressions.accountId, accountId), eq(suppressions.email, normalizeEmail(email))));
  return rows.length > 0;
}

export async function suppress(db: Db, accountId: string, email: string, reason = "unsubscribed"): Promise<void> {
  await db
    .insert(suppressions)
    .values({ accountId, email: normalizeEmail(email), reason })
    .onConflictDoNothing();
}
