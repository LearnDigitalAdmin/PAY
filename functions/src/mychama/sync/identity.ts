// Resolves "who is calling" to {uid, role, idNumber, verifiedPhone}. Reads ONLY the caller's own profile
// document (ID number + role) — never rent, payment, booking or invoice collections.
//
// Profiles in the plot project today:
//   tenants  -> tenants/{uid}           { idNumber, phone, ... }   (Firebase phone auth)
//   landlords-> users/{userId}          where userId IS the landlord's National ID / passport number
//                                        (PMS convention). `agentId` = custom claim set by Track C, falling
//                                        back to the uid (users/{localId} for accounts made by
//                                        createUserWithFirebaseAuth). A stored `idNumber` field, if one ever
//                                        exists, wins over the doc id.
// The doc id is only used as an ID number when it LOOKS like one (5-12 alphanumerics): self-signup
// landlords get a 28-char random Firebase uid, which is not an ID and is skipped. Even if a doc id were
// forged, linking still needs the phone proof (verified Firebase phone or an SMS code to the phone
// registered in MyChama), so the ID alone never exposes chama data.
import type { CallableRequest } from "firebase-functions/v2/https";
import { normalizeIdNumber, normalizeKePhone, plotDb } from "../config";
import type { PortalRole } from "../contract";

export type AuthInfo = NonNullable<CallableRequest["auth"]>;
export interface Caller { uid: string; role: PortalRole; idNumber: string; verifiedPhoneE164: string | null }

const KE_MOBILE = /^\+254[17]\d{8}$/;

/** National IDs are 7-8 digits, passports up to ~9 alphanumerics; random Firebase uids are 28 chars. */
export function looksLikeIdNumber(raw: string): boolean {
  const n = normalizeIdNumber(raw);
  return n.length >= 5 && n.length <= 12;
}

export async function resolveCaller(auth: AuthInfo): Promise<Caller> {
  const uid = auth.uid;
  const token = auth.token as { phone_number?: unknown; otp_phone?: unknown; role?: unknown; agentId?: unknown };

  // Verified phone: legacy Firebase phone auth (`phone_number`) or the HostPinnacle OTP proof (`otp_phone`).
  const rawPhone = typeof token.otp_phone === "string" ? token.otp_phone : token.phone_number;
  const phone = typeof rawPhone === "string" ? normalizeKePhone(rawPhone) : "";
  const verifiedPhoneE164 = KE_MOBILE.test(phone) ? phone : null;

  const db = plotDb();
  const claimRole = token.role === "landlord" || token.role === "tenant" ? token.role : null;
  const agentId = typeof token.agentId === "string" && token.agentId ? token.agentId : uid;

  if (claimRole !== "tenant") {
    const landlordSnap = await db.doc(`users/${agentId}`).get();
    if (landlordSnap.exists && (claimRole === "landlord" || landlordSnap.data()?.firebaseAuthUid === uid || landlordSnap.id === uid)) {
      const stored = String(landlordSnap.data()?.idNumber || "");
      const idNumber = stored || (looksLikeIdNumber(landlordSnap.id) ? landlordSnap.id : "");
      return { uid, role: "landlord", idNumber, verifiedPhoneE164 };
    }
  }
  const tenantSnap = await db.doc(`tenants/${uid}`).get();
  if (tenantSnap.exists) {
    return { uid, role: "tenant", idNumber: String(tenantSnap.data()?.idNumber || ""), verifiedPhoneE164 };
  }
  return { uid, role: claimRole ?? "tenant", idNumber: "", verifiedPhoneE164 };
}
