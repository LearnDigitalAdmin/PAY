import { HttpsError, FunctionsErrorCode } from "firebase-functions/v2/https";
import type { MyChamaErrorCode, MyChamaErrorDetails } from "./contract";

/** All MyChama callables throw through this so clients can switch on details.code. */
export function myChamaError(
  code: MyChamaErrorCode,
  message: string,
  http: FunctionsErrorCode = "failed-precondition",
  retryAfterSeconds?: number
): HttpsError {
  const details: MyChamaErrorDetails = { code, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) };
  return new HttpsError(http, message, details);
}

export const notImplemented = (what: string): HttpsError =>
  myChamaError("not_implemented", `${what} is not implemented yet.`, "unimplemented");
