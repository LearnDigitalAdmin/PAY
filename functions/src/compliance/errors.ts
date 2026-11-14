import { HttpsError, type FunctionsErrorCode } from "firebase-functions/v2/https";

export type CrCode =
  | "CR_BAD_REQUEST" | "CR_NOT_FOUND" | "CR_NOT_ALLOWED" | "CR_NO_DATA" | "CR_STALE_DATA" | "CR_TOO_LARGE" | "CR_PAYMENT_FAILED" | "CR_UNAVAILABLE";

export class CrError extends Error {
  constructor(public readonly code: CrCode, message: string) { super(message); this.name = "CrError"; }
}
const HTTPS: Record<CrCode, FunctionsErrorCode> = {
  CR_BAD_REQUEST: "invalid-argument", CR_NOT_FOUND: "not-found", CR_NOT_ALLOWED: "permission-denied", CR_NO_DATA: "failed-precondition", CR_STALE_DATA: "failed-precondition",
  CR_TOO_LARGE: "invalid-argument", CR_PAYMENT_FAILED: "unavailable", CR_UNAVAILABLE: "internal",
};
export function toHttpsError(e: unknown): HttpsError {
  if (e instanceof CrError) return new HttpsError(HTTPS[e.code], e.message, { code: e.code });
  if (e instanceof HttpsError) return e;
  console.error("compliance report error:", e);
  return new HttpsError("internal", "Something went wrong. Please try again.", { code: "CR_UNAVAILABLE" });
}
export const toBotError = (e: unknown): { code: CrCode; message: string } =>
  e instanceof CrError ? { code: e.code, message: e.message } : (console.error("compliance report error:", e), { code: "CR_UNAVAILABLE", message: "Something went wrong. Please try again." });
