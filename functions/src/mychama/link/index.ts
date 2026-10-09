// TRACK A — owns this directory. Stubs from P0; replace the bodies, keep names + I/O types.
import { onCall } from "firebase-functions/v2/https";
import { REGION, MYCHAMA_ID_PEPPER } from "../config";
import { MYCHAMA_HP_SECRETS } from "../sms";
import { notImplemented } from "../errors";
import type { RequestCodeRequest, RequestCodeResponse, VerifyCodeRequest, VerifyCodeResponse } from "../contract";

export const mychamaLinkRequestCode = onCall(
  { region: REGION, cors: true, maxInstances: 10, secrets: [MYCHAMA_ID_PEPPER, ...MYCHAMA_HP_SECRETS] },
  async (_req: { data: RequestCodeRequest }): Promise<RequestCodeResponse> => {
    throw notImplemented("mychamaLinkRequestCode");
  }
);

export const mychamaLinkVerifyCode = onCall(
  { region: REGION, cors: true, maxInstances: 10, secrets: [MYCHAMA_ID_PEPPER] },
  async (_req: { data: VerifyCodeRequest }): Promise<VerifyCodeResponse> => {
    throw notImplemented("mychamaLinkVerifyCode");
  }
);
