// TRACK B — owns this directory. Stub from P0; replace the body, keep name + I/O types.
import { onCall } from "firebase-functions/v2/https";
import { REGION, MYCHAMA_PAYSTACK_SECRET_KEY } from "../config";
import { notImplemented } from "../errors";
import type { PayInitiateRequest, PayInitiateResponse } from "../contract";

export const mychamaPayInitiate = onCall(
  { region: REGION, cors: true, maxInstances: 10, secrets: [MYCHAMA_PAYSTACK_SECRET_KEY] },
  async (_req: { data: PayInitiateRequest }): Promise<PayInitiateResponse> => {
    throw notImplemented("mychamaPayInitiate");
  }
);
