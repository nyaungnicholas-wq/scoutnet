import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const DEV_SECRET = "scoutnet-dev-secret-do-not-use-in-production";

export function appSecret(): string {
  const s = process.env.APP_SECRET;
  if (s) return s;
  if (process.env.NODE_ENV === "production") {
    throw new Error("APP_SECRET must be set in production");
  }
  return DEV_SECRET;
}

/* HKDF rather than a bare hash: a weak APP_SECRET shouldn't hand an offline
   attacker a fast-bruteforce target for the encrypted sender keys. */
function aesKey(): Buffer {
  return Buffer.from(hkdfSync("sha256", appSecret(), "scoutnet-kdf-salt-v1", "scoutnet-aes-key-v1", 32));
}

export function sha256hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** AES-256-GCM, output "v1:" + base64(iv | authTag | ciphertext). */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", aesKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${Buffer.concat([iv, tag, ct]).toString("base64")}`;
}

export function decryptSecret(stored: string): string {
  if (!stored.startsWith("v1:")) throw new Error("Unknown secret format");
  const buf = Buffer.from(stored.slice(3), "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", aesKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** Redact email-shaped tokens before anything reaches retained logs. */
export function redactEmails(s: string): string {
  return s.replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "[email]");
}

/* Stateless signed tokens for links we don't need to store (unsubscribe):
   "base64url(payload).hmac". Tamper-evident, no DB row, idempotent on use. */
export function signToken(payload: string): string {
  const sig = createHmac("sha256", appSecret()).update(payload).digest("base64url");
  return `${Buffer.from(payload, "utf8").toString("base64url")}.${sig}`;
}

export function verifySignedToken(token: string): string | null {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payload = Buffer.from(token.slice(0, dot), "base64url").toString("utf8");
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", appSecret()).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return payload;
}
