// Resolves "who is calling" to {uid, role, idNumber, verifiedPhone}. Reads ONLY the caller's own profile
// document (ID number + role) — never rent, payment, booking or invoice collections.
//
// Profiles in the plot project today:
//   tenants  -> tenants/{uid}           { idNumber, phone, ... }   (Firebase phone auth)
//   landlords-> users/{agentId}         { phone, email, name, ... } (agentId = custom claim set by Track C,
//                                        falling back to the uid, which equals users/{localId} for accounts
//                                        made by createUserWithFirebaseAuth)
// NOTE (reported to the integrator): users/{agentId} has NO idNumber field today. A landlord without one
// resolves to idNumber "" and stays `never_linked` until Track C / the PMS migration provides it.
import type { CallableRequest } from "firebase-functions/v2/https";
import { normalizeKePhone, plotDb } from "../config";
import type { PortalRole } from "../contract";

export type AuthInfo = NonNullable<CallableRequest["auth"]>;
export interface Caller { uid: string; role: PortalRole; idNumber: string; verifiedPhoneE164: string | null }

const KE_MOBILE = /^\+254[17]\d{8}$/;

export async function resolveCaller(auth: AuthInfo): Promise<Caller> {
  const uid = auth.uid;
  const token = auth.token as { phone_number?: unknown; role?: unknown; agentId?: unknown };

  const phone = typeof token.phone_number === "string" ? normalizeKePhone(token.phone_number) : "";
  const verifiedPhoneE164 = KE_MOBILE.test(phone) ? phone : null;

  const db = plotDb();
  const claimRole = token.role === "landlord" || token.role === "tenant" ? token.role : null;
  const agentId = typeof token.agentId === "string" && token.agentId ? token.agentId : uid;

  if (claimRole !== "tenant") {
    const landlordSnap = await db.doc(`users/${agentId}`).get();
    if (landlordSnap.exists && (claimRole === "landlord" || landlordSnap.data()?.firebaseAuthUid === uid || landlordSnap.id === uid)) {
      return { uid, role: "landlord", idNumber: String(landlordSnap.data()?.idNumber || ""), verifiedPhoneE164 };
    }
  }
  const tenantSnap = await db.doc(`tenants/${uid}`).get();
  if (tenantSnap.exists) {
    return { uid, role: "tenant", idNumber: String(tenantSnap.data()?.idNumber || ""), verifiedPhoneE164 };
  }
  return { uid, role: claimRole ?? "tenant", idNumber: "", verifiedPhoneE164 };
}
