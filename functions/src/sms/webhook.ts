// HostPinnacle callback endpoint logic (delivery reports; inbound/other events are recorded and ignored).
// Security: fail closed without a configured token; constant-time token check; every accepted request is stored in sms_dlr_inbox
// (replayable audit, auto-expires) and processed idempotently. Always answers 200 once stored so the provider does not retry-storm.
import { createHash, timingSafeEqual } from "crypto";
import type { firestore } from "firebase-admin";
import { applyDlr } from "./dispatch";
import { parseCallback } from "./parse";
import { getSmsProduct } from "./registry";
import { RETENTION_MS, SMS_COLL } from "./types";

type Db = firestore.Firestore;
export interface WebhookReq { method: string; query: Record<string, unknown>; body: unknown; headers: Record<string, unknown> }
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const safeEq = (a: string, b: string) => { const x = Buffer.from(sha(a)), y = Buffer.from(sha(b)); return timingSafeEqual(x, y); };
const cut = (v: unknown, n: number) => (JSON.stringify(v ?? null) || "null").slice(0, n);

export async function handleHpWebhook(db: Db, req: WebhookReq, token: string, now = Date.now()): Promise<{ status: number; body: string }> {
  if (!token) { console.error("hpSmsWebhook: HP_WEBHOOK_TOKEN is not configured; refusing all callbacks."); return { status: 503, body: "not configured" }; }
  if (req.method !== "GET" && req.method !== "POST") return { status: 405, body: "method not allowed" };
  const given = String(req.query.t ?? (req.headers["x-webhook-token"] as string | undefined) ?? "");
  if (!given || !safeEq(given, token)) { console.warn("hpSmsWebhook: rejected (bad token)"); return { status: 401, body: "unauthorized" }; }
  const { t: _t, ...query } = req.query; // never persist the token // eslint-disable-line @typescript-eslint/no-unused-vars
  const inbox = db.collection(SMS_COLL.inbox).doc();
  await inbox.set({ id: inbox.id, receivedAt: now, method: req.method, query: cut(query, 2000), body: cut(req.body, 8000), ua: String(req.headers["user-agent"] ?? "").slice(0, 120), expireAt: now + RETENTION_MS });
  try {
    const parsed = parseCallback({ query, body: req.body }, now);
    let matched = 0, skipped = 0;
    for (const ev of parsed.events) {
      const key = sha([ev.providerId, ev.mobile, ev.status, ev.rawStatus, ev.code, ev.rawTime].join("|")).slice(0, 40);
      try { await db.doc(`${SMS_COLL.events}/${key}`).create({ key, providerId: ev.providerId, mobile: ev.mobile, status: ev.status, createdAt: now, expireAt: now + RETENTION_MS }); }
      catch (e) { if ((e as { code?: number }).code === 6) { skipped++; continue; } throw e; }
      const r = await applyDlr(db, ev);
      if (r.matched) matched++;
      if (r.matched && r.changed && r.dispatch) {
        const h = getSmsProduct(r.dispatch.product);
        if (h) { try { await h(ev, r.dispatch); } catch (e) { console.error(`hpSmsWebhook: product handler ${r.dispatch.product} failed:`, (e as Error).message); } }
      }
    }
    await inbox.set({ events: parsed.events.length, matched, duplicates: skipped, inbound: parsed.inbound, items: parsed.items }, { merge: true });
  } catch (e) {
    console.error("hpSmsWebhook processing error:", (e as Error).message);
    await inbox.set({ processError: String((e as Error).message).slice(0, 300) }, { merge: true });
  }
  return { status: 200, body: "OK" };
}
