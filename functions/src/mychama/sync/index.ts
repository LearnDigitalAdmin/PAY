// TRACK A — mychamaSync callable (see service.ts for the orchestration).
import { onCall, type CallableRequest } from "firebase-functions/v2/https";
import { REGION, MYCHAMA_ID_PEPPER } from "../config";
import { myChamaError } from "../errors";
import type { SyncReason, SyncRequest, SyncResponse } from "../contract";
import { resolveCaller } from "./identity";
import { runSyncFor } from "./service";

const REASONS: SyncReason[] = ["login", "reload", "manual"];

export const mychamaSync = onCall(
  { region: REGION, cors: true, maxInstances: 10, timeoutSeconds: 120, secrets: [MYCHAMA_ID_PEPPER] },
  async (req: CallableRequest<SyncRequest>): Promise<SyncResponse> => {
    if (!req.auth) throw myChamaError("unauthenticated", "Sign in required.", "unauthenticated");
    const reason = req.data?.reason;
    if (!reason || !REASONS.includes(reason)) throw myChamaError("invalid_target", "reason must be login, reload or manual.", "invalid-argument");
    const caller = await resolveCaller(req.auth);
    return runSyncFor(caller, reason, { force: req.data?.force === true });
  }
);
