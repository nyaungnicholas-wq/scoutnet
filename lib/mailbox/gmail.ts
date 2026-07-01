import { redactEmails } from "@/lib/crypto";
import type { MailboxSendResult, OutgoingMail, ReplySignal } from "@/lib/mailbox/types";

/* Gmail connector. We deliberately request only `gmail.send` + `gmail.metadata`:
   send is enough to deliver cold email from the owner's own mailbox, and
   metadata lets us list inbox messages and read their headers (From/Subject)
   to detect that a reply landed on a thread — WITHOUT body access. Avoiding the
   restricted body scopes keeps the app out of Google's CASA security audit.

   This is normal server-side app code (not a deterministic workflow script), so
   real network + wall-clock are fine here. exchangeCode/refreshAccessToken throw
   typed Errors on failure; the index.ts caller catches and degrades gracefully. */

export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.metadata",
];

const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GMAIL_PROFILE_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
const GMAIL_SEND_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const GMAIL_LIST_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/messages";

/** True only when both halves of the OAuth client are present. */
export function googleConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

/** Build the consent-screen URL. `offline` + `prompt=consent` forces a refresh
    token on every grant; `include_granted_scopes` keeps prior grants intact. */
export function googleAuthUrl(state: string, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID ?? "",
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GMAIL_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
}

/** Trade the authorization code for tokens, then resolve the mailbox address
    from the Gmail profile. Throws on any non-2xx so the callback can redirect to
    an error state. */
export async function exchangeCode(
  code: string,
  redirectUri: string
): Promise<{ email: string; accessToken: string; refreshToken: string; expiresAt: Date; scopes: string }> {
  const tokenRes = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }).toString(),
    signal: AbortSignal.timeout(8000),
  });
  if (!tokenRes.ok) {
    throw new Error(`[gmail] token exchange failed (${tokenRes.status}): ${redactEmails((await tokenRes.text()).slice(0, 300))}`);
  }
  const token = (await tokenRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!token.access_token || !token.refresh_token) {
    /* No refresh token usually means the user previously granted and Google
       skipped re-issuing it — prompt=consent above is meant to prevent that. */
    throw new Error("[gmail] token response missing access or refresh token");
  }
  const expiresAt = new Date(Date.now() + (token.expires_in ?? 3600) * 1000);

  const profileRes = await fetch(GMAIL_PROFILE_ENDPOINT, {
    headers: { Authorization: `Bearer ${token.access_token}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!profileRes.ok) {
    throw new Error(`[gmail] profile lookup failed (${profileRes.status}): ${redactEmails((await profileRes.text()).slice(0, 300))}`);
  }
  const profile = (await profileRes.json()) as { emailAddress?: string };
  if (!profile.emailAddress) {
    throw new Error("[gmail] profile response missing emailAddress");
  }

  return {
    email: profile.emailAddress,
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt,
    scopes: token.scope ?? GMAIL_SCOPES.join(" "),
  };
}

/** Mint a fresh access token from a stored refresh token. Throws on failure so
    the caller can flip the connection to "reauth_required". */
export async function refreshAccessToken(
  refreshToken: string
): Promise<{ accessToken: string; expiresAt: Date }> {
  const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      grant_type: "refresh_token",
    }).toString(),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    throw new Error(`[gmail] token refresh failed (${res.status}): ${redactEmails((await res.text()).slice(0, 300))}`);
  }
  const token = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!token.access_token) {
    throw new Error("[gmail] refresh response missing access token");
  }
  return {
    accessToken: token.access_token,
    expiresAt: new Date(Date.now() + (token.expires_in ?? 3600) * 1000),
  };
}

/** Base64url, no padding. */
function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** RFC 5322 message → base64url, the shape Gmail's `messages.send` wants in its
    `raw` field. From/To/Subject/Reply-To plus any extra headers (incl.
    List-Unsubscribe), a blank line, then the body. */
export function buildRawMessage(mail: OutgoingMail): string {
  const headers: Array<[string, string]> = [
    ["From", mail.from],
    ["To", mail.to],
    ["Subject", mail.subject],
  ];
  if (mail.replyTo) headers.push(["Reply-To", mail.replyTo]);
  for (const [k, v] of Object.entries(mail.headers ?? {})) {
    headers.push([k, v]);
  }
  headers.push(["MIME-Version", "1.0"]);
  headers.push(["Content-Type", 'text/plain; charset="UTF-8"']);

  const headerLines = headers.map(([k, v]) => `${k}: ${v}`).join("\r\n");
  const message = `${headerLines}\r\n\r\n${mail.body}`;
  return base64url(message);
}

/** Send a prepared raw message. Never throws — non-2xx maps to {ok:false,detail}
    so the send path can record the failure and move on. */
export async function gmailSend(accessToken: string, raw: string): Promise<MailboxSendResult> {
  try {
    const res = await fetch(GMAIL_SEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      return { ok: false, detail: `Gmail ${res.status}: ${redactEmails((await res.text()).slice(0, 300))}` };
    }
    const sent = (await res.json()) as { id?: string; threadId?: string };
    return { ok: true, threadId: sent.threadId, messageId: sent.id };
  } catch (err) {
    return { ok: false, detail: redactEmails(String(err)) };
  }
}

/** Detect inbound replies. The metadata scope permits messages.list and a
    metadata-format get (headers only) — it canNOT read message bodies, and we
    don't need to: all we want is to know a reply landed on a thread and who from.
    Never throws — any failure yields an empty list so the poller degrades. */
export async function gmailListReplies(accessToken: string): Promise<ReplySignal[]> {
  try {
    const listUrl = new URL(GMAIL_LIST_ENDPOINT);
    listUrl.searchParams.set("q", "in:inbox newer_than:2d");
    const listRes = await fetch(listUrl.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!listRes.ok) return [];
    const list = (await listRes.json()) as { messages?: Array<{ id?: string; threadId?: string }> };
    const messages = list.messages ?? [];

    const signals: ReplySignal[] = [];
    for (const m of messages) {
      if (!m.id) continue;
      /* metadata format with metadataHeaders=From: headers only, no body. */
      const getUrl = new URL(`${GMAIL_LIST_ENDPOINT}/${m.id}`);
      getUrl.searchParams.set("format", "metadata");
      getUrl.searchParams.set("metadataHeaders", "From");
      const getRes = await fetch(getUrl.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(8000),
      });
      if (!getRes.ok) continue;
      const msg = (await getRes.json()) as {
        threadId?: string;
        payload?: { headers?: Array<{ name?: string; value?: string }> };
      };
      const threadId = msg.threadId ?? m.threadId;
      if (!threadId) continue;
      const fromHeader = msg.payload?.headers?.find((h) => h.name?.toLowerCase() === "from")?.value ?? "";
      const fromEmail = parseFromEmail(fromHeader);
      signals.push({ threadId, fromEmail });
    }
    return signals;
  } catch {
    return [];
  }
}

/** Pull the bare address out of a From header like `Dana <dana@acme.com>`. */
function parseFromEmail(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim().toLowerCase();
}
