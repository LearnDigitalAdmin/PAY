// TRACK A — linking callables (SMS-code flow). Silent linking happens inside mychamaSync.
import { onCall, type CallableRequest } from "firebase-functions/v2/https";
import { REGION, MYCHAMA_ID_PEPPER } from "../config";
import { MYCHAMA_HP_SECRETS } from "../sms";
import { myChamaError } from "../errors";
import type { RequestCodeRequest, RequestCodeResponse, VerifyCodeRequest, VerifyCodeResponse } from "../contract";
import { resolveCaller } from "../sync/identity";
import { requestCode, verifyCode } from "./challenge";
import { runLinkPass } from "./engine";
import { runSyncFor } from "../sync/service";

export const mychamaLinkRequestCode = onCall(
  { region: REGION, cors: true, maxInstances: 10, secrets: [MYCHAMA_ID_PEPPER, ...MYCHAMA_HP_SECRETS] },
  async (req: CallableRequest<RequestCodeRequest>): Promise<RequestCodeResponse> => {
    if (!req.auth) throw myChamaError("unauthenticated", "Sign in required.", "unauthenticated");
    const caller = await resolveCaller(req.auth);
    return requestCode(caller, String(req.data?.pendingId || ""));
  }
);

export const mychamaLinkVerifyCode = onCall(
  { region: REGION, cors: true, maxInstances: 10, timeoutSeconds: 120, secrets: [MYCHAMA_ID_PEPPER] },
  async (req: CallableRequest<VerifyCodeRequest>): Promise<VerifyCodeResponse> => {
    if (!req.auth) throw myChamaError("unauthenticated", "Sign in required.", "unauthenticated");
    const caller = await resolveCaller(req.auth);
    const phoneKey = await verifyCode(caller.uid, String(req.data?.challengeId || ""), String(req.data?.code || ""));

    // Per-phone grant: only the chamas registered on the proven phone are linked.
    const pass = await runLinkPass(caller, [phoneKey]);
    const linkedChamas = pass.activatedForPhoneKeys[phoneKey] || 0;

    // Refresh the snapshot right away so the UI shows the new chamas (bypasses the cooldown; never fails the verify).
    try { await runSyncFor(caller, "manual", { bypassCooldown: true }); } catch (e) { console.error("mychama verify: post-link sync failed:", (e as Error)?.message || e); }
    return { linkedChamas };
  }
);
