import { and, desc, eq } from "drizzle-orm";
import { mailboxConnections } from "@/db/schema";
import { decryptSecret, encryptSecret, redactEmails } from "@/lib/crypto";
import type { Db } from "@/lib/db";
import { buildRawMessage, gmailSend, refreshAccessToken } from "@/lib/mailbox/gmail";
import { mockSend } from "@/lib/mailbox/mock";
import type { MailboxConn, MailboxSendResult, OutgoingMail } from "@/lib/mailbox/types";

export type {
  MailboxConn,
  MailboxSendResult,
  OutgoingMail,
  ReplySignal,
} from "@/lib/mailbox/types";

/** Newest connected mailbox for the account, or null. */
export async function getActiveMailbox(db: Db, accountId: string): Promise<MailboxConn | null> {
  const [row] = await db
    .select()
    .from(mailboxConnections)
    .where(and(eq(mailboxConnections.accountId, accountId), eq(mailboxConnections.status, "connected")))
    .orderBy(desc(mailboxConnections.createdAt))
    .limit(1);
  return row ?? null;
}

export async function hasConnectedMailbox(db: Db, accountId: string): Promise<boolean> {
  return (await getActiveMailbox(db, accountId)) !== null;
}

/* Refresh a couple of minutes early so a token that's about to lapse mid-request
   doesn't cause a spurious 401. */
const REFRESH_SKEW_MS = 60_000;

/** Return a usable Gmail access token for the connection, refreshing and
    persisting it if expired. Returns null (and flags reauth) on any failure, so
    both the send and the reply-poll paths handle a dead connection the same way. */
export async function getFreshAccessToken(db: Db, conn: MailboxConn): Promise<string | null> {
  let accessToken: string;
  try {
    if (!conn.accessTokenEnc) throw new Error("no stored access token");
    accessToken = decryptSecret(conn.accessTokenEnc);
  } catch (err) {
    await markReauth(db, conn.id);
    console.error(`[mailbox] could not decrypt access token: ${redactEmails(String(err))}`);
    return null;
  }

  const expired =
    !conn.tokenExpiresAt || conn.tokenExpiresAt.getTime() - REFRESH_SKEW_MS <= Date.now();
  if (!expired) return accessToken;

  try {
    if (!conn.refreshTokenEnc) throw new Error("no stored refresh token");
    const refreshToken = decryptSecret(conn.refreshTokenEnc);
    const refreshed = await refreshAccessToken(refreshToken);
    await db
      .update(mailboxConnections)
      .set({ accessTokenEnc: encryptSecret(refreshed.accessToken), tokenExpiresAt: refreshed.expiresAt })
      .where(eq(mailboxConnections.id, conn.id));
    return refreshed.accessToken;
  } catch (err) {
    await markReauth(db, conn.id);
    console.error(`[mailbox] token refresh failed: ${redactEmails(String(err))}`);
    return null;
  }
}

/** Send through whichever provider the connection is. Never throws — every
    failure path (decrypt, refresh, API error) returns {ok:false,detail}, and
    auth failures flip the connection to "reauth_required" so the owner is
    prompted to reconnect rather than the dispatcher silently retrying forever. */
export async function sendViaMailbox(
  db: Db,
  conn: MailboxConn,
  mail: OutgoingMail
): Promise<MailboxSendResult> {
  if (conn.provider === "mock") {
    return mockSend(db, conn.accountId, mail);
  }

  // provider === "gmail"
  const accessToken = await getFreshAccessToken(db, conn);
  if (!accessToken) return { ok: false, detail: "[mailbox] no usable access token (reconnect needed)" };

  try {
    const raw = buildRawMessage(mail);
    return await gmailSend(accessToken, raw);
  } catch (err) {
    return { ok: false, detail: `[mailbox] gmail send failed: ${redactEmails(String(err))}` };
  }
}

async function markReauth(db: Db, connId: string): Promise<void> {
  try {
    await db
      .update(mailboxConnections)
      .set({ status: "reauth_required" })
      .where(eq(mailboxConnections.id, connId));
  } catch (err) {
    console.error("[mailbox] failed to flag reauth_required:", redactEmails(String(err)));
  }
}
