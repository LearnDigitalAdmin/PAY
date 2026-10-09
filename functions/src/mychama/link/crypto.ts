// Small crypto helpers for the linking flow. All keyed with MYCHAMA_ID_PEPPER (bind that secret on any
// function using these). Nothing here logs codes, keys, phones or ID numbers.
import * as crypto from "crypto";
import { MYCHAMA_ID_PEPPER } from "../config";

export function hmacHex(label: string, value: string): string {
  return crypto.createHmac("sha256", MYCHAMA_ID_PEPPER.value()).update(`${label}:${value}`).digest("hex");
}

/** Opaque id for "this user + this phone group". Stable, so requestCode can recompute it statelessly. */
export const pendingIdFor = (uid: string, phoneKey: string): string => hmacHex("pd", `${uid}:${phoneKey}`).slice(0, 24);

/** One live challenge per (user, pending group). */
export const challengeIdFor = (uid: string, pendingId: string): string => hmacHex("ch", `${uid}:${pendingId}`).slice(0, 32);

export const hashCode = (challengeId: string, code: string): string => hmacHex("cd", `${challengeId}:${code}`);

/** Opaque short id used in counter doc names (keeps raw uids/phone keys out of doc ids). */
export const counterId = (kind: "u" | "p", value: string): string => hmacHex(`lim${kind}`, value).slice(0, 24);

export function randomCode(length: number): string {
  const max = 10 ** length;
  return String(crypto.randomInt(0, max)).padStart(length, "0");
}

export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ab.length === bb.length && ab.length > 0 && crypto.timingSafeEqual(ab, bb);
}
