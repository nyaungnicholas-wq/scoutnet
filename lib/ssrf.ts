/* SSRF guard for every user-supplied URL ScoutNet fetches server-side
   (today: the onboarding site analyzer). */

/** User-supplied URLs may only point at public https hosts — never
    loopback, link-local, or private ranges (SSRF). DNS-rebinding is out of MVP
    scope; this blocks direct and literal-IP targeting. */
export function validateUrl(raw: string): { ok: true; url: string } | { ok: false; reason: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: "not a valid absolute URL" };
  }
  if (u.protocol !== "https:") return { ok: false, reason: "must be https" };
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal"))
    return { ok: false, reason: "internal hostnames are not allowed" };
  if (host.includes(":")) return { ok: false, reason: "IPv6 literals are not allowed" };
  /* Require a real domain: the last label must be an alphabetic TLD. This rejects
     every IP-literal form in one stroke — dotted-quad (127.0.0.1), decimal
     (2130706433), hex (0x7f000001), octal (0177.0.0.1), single-label intranet —
     so obfuscated private-IP SSRF can't slip past the dotted-quad check below. */
  const lastLabel = host.split(".").pop() ?? "";
  if (!/^[a-z]{2,}$/.test(lastLabel))
    return { ok: false, reason: "must be a domain name, not an IP address" };
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    )
      return { ok: false, reason: "private or reserved IP ranges are not allowed" };
  }
  return { ok: true, url: u.href };
}
