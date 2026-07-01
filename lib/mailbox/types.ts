import type { mailboxConnections } from "@/db/schema";

/* Shared contracts for the mailbox connectors. A connector turns an
   OutgoingMail into a real send (Gmail API / dev outbox) and reports back the
   provider thread id so an inbound reply can be matched to the lead. */

export type OutgoingMail = {
  from: string;
  to: string;
  subject: string;
  body: string;
  replyTo?: string;
  /** Extra RFC 5322 headers (e.g. List-Unsubscribe) carried into the raw message. */
  headers?: Record<string, string>;
};

export type MailboxSendResult = {
  ok: boolean;
  threadId?: string;
  messageId?: string;
  detail?: string;
};

/** A reply landed on a thread. We learn this from metadata only (no body), so
    all we know is the thread it hit and who it came from. */
export type ReplySignal = {
  threadId: string;
  fromEmail: string;
};

/** The connected-mailbox row, as stored. */
export type MailboxConn = typeof mailboxConnections.$inferSelect;
