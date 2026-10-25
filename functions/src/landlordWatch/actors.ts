// Who is calling, what they may see, and the server-side state that follows them (connections, unlocks).
import type * as admin from "firebase-admin";
import type { CallableRequest } from "firebase-functions/v2/https";
import { KE_MOBILE, MAX_CONNECTIONS, UNLOCK_TTL_MS } from "./constants";
import { LwError } from "./errors";
import { lwHmac } from "./keys";
import type { Channel, Connection, MaskLevel } from "./types";

type Db = admin.firestore.Firestore;

export interface Actor {
  /** Stable key for server-side state: u_<uid> for Firebase callers, w_<digits> for WhatsApp. */
  key: string;
  channel: Channel;
  /** A phone number we can trust belongs to the caller (verified OTP login, or the WhatsApp sender). */
  phone: string | null;
}

export function actorFromBot(phoneRaw: unknown): Actor {
  const phone = String(phoneRaw ?? "").trim();
  if (!KE_MOBILE.test(phone)) throw new LwError("LW_NOT_ALLOWED", "A valid WhatsApp number is required.");
  return { key: `w_${phone.slice(1)}`, channel: "whatsapp", phone };
}

/** The server decides the channel: an agent account is CYBER; anyone else signed in is PMS. A wrong hint is rejected. */
export async function actorFromCallable(db: Db, req: CallableRequest<unknown>, hint?: unknown): Promise<Actor> {
  if (!req.auth) throw new LwError("LW_NOT_ALLOWED", "Please sign in.");
  const uid = req.auth.uid;
  const isAgent = (await db.collection("agents").doc(uid).get()).exists;
  if (hint === "cyber" && !isAgent) throw new LwError("LW_NOT_ALLOWED", "This account cannot use CYBER lookups.");
  const otpPhone = req.auth.token?.otp_phone;
  return { key: `u_${uid}`, channel: isAgent ? "cyber" : "pms", phone: !isAgent && typeof otpPhone === "string" && KE_MOBILE.test(otpPhone) ? otpPhone : null };
}

// ---------------- unlock ----------------
export interface UnlockState { unlocked: boolean; until: Date | null; reason: "locked" | "otp" | "auth_phone_match" }

export const phoneKey = (ownerPhone: string): string => lwHmac("phone", ownerPhone).slice(0, 24);

/** Unlock is per owner PHONE, so one OTP covers every property that shares it. */
export async function getUnlock(db: Db, actor: Actor, ownerPhone: string | null, nowMs = Date.now()): Promise<UnlockState> {
  if (!ownerPhone) return { unlocked: false, until: null, reason: "locked" };
  if (actor.channel !== "cyber" && actor.phone === ownerPhone) return { unlocked: true, until: null, reason: "auth_phone_match" };
  const d = (await db.collection("lwUnlocks").doc(`${actor.key}_${phoneKey(ownerPhone)}`).get()).data();
  const until = d?.until?.toDate?.() as Date | undefined;
  if (until && until.getTime() > nowMs) return { unlocked: true, until, reason: "otp" };
  return { unlocked: false, until: null, reason: "locked" };
}

export async function grantUnlock(db: Db, actor: Actor, ownerPhone: string, nowMs = Date.now()): Promise<Date> {
  const until = new Date(nowMs + UNLOCK_TTL_MS[actor.channel]);
  await db.collection("lwUnlocks").doc(`${actor.key}_${phoneKey(ownerPhone)}`).set({ actorKey: actor.key, until });
  return until;
}

/** CYBER never goes above 'tenant'; PMS and WhatsApp reach 'open' only when unlocked. */
export function maskLevelFor(actor: Actor, unlocked: boolean): MaskLevel {
  if (actor.channel === "cyber") return unlocked ? "tenant" : "full";
  return unlocked ? "open" : "tenant";
}

// ---------------- connections (PMS and WhatsApp) ----------------
export async function readConnections(db: Db, actor: Actor): Promise<Record<string, { connectedAt: Date }>> {
  const d = (await db.collection("lwActors").doc(actor.key).get()).data();
  const out: Record<string, { connectedAt: Date }> = {};
  for (const [ownerId, v] of Object.entries((d?.connections ?? {}) as Record<string, { connectedAt?: { toDate?: () => Date } }>)) {
    out[ownerId] = { connectedAt: v.connectedAt?.toDate?.() ?? new Date(0) };
  }
  return out;
}

export async function addConnection(db: Db, actor: Actor, ownerId: string): Promise<Date> {
  const ref = db.collection("lwActors").doc(actor.key);
  const connectedAt = new Date();
  await db.runTransaction(async (tx) => {
    const data = (await tx.get(ref)).data();
    const existing = (data?.connections ?? {}) as Record<string, unknown>;
    if (!existing[ownerId] && Object.keys(existing).length >= MAX_CONNECTIONS) {
      throw new LwError("LW_CONNECTION_LIMIT", `You can connect up to ${MAX_CONNECTIONS} properties.`);
    }
    if (!existing[ownerId]) tx.set(ref, { channel: actor.channel, connections: { [ownerId]: { connectedAt } } }, { merge: true });
  });
  return connectedAt;
}

export async function removeConnection(db: Db, actor: Actor, ownerId: string): Promise<void> {
  const FieldValue = (await import("firebase-admin/firestore")).FieldValue;
  await db.collection("lwActors").doc(actor.key).set({ connections: { [ownerId]: FieldValue.delete() } }, { merge: true });
}

export const toConnection = (ownerId: string, name: string, address: string | null, connectedAt: Date, u: UnlockState): Connection => ({
  ownerId, propertyName: name, address, connectedAt: connectedAt.toISOString(), unlocked: u.unlocked, unlockedUntil: u.until ? u.until.toISOString() : null,
});
