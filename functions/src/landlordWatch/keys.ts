import * as crypto from "crypto";
import { MYCHAMA_ID_PEPPER } from "../mychama/config";

/** Keyed hash with a Landlord-Watch-specific label (the existing pepper, read-only use, domain-separated). */
export function lwHmac(label: string, value: string): string {
  return crypto.createHmac("sha256", MYCHAMA_ID_PEPPER.value()).update(`lw:${label}:${value}`).digest("hex");
}

export const randomHex = (bytes = 8): string => crypto.randomBytes(bytes).toString("hex");

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
