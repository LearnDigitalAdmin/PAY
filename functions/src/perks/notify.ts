// SMS pipeline: template + (consented) campaign advert -> perks_smsLog -> provider. Never throws into the money path.
import type { firestore } from "firebase-admin";
import { P, PerksError, type Notification } from "./types";
import { campaignLive, composeSms, DEFAULT_TEMPLATES, type CampaignLike } from "./rules";
import { settingsFrom } from "./ops";

type Db = firestore.Firestore;
/** link.ref lets the delivery webhook find this log row again; providerId is the provider's message id when known. */
export type Sender = (e164: string, message: string, link?: { ref: string }) => Promise<{ success: boolean; error?: string; providerId?: string }>;
export const MAX_RETRIES = 3;

export async function dispatch(db: Db, send: Sender, list: Notification[], now: () => number = Date.now): Promise<void> {
  for (const n of list) {
    try { await dispatchOne(db, send, n, now); } catch (e) { console.error("perks sms dispatch failed:", (e as Error).message); }
  }
}

async function dispatchOne(db: Db, send: Sender, n: Notification, now: () => number): Promise<void> {
  const [sSnap, cSnap, tSnap] = await Promise.all([db.doc(`${P.settings}/main`).get(), db.doc(`${P.customers}/${n.customerId}`).get(), db.doc(`${P.templates}/${n.type}`).get()]);
  if (!cSnap.exists) return;
  const s = settingsFrom(sSnap.data());
  const c = cSnap.data() as { phone: string; marketingConsent?: boolean };
  const t = tSnap.data() as { body?: string; active?: boolean } | undefined;
  const body = t && t.active !== false && t.body ? t.body : DEFAULT_TEMPLATES[n.type];
  let campaign: (CampaignLike & { id: string }) | null = null;
  if (c.marketingConsent === true && s.activeCampaignId) {
    const k = await db.doc(`${P.campaigns}/${s.activeCampaignId}`).get();
    const kd = k.data() as CampaignLike | undefined;
    if (kd && campaignLive(kd, now())) campaign = { ...kd, id: s.activeCampaignId };
  }
  const message = composeSms(body, { phone: c.phone, ...n.vars }, campaign, c.marketingConsent === true);
  const ref = db.collection(P.smsLog).doc();
  await ref.set({ id: ref.id, customerId: n.customerId, phone: c.phone, transactionId: n.transactionId ?? null, templateId: n.type, campaignId: campaign ? campaign.id : null,
    message, status: "PENDING", estimatedCost: s.smsCost, createdAt: now(), sentAt: null, error: null, retryCount: 0 });
  const r = await send(c.phone, message, { ref: `${P.smsLog}/${ref.id}` });
  await ref.set(r.success ? { status: "SENT", sentAt: now(), error: null, delivery: "UNKNOWN", providerMessageId: r.providerId ?? null } : { status: "FAILED", error: String(r.error || "send failed").slice(0, 300) }, { merge: true });
}

export async function retrySms(db: Db, send: Sender, a: { id: string }, now: () => number = Date.now): Promise<{ status: string }> {
  const ref = db.doc(`${P.smsLog}/${String(a.id)}`);
  const snap = await ref.get();
  if (!snap.exists) throw new PerksError("not-found", "Message not found.");
  const m = snap.data() as { status: string; phone: string; message: string; retryCount?: number };
  if (m.status !== "FAILED") throw new PerksError("failed-precondition", "Only failed messages can be retried.");
  if ((m.retryCount || 0) >= MAX_RETRIES) throw new PerksError("failed-precondition", "Retry limit reached.");
  const r = await send(m.phone, m.message, { ref: `${P.smsLog}/${String(a.id)}` });
  const status = r.success ? "SENT" : "FAILED";
  await ref.set({ status, retryCount: (m.retryCount || 0) + 1, retriedAt: now(), sentAt: r.success ? now() : null, error: r.success ? null : String(r.error || "send failed").slice(0, 300), ...(r.success ? { delivery: "UNKNOWN", providerMessageId: r.providerId ?? null } : {}) }, { merge: true });
  return { status };
}
