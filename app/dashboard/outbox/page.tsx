import { desc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { outboxEmails } from "@/db/schema";
import { Badge, EmptyState } from "@/components/ui";
import { getSessionAccount } from "@/lib/auth";
import { getDb } from "@/lib/db";

export const metadata = { title: "Email outbox — ScoutNet" };

const KIND_TONE: Record<string, "sky" | "violet" | "slate" | "amber"> = {
  outreach: "sky",
  reply: "violet",
  "magic-link": "slate",
  verify: "slate",
  test: "amber",
};

export default async function OutboxPage() {
  const account = await getSessionAccount();
  if (!account) redirect("/signin");
  const db = await getDb();

  const rows = await db
    .select()
    .from(outboxEmails)
    .where(eq(outboxEmails.accountId, account.id))
    .orderBy(desc(outboxEmails.createdAt))
    .limit(100);

  const hasResendRows = rows.some((r) => r.sentVia === "resend");

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900">Email outbox</h1>
        <p className="mt-1 text-sm text-slate-600">
          Every email ScoutNet sends for your account. In dev — no Resend key required — messages
          land here instead of real inboxes, so you can test the whole loop without emailing
          anyone.
        </p>
      </div>

      {hasResendRows && (
        <p className="rounded-lg bg-sky-50 px-4 py-3 text-sm text-sky-900">
          Rows marked <span className="font-semibold">resend</span> went out to real inboxes
          through Resend. This page is the record, not the transport.
        </p>
      )}

      {rows.length === 0 ? (
        <EmptyState title="Nothing sent yet">
          This is where dev emails land: sign-in links, address confirmations, and every outreach
          step. Enroll a prospect and run a dispatch — the sends show up here.
        </EmptyState>
      ) : (
        <ul className="space-y-3">
          {rows.map((m) => (
            <li key={m.id} className="card-soft p-4">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Badge tone={KIND_TONE[m.kind] ?? "slate"}>{m.kind}</Badge>
                <span className="break-all text-sm text-slate-600">
                  {m.fromAddr.slice(0, 200)} → {m.toAddr.slice(0, 200)}
                </span>
                <span className="ml-auto text-xs text-slate-500">
                  {m.sentVia} · {m.createdAt.toLocaleString()}
                </span>
              </div>
              <p className="mt-2 font-semibold text-slate-900">{m.subject.slice(0, 200)}</p>
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-3 font-mono text-xs text-slate-700">
                {m.body}
              </pre>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
