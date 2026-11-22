// Dispatch records (one per accepted send) and delivery-report application. Pure Firestore logic: db is injected.
import { createHash } from "crypto";
import type { firestore } from "firebase-admin";
import { extractProviderIds } from "./parse";
import { FAILURE_STATUSES, RETENTION_MS, SMS_COLL, type DeliveryStatus, type DispatchDoc, type DlrEvent } from "./types";

type Db = firestore.Firestore;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const idDoc = (pid: string) => "p_" + pid.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100);

export interface RecordArgs { product: string; ref?: string | null; mobile: string; message: string; raw: unknown; providerIds?: string[] }
/** Best-effort bookkeeping after the provider ACCEPTED a send. Returns the provider ids it could find (possibly none). */
export async function recordDispatch(db: Db, a: RecordArgs, now = Date.now()): Promise<string[]> {
  const mobile = a.mobile.replace(/\D/g, "").replace(/^0/, "254");
  const ids = (a.providerIds && a.providerIds.length ? a.providerIds : extractProviderIds(a.raw)).slice(0, 20);
  const base = { product: a.product || "unknown", ref: a.ref ?? null, mobile, msgLen: a.message.length, msgHash: sha(a.message).slice(0, 12),
    delivery: "SENT" as DeliveryStatus, createdAt: now, expireAt: now + RETENTION_MS, rawResponse: JSON.stringify(a.raw ?? null).slice(0, 1500) };
  if (!ids.length) { const id = `m_${mobile}_${now}`; await db.doc(`${SMS_COLL.dispatch}/${id}`).set({ id, providerId: null, ...base }); return []; }
  for (const pid of ids) { const id = idDoc(pid); await db.doc(`${SMS_COLL.dispatch}/${id}`).set({ id, providerId: pid, ...base }); }
  return ids;
}

const isFinal = (s: DeliveryStatus) => s === "DELIVERED" || FAILURE_STATUSES.includes(s);
export interface ApplyResult { matched: boolean; dispatch: DispatchDoc | null; changed: boolean }
/** Match a delivery report to its send (provider id first, then the newest unfinished send to that number) and move its status forward. */
export async function applyDlr(db: Db, ev: DlrEvent): Promise<ApplyResult> {
  let ref: firestore.DocumentReference | null = null, doc: DispatchDoc | null = null, by = "";
  if (ev.providerId) { const r = db.doc(`${SMS_COLL.dispatch}/${idDoc(ev.providerId)}`), s = await r.get(); if (s.exists) { ref = r; doc = s.data() as DispatchDoc; by = "providerId"; } }
  if (!ref && ev.mobile) {
    const q = await db.collection(SMS_COLL.dispatch).where("mobile", "==", ev.mobile).orderBy("createdAt", "desc").limit(5).get();
    const hit = q.docs.find((d) => !isFinal((d.data() as DispatchDoc).delivery));
    if (hit) { ref = hit.ref; doc = hit.data() as DispatchDoc; by = "mobile"; }
  }
  if (!ref || !doc) return { matched: false, dispatch: null, changed: false };
  if (ev.status === "UNKNOWN" || ev.status === "SENT" || doc.delivery === "DELIVERED") return { matched: true, dispatch: doc, changed: false };
  const patch = { delivery: ev.status, dlrAt: ev.at, dlrCode: ev.code, dlrDescription: ev.description, matchedBy: by };
  await ref.set(patch, { merge: true });
  return { matched: true, dispatch: { ...doc, ...patch }, changed: true };
}
