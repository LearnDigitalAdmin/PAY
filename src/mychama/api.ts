// Typed wrappers for the MyChama connector callables. OWNED BY P0 (frozen);
// Track C consumes these — never call httpsCallable("mychama...") directly.
import { httpsCallable } from "firebase/functions";
import { functions } from "../Firebase";
import {
  MYCHAMA_CALLABLES,
  MYCHAMA_PATHS,
  type MyChamaErrorCode,
  type SyncRequest, type SyncResponse,
  type RequestCodeRequest, type RequestCodeResponse,
  type VerifyCodeRequest, type VerifyCodeResponse,
  type PayInitiateRequest, type PayInitiateResponse,
} from "./contract";

const callable = <Req, Res>(name: string) => async (req: Req): Promise<Res> =>
  (await httpsCallable<Req, Res>(functions, name)(req)).data;

export const mychamaApi = {
  sync: callable<SyncRequest, SyncResponse>(MYCHAMA_CALLABLES.sync),
  requestCode: callable<RequestCodeRequest, RequestCodeResponse>(MYCHAMA_CALLABLES.requestCode),
  verifyCode: callable<VerifyCodeRequest, VerifyCodeResponse>(MYCHAMA_CALLABLES.verifyCode),
  payInitiate: callable<PayInitiateRequest, PayInitiateResponse>(MYCHAMA_CALLABLES.payInitiate),
};

/** Firestore doc the UI listens to (read-only for clients). */
export const mychamaSnapshotPath = (uid: string): string => MYCHAMA_PATHS.snapshot(uid);

/** Extract the contract error code from a callable failure, or null. */
export function mychamaErrorCode(err: unknown): MyChamaErrorCode | null {
  const code = (err as { details?: { code?: unknown } } | null)?.details?.code;
  return typeof code === "string" ? (code as MyChamaErrorCode) : null;
}
