// TRACK C — landlord session claims. Wired once from ../index.ts (`export * from "./auth"`).
//
// Landlords already authenticate with Firebase Auth (email/password; phone is added by Track C), but
// nothing on the server knew a signed-in uid *is* a landlord. `agentSyncClaims` is the single trusted
// place that decides it, using only server-side reads, and stamps the custom claims
//     { role: "landlord", agentId }          (agentId = users/{userId}, userId = the landlord's ID number)
// that Track A's identity resolver and the UI session both rely on. It never touches rental data.
import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import { REGION, normalizeKePhone, plotDb } from "../mychama/config";

export * from "./otp";

export interface SyncClaimsResponse { agentId: string; claimsChanged: boolean }

const KE_MOBILE = /^\+254[17]\d{8}$/;

export const agentSyncClaims = onCall(
  { region: REGION, cors: true, maxInstances: 10 },
  async (req): Promise<SyncClaimsResponse> => {
    if (!req.auth) throw new HttpsError("unauthenticated", "Sign in required.");
    const uid = req.auth.uid;
    const token = req.auth.token as { phone_number?: unknown; otp_phone?: unknown };
    const db = plotDb();

    // 1) uid IS the userId (accounts made by createUserWithFirebaseAuth use localId = userId = Firebase uid)
    let agentDoc: admin.firestore.DocumentSnapshot | null = null;
    const direct = await db.doc(`users/${uid}`).get();
    if (direct.exists) agentDoc = direct;

    // 2) the users doc points at this uid
    if (!agentDoc) {
      const byUid = await db.collection("users").where("firebaseAuthUid", "==", uid).limit(2).get();
      if (byUid.size === 1) agentDoc = byUid.docs[0];
    }

    // 3) signed in with a verified phone that equals exactly one landlord's registered phone
    // (verified phone = legacy Firebase phone auth `phone_number`, or `otp_phone` stamped by verifyLoginOtp)
    const verifiedPhone = typeof token.otp_phone === "string" ? token.otp_phone
      : typeof token.phone_number === "string" ? token.phone_number : "";
    if (!agentDoc && verifiedPhone) {
      const phone = normalizeKePhone(verifiedPhone);
      if (KE_MOBILE.test(phone)) {
        const byPhone = await db.collection("users").where("phone", "==", phone).limit(2).get();
        if (byPhone.size > 1) throw new HttpsError("failed-precondition", "More than one account uses this phone number. Please contact support.");
        if (byPhone.size === 1) agentDoc = byPhone.docs[0];
      }
    }

    if (!agentDoc) throw new HttpsError("not-found", "No landlord account is linked to this sign-in.");
    // Same gate the previous client-side login applied.
    if (agentDoc.data()?.type !== "paid") throw new HttpsError("permission-denied", "Access restricted to agent accounts.");

    const agentId = agentDoc.id;
    const user = await admin.auth().getUser(uid);
    const existing = (user.customClaims || {}) as Record<string, unknown>;
    if (existing.role === "landlord" && existing.agentId === agentId) return { agentId, claimsChanged: false };

    await admin.auth().setCustomUserClaims(uid, { ...existing, role: "landlord", agentId });
    return { agentId, claimsChanged: true };
  }
);
