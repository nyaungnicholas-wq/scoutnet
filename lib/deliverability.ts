import { resolveTxt, resolveCname, resolveMx } from "node:dns/promises";
import type { AuthCheck } from "@/db/schema";

/* Deterministic, no-account DNS preflight for a sending domain. Inbox placement
   ultimately rests on three records the OWNER must publish in DNS: SPF, DKIM, and
   DMARC. We can't send their mail for them, but we can check — honestly — whether
   the domain is actually set up to authenticate, and tell them exactly what's
   missing. Resend (the send transport) signs DKIM under the `resend._domainkey`
   selector and asks senders to publish an SPF include + a DMARC policy. */

const RESEND_DKIM_SELECTOR = "resend._domainkey";

/** Extract the bare domain from a From header value like
    `Dana at Acme <dana@acme.com>` or `dana@acme.com`. */
export function domainFromAddress(fromAddr: string): string | null {
  const m = fromAddr.match(/<([^>]+)>/);
  const addr = (m ? m[1] : fromAddr).trim();
  const at = addr.lastIndexOf("@");
  if (at < 0) return null;
  const domain = addr
    .slice(at + 1)
    .trim()
    .toLowerCase();
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) ? domain : null;
}

async function txtRecords(name: string): Promise<string[]> {
  try {
    const records = await resolveTxt(name);
    return records.map((chunks) => chunks.join(""));
  } catch {
    return [];
  }
}

type Part = AuthCheck["spf"];

async function checkSpf(domain: string): Promise<Part> {
  const txt = await txtRecords(domain);
  const spf = txt.find((r) => /^v=spf1/i.test(r.trim()));
  if (!spf) return { state: "fail", detail: "No SPF record. Add a TXT record starting with “v=spf1”." };
  if (/-all/.test(spf)) return { state: "pass", detail: "SPF present with a strict “-all” policy." };
  if (/~all/.test(spf)) return { state: "warn", detail: "SPF present but soft-fail (“~all”). Tighten to “-all” once you trust it." };
  return { state: "warn", detail: "SPF present but no explicit “-all”/“~all” qualifier." };
}

async function checkDkim(domain: string): Promise<Part> {
  /* DKIM lives at <selector>._domainkey.<domain> as a CNAME (Resend) or TXT. */
  try {
    const cname = await resolveCname(`${RESEND_DKIM_SELECTOR}.${domain}`);
    if (cname.length) return { state: "pass", detail: `DKIM selector “${RESEND_DKIM_SELECTOR}” resolves (CNAME → ${cname[0]}).` };
  } catch {
    /* fall through to TXT */
  }
  const txt = await txtRecords(`${RESEND_DKIM_SELECTOR}.${domain}`);
  if (txt.some((r) => /p=|v=DKIM1/i.test(r))) return { state: "pass", detail: `DKIM key published at “${RESEND_DKIM_SELECTOR}”.` };
  return {
    state: "fail",
    detail: `No DKIM record at “${RESEND_DKIM_SELECTOR}.${domain}”. Add the DKIM record from your Resend domain setup.`,
  };
}

async function checkDmarc(domain: string): Promise<Part> {
  const txt = await txtRecords(`_dmarc.${domain}`);
  const dmarc = txt.find((r) => /v=DMARC1/i.test(r));
  if (!dmarc) return { state: "fail", detail: "No DMARC record. Add a TXT record at “_dmarc” starting with “v=DMARC1”." };
  const policy = dmarc.match(/p=\s*(none|quarantine|reject)/i)?.[1]?.toLowerCase();
  if (policy === "reject" || policy === "quarantine") return { state: "pass", detail: `DMARC enforced (p=${policy}).` };
  return { state: "warn", detail: "DMARC present but p=none (monitor-only). Move to p=quarantine once aligned." };
}

async function checkMx(domain: string): Promise<Part> {
  try {
    const mx = await resolveMx(domain);
    if (mx.length) return { state: "pass", detail: `Domain receives mail (${mx.length} MX record${mx.length === 1 ? "" : "s"}).` };
  } catch {
    /* no MX */
  }
  return { state: "warn", detail: "No MX record. Not required to send, but a domain that can't receive replies looks less trustworthy." };
}

const WEIGHTS = { spf: 25, dkim: 35, dmarc: 30, mx: 10 };
const SCORE = { pass: 1, warn: 0.5, fail: 0 };

/** Run the full preflight. Never throws — DNS failures degrade to "fail"/"warn"
    so a placeholder domain just reports honestly that nothing is set up. */
export async function checkDomainAuth(fromAddr: string): Promise<AuthCheck | { error: string }> {
  const domain = domainFromAddress(fromAddr);
  if (!domain) return { error: "Set a from address on your own domain first." };

  const [spf, dkim, dmarc, mx] = await Promise.all([
    checkSpf(domain),
    checkDkim(domain),
    checkDmarc(domain),
    checkMx(domain),
  ]);

  const score = Math.round(
    SCORE[spf.state] * WEIGHTS.spf +
      SCORE[dkim.state] * WEIGHTS.dkim +
      SCORE[dmarc.state] * WEIGHTS.dmarc +
      SCORE[mx.state] * WEIGHTS.mx
  );

  return {
    domain,
    checkedAt: new Date().toISOString(),
    spf,
    dkim,
    dmarc,
    mx,
    score,
  };
}
