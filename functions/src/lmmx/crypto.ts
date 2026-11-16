import * as crypto from "crypto";
import { LMMX_FIELD_KEY, LMMX_OTP_PEPPER, LMMX_PEPPER, LMMX_QUOTE_KEY } from "./config";

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const sha256 = (s: string): string => crypto.createHash("sha256").update(s).digest("hex");
const hmac = (key: string, msg: string): string => crypto.createHmac("sha256", key).update(msg).digest("hex");

/** Keyed fingerprint for matching (phone, id, acct, name, contact). The value is normalised by the caller. */
export const H = (label: "phone" | "id" | "acct" | "name" | "contact", value: string): string => hmac(LMMX_PEPPER.value(), `${label}|${value}`);
/** Name normalisation for matching: lowercase, no punctuation or honorifics, single spaces. */
export const normName = (s: string): string =>
  s.toLowerCase().replace(/\b(mr|mrs|ms|miss|dr|prof|eng|hon|rev|sir|madam)\b\.?/g, " ").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
export const acctKey = (channel: string, bankCode: string | undefined, account: string): string => H("acct", `${channel}|${bankCode ?? ""}|${account.replace(/\D/g, "")}`);

export const safeEq = (a: unknown, b: unknown): boolean => {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
};
export const randId = (prefix: string, n = 10): string => {
  const b = crypto.randomBytes(n);
  let s = ""; for (let i = 0; i < n; i++) s += B32[b[i] % 32];
  return prefix + s;
};
export const code4 = (): string => String(crypto.randomInt(0, 10_000)).padStart(4, "0");
/** OTP/cancel code hash bound to its record and to the exact terms it approves. */
export const codeHash = (id: string, code: string, payloadHash: string): string => hmac(LMMX_OTP_PEPPER.value(), `otp|${id}|${code}|${payloadHash}`);

// AES-256-GCM field encryption: v1.<iv>.<tag>.<ciphertext> (base64url). The key is 32 bytes, base64, from the secret bundle.
const key = (): Buffer => { const k = Buffer.from(LMMX_FIELD_KEY.value(), "base64"); if (k.length !== 32) throw new Error("LMMX_FIELD_KEY must be 32 bytes (base64)"); return k; };
export function enc(plain: string): string {
  const iv = crypto.randomBytes(12); const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}
export function dec(token: string): string {
  const [v, iv, tag, ct] = String(token).split(".");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("bad ciphertext");
  const d = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url")); d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}
export const encJson = (o: unknown): string => enc(JSON.stringify(o));
export const decJson = <T>(t: string): T => JSON.parse(dec(t)) as T;

/** Signed, short-lived tokens (quotes, recipient reuse). Format: base64url(json).hexsig. */
export function signToken(label: string, body: Record<string, unknown>): string {
  const p = Buffer.from(JSON.stringify(body)).toString("base64url");
  return `${p}.${hmac(LMMX_QUOTE_KEY.value(), `${label}|${p}`)}`;
}
export function readToken<T>(label: string, token: unknown): T | null {
  if (typeof token !== "string") return null;
  const [p, sig] = token.split(".");
  if (!p || !sig || !safeEq(sig, hmac(LMMX_QUOTE_KEY.value(), `${label}|${p}`))) return null;
  try { return JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as T; } catch { return null; }
}
export const hmacHex = hmac;
