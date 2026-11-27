// pmsAccountingBilling — the signed-in PMS account holder's own plan and SMS payments, for the agent's expense accounts.
//   request : {}                      (the caller is identified by their sign-in, never by a client-supplied id)
//   response: { rows: BillingRow[] }  newest first
// Read-only; it never changes anything, so it is safe to retry and safe to deploy on its own.
import { onCall, HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { REGION, plotDb } from "../mychama/config";
import type * as admin from "firebase-admin";
import { mergeBilling, smsRow, subscriptionRow, type BillingRow } from "./billing";

/** Same mapping as the Firestore rules and compliance/api.ts resolveLandlordId (kept local so this function stays light: no Chromium import). */
async function resolveLandlordId(db: admin.firestore.Firestore, auth: NonNullable<CallableRequest<unknown>["auth"]>): Promise<string> {
  const claim = auth.token as Record<string, unknown>;
  if (claim.role === "landlord" && typeof claim.agentId === "string" && claim.agentId) {
    if ((await db.collection("users").doc(claim.agentId).get()).exists) return claim.agentId;
  }
  const byAuth = await db.collection("users").where("firebaseAuthUid", "==", auth.uid).limit(1).get();
  if (!byAuth.empty) return byAuth.docs[0].id;
  if ((await db.collection("users").doc(auth.uid).get()).exists) return auth.uid;
  throw new Error("no landlord account");
}

export const pmsAccountingBilling = onCall({ region: REGION, memory: "256MiB", timeoutSeconds: 30, maxInstances: 10, cors: true },
  async (req: CallableRequest<unknown>): Promise<{ rows: BillingRow[] }> => {
    if (!req.auth) throw new HttpsError("unauthenticated", "Please sign in.");
    const db = plotDb();
    let userId: string;
    try { userId = await resolveLandlordId(db, req.auth); } catch { throw new HttpsError("permission-denied", "No account found for this sign-in."); }
    const [subs, sms] = await Promise.all([
      db.collection("subscriptions").where("userId", "==", userId).where("status", "==", "success").limit(300).get(),
      db.collection("sms-topup-transactions").where("userId", "==", userId).where("status", "==", "success").limit(300).get(),
    ]);
    return { rows: mergeBilling([
      ...subs.docs.map((d) => subscriptionRow(d.id, d.data())),
      ...sms.docs.map((d) => smsRow(d.id, d.data())),
    ]) };
  });
