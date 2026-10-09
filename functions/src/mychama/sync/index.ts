// TRACK A — owns this directory. Stub from P0; replace the body, keep name + I/O types.
import { onCall } from "firebase-functions/v2/https";
import { REGION, MYCHAMA_ID_PEPPER } from "../config";
import { notImplemented } from "../errors";
import type { SyncRequest, SyncResponse } from "../contract";

export const mychamaSync = onCall(
  { region: REGION, cors: true, maxInstances: 10, timeoutSeconds: 120, secrets: [MYCHAMA_ID_PEPPER] },
  async (_req: { data: SyncRequest }): Promise<SyncResponse> => {
    throw notImplemented("mychamaSync");
  }
);
