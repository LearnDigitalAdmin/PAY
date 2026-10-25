// Landlord Watch operations. Transport-agnostic: the callables and the WhatsApp endpoint both call these.
import type * as admin from "firebase-admin";
import {
  EXTRA_TRANSCRIPT_PRICE_KES, FREE_TRANSCRIPTS_PER_MONTH, LIST_LIMIT, LOOKUPS_PER_HOUR, OWNER_ID_PATTERN, SIGNED_URL_TTL_MS,
  SNAPSHOT_TTL_CURRENT_MS, SNAPSHOT_TTL_PAST_MS, TRANSCRIPT_REQUEST_TTL_MS, TRANSCRIPT_REUSE_MS, OTP_RESEND_COOLDOWN_MS,
} from "./constants";
import { buildOpenSnapshot } from "./calc";
import {
  type Actor, addConnection, getUnlock, grantUnlock, maskLevelFor, phoneKey, readConnections, removeConnection, toConnection,
} from "./actors";
import { loadBundle, type OwnerRef, resolveOwner, transcriptStamp } from "./data";
import { LwError } from "./errors";
import { currentMonth, isMonth, maskName, maskPhone } from "./format";
import { lwHmac, randomHex } from "./keys";
import { etagOf, maskSnapshot } from "./mask";
import { otpText, type OtpDeps, sendOtp, verifyOtp } from "./otp";
import { renderTranscriptHtml } from "./transcriptHtml";
import type { Connection, Lang, Quota, Snapshot, TranscriptRequest, TranscriptState } from "./types";

type Db = admin.firestore.Firestore;

export interface PaystackPort {
  charge(payload: Record<string, unknown>): Promise<{ status: string; displayText: string | null }>;
  verify(reference: string): Promise<{ status: "success" | "failed" | "pending"; data: Record<string, unknown> } | null>;
}
export interface Deps {
  db: Db;
  otp: OtpDeps;
  now: () => Date;
  pdf: (html: string, footer: string, pageLabel: string) => Promise<Buffer>;
  storage: { save(path: string, data: Buffer): Promise<void>; signedUrl(path: string, ttlMs: number): Promise<string> };
  paystack: PaystackPort;
  checkPhone: (raw: unknown) => { ok: true; e164: string } | { ok: false; message: string };
  /** Settles a verified payment (shared with the webhook). */
  settle: (db: Db, reference: string, data: Record<string, unknown>, metadata: Record<string, unknown>) => Promise<void>;
}
export interface Ctx { deps: Deps; actor: Actor; lang: Lang }

const HOUR = 3_600_000;
const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function parseOwnerId(raw: unknown): string {
  const id = String(raw ?? "").trim().toUpperCase().replace(/\s+/g, "");
  if (!OWNER_ID_PATTERN.test(id)) throw new LwError("LW_BAD_OWNER_ID", "Enter an owner ID like PYP-0001.");
  return id;
}

async function owner(ctx: Ctx, ownerId: string): Promise<OwnerRef> {
  const ref = await resolveOwner(ctx.deps.db, ownerId);
  if (!ref) throw new LwError("LW_NOT_FOUND", "No property found for that owner ID.");
  return ref;
}

/** PMS and WhatsApp must have connected the property; CYBER works by lookup + OTP. */
async function assertAccess(ctx: Ctx, ownerId: string): Promise<void> {
  if (ctx.actor.channel === "cyber") return;
  const conns = await readConnections(ctx.deps.db, ctx.actor);
  if (!conns[ownerId]) throw new LwError("LW_NOT_ALLOWED", "Connect this property first.");
}

async function rateLimit(db: Db, key: string, limit: number, nowMs: number): Promise<void> {
  const ref = db.collection("lwRate").doc(key);
  const verdict = await db.runTransaction(async (tx) => {
    const d = (await tx.get(ref)).data();
    const start = Number(d?.windowStart ?? 0);
    const inWindow = start && nowMs - start < HOUR;
    const n = inWindow ? Number(d?.count ?? 0) : 0;
    if (n >= limit) return Math.ceil((HOUR - (nowMs - start)) / 1000);
    tx.set(ref, { windowStart: inWindow ? start : nowMs, count: n + 1 });
    return 0;
  });
  if (verdict) throw new LwError("LW_RATE_LIMITED", "Too many lookups. Please try again later.", { retryAfterSec: verdict });
}

// ───────────────────────────── lookup / connections ─────────────────────────────
export async function lookupProperty(ctx: Ctx, p: { ownerId: unknown }) {
  const ownerId = parseOwnerId(p.ownerId);
  await rateLimit(ctx.deps.db, `${ctx.actor.key}_lookup`, LOOKUPS_PER_HOUR, ctx.deps.now().getTime());
  const ref = await resolveOwner(ctx.deps.db, ownerId);
  if (!ref) return { found: false as const };
  // CYBER operators see only a masked identity until the owner's OTP; PMS and WhatsApp see the general data to confirm.
  const masked = ctx.actor.channel === "cyber";
  return {
    found: true as const,
    property: {
      ownerId,
      name: masked ? maskName(ref.property.name) : ref.property.name,
      address: ref.property.address ? (masked ? "••••••••" : ref.property.address) : null,
      ownerPhoneMasked: ref.ownerPhone ? maskPhone(ref.ownerPhone) : "",
      managedByAgency: ref.property.managedByAgency,
    },
  };
}

export async function connect(ctx: Ctx, p: { ownerId: unknown }): Promise<{ connection: Connection }> {
  if (ctx.actor.channel === "cyber") throw new LwError("LW_NOT_ALLOWED", "Connections are for landlords.");
  const ownerId = parseOwnerId(p.ownerId);
  const ref = await owner(ctx, ownerId);
  const connectedAt = await addConnection(ctx.deps.db, ctx.actor, ownerId);
  const u = await getUnlock(ctx.deps.db, ctx.actor, ref.ownerPhone, ctx.deps.now().getTime());
  return { connection: toConnection(ownerId, ref.property.name, ref.property.address, connectedAt, u) };
}

export async function disconnect(ctx: Ctx, p: { ownerId: unknown }): Promise<{ ok: true }> {
  await removeConnection(ctx.deps.db, ctx.actor, parseOwnerId(p.ownerId));
  return { ok: true };
}

export async function listConnections(ctx: Ctx): Promise<{ connections: Connection[] }> {
  const conns = await readConnections(ctx.deps.db, ctx.actor);
  const out = await Promise.all(Object.entries(conns).map(async ([ownerId, c]) => {
    const ref = await resolveOwner(ctx.deps.db, ownerId);
    if (!ref) return null;
    const u = await getUnlock(ctx.deps.db, ctx.actor, ref.ownerPhone, ctx.deps.now().getTime());
    return toConnection(ownerId, ref.property.name, ref.property.address, c.connectedAt, u);
  }));
  return { connections: out.filter((c): c is Connection => !!c).sort((a, b) => a.connectedAt.localeCompare(b.connectedAt)) };
}

// ───────────────────────────── unlock ─────────────────────────────
export async function unlockSendOtp(ctx: Ctx, p: { ownerId: unknown }) {
  const ownerId = parseOwnerId(p.ownerId);
  const ref = await owner(ctx, ownerId);
  await assertAccess(ctx, ownerId);
  if (!ref.ownerPhone) throw new LwError("LW_NO_PHONE_ON_FILE", "This property has no owner phone number yet.");
  const pk = phoneKey(ref.ownerPhone);
  const r = await sendOtp(ctx.deps.db, { actorKey: ctx.actor.key, scope: `unlock:${pk}`, ownerPhone: ref.ownerPhone, phoneKey: pk, text: (c) => otpText(ctx.lang, "unlock", c) }, ctx.deps.otp);
  return { sentTo: maskPhone(ref.ownerPhone), ...r };
}

export async function unlockVerifyOtp(ctx: Ctx, p: { ownerId: unknown; code: unknown }) {
  const ownerId = parseOwnerId(p.ownerId);
  const ref = await owner(ctx, ownerId);
  await assertAccess(ctx, ownerId);
  if (!ref.ownerPhone) throw new LwError("LW_NO_PHONE_ON_FILE", "This property has no owner phone number yet.");
  await verifyOtp(ctx.deps.db, { actorKey: ctx.actor.key, scope: `unlock:${phoneKey(ref.ownerPhone)}`, code: String(p.code ?? "") }, ctx.deps.otp);
  const until = await grantUnlock(ctx.deps.db, ctx.actor, ref.ownerPhone, ctx.deps.now().getTime());
  return { unlocked: true as const, unlockedUntil: until.toISOString(), level: maskLevelFor(ctx.actor, true) };
}

// ───────────────────────────── snapshot ─────────────────────────────
async function openSnapshot(ctx: Ctx, ref: OwnerRef, month: string, fresh = false): Promise<Snapshot> {
  const { db } = ctx.deps;
  const cacheRef = db.collection("lwSnapshots").doc(`${ref.ownerId}_${month}_${ctx.lang}`);
  const nowMs = ctx.deps.now().getTime();
  const stamp = await transcriptStamp(db, ref, month);
  if (!fresh) {
    const c = (await cacheRef.get()).data();
    const ttl = month === currentMonth(ctx.deps.now()) ? SNAPSHOT_TTL_CURRENT_MS : SNAPSHOT_TTL_PAST_MS;
    if (c && typeof c.json === "string" && nowMs - Number(c.builtAt) < ttl && c.stamp === stamp) return JSON.parse(c.json) as Snapshot;
  }
  const bundle = await loadBundle(db, ref, month);
  const snap = buildOpenSnapshot({
    ownerId: ref.ownerId, month, lang: ctx.lang, property: ref.property, ...bundle,
    tenantRef: (id) => `t_${lwHmac("tenant", `${ref.ownerId}|${id}`).slice(0, 8)}`, now: ctx.deps.now(),
  });
  await cacheRef.set({ json: JSON.stringify(snap), builtAt: nowMs, stamp }).catch((e) => console.warn("snapshot cache write failed", e));
  return snap;
}

function hasData(snap: Snapshot, month: string): boolean {
  return snap.months.includes(month);
}

export async function getSnapshot(ctx: Ctx, p: { ownerId: unknown; month?: unknown; ifNoneMatch?: unknown }) {
  const ownerId = parseOwnerId(p.ownerId);
  const ref = await owner(ctx, ownerId);
  await assertAccess(ctx, ownerId);
  const now = ctx.deps.now();
  const month = p.month === undefined || p.month === null || p.month === "" ? currentMonth(now) : p.month;
  if (!isMonth(month) || month > currentMonth(now)) throw new LwError("LW_BAD_MONTH", "Choose a valid month.");

  const open = await openSnapshot(ctx, ref, month);
  const u = await getUnlock(ctx.deps.db, ctx.actor, ref.ownerPhone, now.getTime());
  const level = maskLevelFor(ctx.actor, u.unlocked);
  const masked = maskSnapshot(open, level);
  const snapshot: Snapshot = {
    ...masked,
    mask: {
      level,
      reason: ctx.actor.channel === "cyber" && u.unlocked ? "channel_policy" : u.reason,
      unlockedUntil: iso(u.until),
      canUnlock: !!ref.ownerPhone && level !== "open" && !(ctx.actor.channel === "cyber" && u.unlocked),
    },
  };
  const etag = etagOf(snapshot, ctx.lang);
  if (typeof p.ifNoneMatch === "string" && p.ifNoneMatch === etag) return { notModified: true as const, etag };
  return { snapshot, etag };
}

// ───────────────────────────── transcripts ─────────────────────────────
const quotaDoc = (db: Db, ownerId: string, period: string) => db.collection("lwQuota").doc(`${ownerId}_${period}`);

export async function transcriptQuota(ctx: Ctx, p: { ownerId: unknown }): Promise<Quota> {
  const ownerId = parseOwnerId(p.ownerId);
  await owner(ctx, ownerId);
  await assertAccess(ctx, ownerId);
  const period = currentMonth(ctx.deps.now());
  const used = Number((await quotaDoc(ctx.deps.db, ownerId, period).get()).data()?.freeUsed ?? 0);
  return { period, freeLimit: FREE_TRANSCRIPTS_PER_MONTH as 1, freeUsed: used, nextPriceKes: used < FREE_TRANSCRIPTS_PER_MONTH ? 0 : (EXTRA_TRANSCRIPT_PRICE_KES as 99) };
}

interface ReqDoc {
  requestId: string; ownerId: string; ownerKey: string; actorKey: string; channel: string; userId: string; propertyId: string;
  month: string; lang: Lang; state: TranscriptState; priceKes: 0 | 99; createdAt: number; period?: string;
  freeConsumed?: boolean; reference?: string; payStartedAt?: number; storagePath?: string; readyAt?: number; expiresAt?: number;
  lockedAt?: number; error?: { code: string; message: string } | null; phoneMasked?: string; otpSentAt?: number;
}
const reqRef = (db: Db, id: string) => db.collection("lwTranscripts").doc(id);

async function loadRequest(ctx: Ctx, requestId: unknown): Promise<ReqDoc> {
  const id = String(requestId ?? "");
  if (!/^[a-f0-9]{16}$/.test(id)) throw new LwError("LW_NOT_FOUND", "Transcript request not found.");
  const d = (await reqRef(ctx.deps.db, id).get()).data() as ReqDoc | undefined;
  if (!d || d.actorKey !== ctx.actor.key) throw new LwError("LW_NOT_FOUND", "Transcript request not found.");
  return d;
}

async function present(ctx: Ctx, d: ReqDoc, extra: Partial<TranscriptRequest> = {}, withUrl = true): Promise<TranscriptRequest> {
  const out: TranscriptRequest = {
    requestId: d.requestId, ownerId: d.ownerId, month: d.month, state: d.state, priceKes: d.priceKes,
    createdAt: new Date(d.createdAt).toISOString(), ...(d.reference ? { reference: d.reference } : {}), ...(d.error ? { error: d.error } : {}), ...extra,
  };
  if (d.state === "ready" && d.storagePath && d.expiresAt) {
    if (withUrl) out.url = await ctx.deps.storage.signedUrl(d.storagePath, SIGNED_URL_TTL_MS);
    out.expiresAt = new Date(d.expiresAt).toISOString();
  }
  return out;
}

export async function transcriptStart(ctx: Ctx, p: { ownerId: unknown; month: unknown }): Promise<TranscriptRequest> {
  const ownerId = parseOwnerId(p.ownerId);
  const ref = await owner(ctx, ownerId);
  await assertAccess(ctx, ownerId);
  const now = ctx.deps.now();
  if (!isMonth(p.month) || p.month > currentMonth(now)) throw new LwError("LW_BAD_MONTH", "Choose a valid month.");
  const month = p.month;
  if (!ref.ownerPhone) throw new LwError("LW_NO_PHONE_ON_FILE", "This property has no owner phone number yet.");
  if (!hasData(await openSnapshot(ctx, ref, month), month)) throw new LwError("LW_BAD_MONTH", "There is no data for that month.");

  const quota = await transcriptQuota(ctx, { ownerId });
  const requestId = randomHex(8);
  const doc: ReqDoc = {
    requestId, ownerId, ownerKey: `${ownerId}|${ctx.actor.key}`, actorKey: ctx.actor.key, channel: ctx.actor.channel, userId: ref.userId, propertyId: ref.propertyId,
    month, lang: ctx.lang, state: "otp_pending", priceKes: quota.nextPriceKes, createdAt: now.getTime(), otpSentAt: now.getTime(),
  };
  const pk = phoneKey(ref.ownerPhone);
  const sent = await sendOtp(ctx.deps.db, { actorKey: ctx.actor.key, scope: `download:${requestId}`, ownerPhone: ref.ownerPhone, phoneKey: pk, text: (c) => otpText(ctx.lang, "download", c) }, ctx.deps.otp);
  await reqRef(ctx.deps.db, requestId).set(doc);
  return present(ctx, doc, { sentTo: maskPhone(ref.ownerPhone), ...sent });
}

export async function transcriptResendOtp(ctx: Ctx, p: { requestId: unknown }) {
  const d = await loadRequest(ctx, p.requestId);
  if (d.state !== "otp_pending") throw new LwError("LW_NOT_ALLOWED", "This request is not waiting for a code.");
  if (ctx.deps.now().getTime() - d.createdAt > TRANSCRIPT_REQUEST_TTL_MS) { await reqRef(ctx.deps.db, d.requestId).update({ state: "expired" }); throw new LwError("LW_OTP_EXPIRED", "This request has expired. Please start again."); }
  const ref = await owner(ctx, d.ownerId);
  if (!ref.ownerPhone) throw new LwError("LW_NO_PHONE_ON_FILE", "This property has no owner phone number yet.");
  const sent = await sendOtp(ctx.deps.db, { actorKey: ctx.actor.key, scope: `download:${d.requestId}`, ownerPhone: ref.ownerPhone, phoneKey: phoneKey(ref.ownerPhone), text: (c) => otpText(d.lang, "download", c) }, ctx.deps.otp);
  return { sentTo: maskPhone(ref.ownerPhone), ...sent };
}

/** Takes the month's free allowance if one is left (transaction, so two requests cannot both take it). */
async function claimFree(db: Db, ownerId: string, period: string): Promise<boolean> {
  const ref = quotaDoc(db, ownerId, period);
  return db.runTransaction(async (tx) => {
    const used = Number((await tx.get(ref)).data()?.freeUsed ?? 0);
    if (used >= FREE_TRANSCRIPTS_PER_MONTH) return false;
    tx.set(ref, { freeUsed: used + 1 }, { merge: true });
    return true;
  });
}
async function releaseFree(db: Db, ownerId: string, period: string): Promise<void> {
  const ref = quotaDoc(db, ownerId, period);
  await db.runTransaction(async (tx) => {
    const used = Number((await tx.get(ref)).data()?.freeUsed ?? 0);
    tx.set(ref, { freeUsed: Math.max(0, used - 1) }, { merge: true });
  });
}

export async function transcriptVerifyOtp(ctx: Ctx, p: { requestId: unknown; code: unknown }): Promise<TranscriptRequest> {
  const d = await loadRequest(ctx, p.requestId);
  if (d.state !== "otp_pending") return present(ctx, d); // idempotent: a repeated verify just reports where the request is
  const nowMs = ctx.deps.now().getTime();
  if (nowMs - d.createdAt > TRANSCRIPT_REQUEST_TTL_MS) { await reqRef(ctx.deps.db, d.requestId).update({ state: "expired" }); throw new LwError("LW_OTP_EXPIRED", "This request has expired. Please start again."); }
  await verifyOtp(ctx.deps.db, { actorKey: ctx.actor.key, scope: `download:${d.requestId}`, code: String(p.code ?? "") }, ctx.deps.otp);

  const period = currentMonth(ctx.deps.now());
  if (await claimFree(ctx.deps.db, d.ownerId, period)) {
    const next: ReqDoc = { ...d, state: "generating", priceKes: 0, period, freeConsumed: true, lockedAt: nowMs };
    await reqRef(ctx.deps.db, d.requestId).set(next);
    return finishGeneration(ctx, next);
  }
  const next: ReqDoc = { ...d, state: "payment_required", priceKes: EXTRA_TRANSCRIPT_PRICE_KES as 99, period };
  await reqRef(ctx.deps.db, d.requestId).set(next);
  return present(ctx, next, { message: ctx.lang === "sw" ? `Taarifa hii ya ziada inagharimu KES ${EXTRA_TRANSCRIPT_PRICE_KES}.` : `This extra transcript costs KES ${EXTRA_TRANSCRIPT_PRICE_KES}.` });
}

async function generate(ctx: Ctx, d: ReqDoc): Promise<string> {
  const ref = await owner(ctx, d.ownerId);
  // Always built fresh (never from the snapshot cache) so the agent's latest deductions are on the page.
  const bundle = await loadBundle(ctx.deps.db, ref, d.month);
  const open = buildOpenSnapshot({
    ownerId: d.ownerId, month: d.month, lang: d.lang, property: ref.property, ...bundle,
    tenantRef: (id) => `t_${lwHmac("tenant", `${d.ownerId}|${id}`).slice(0, 8)}`, now: ctx.deps.now(),
  });
  const base = d.channel === "cyber" ? maskSnapshot(open, "tenant") : open;
  // Tenant phone numbers are never printed.
  const snap: Snapshot = { ...base, tenants: base.tenants.map((t) => ({ ...t, phone: maskPhone(t.phone) })) };
  const html = renderTranscriptHtml(snap, { lang: d.lang, requestId: d.requestId, generatedAt: ctx.deps.now() });
  const pdf = await ctx.deps.pdf(html, "Landlord Watch", d.lang === "sw" ? "Ukurasa" : "Page");
  const path = `landlord-watch/transcripts/${d.ownerId}/${d.month}/${d.requestId}.pdf`;
  await ctx.deps.storage.save(path, pdf);
  return path;
}

/** generating -> ready. A failure releases a free allowance taken for it; a PAID request stays 'paid' so the next status call retries. */
async function finishGeneration(ctx: Ctx, d: ReqDoc): Promise<TranscriptRequest> {
  const db = ctx.deps.db;
  try {
    const path = await generate(ctx, d);
    const nowMs = ctx.deps.now().getTime();
    const ready: ReqDoc = { ...d, state: "ready", storagePath: path, readyAt: nowMs, expiresAt: nowMs + TRANSCRIPT_REUSE_MS, lockedAt: undefined, error: null };
    await reqRef(db, d.requestId).set(JSON.parse(JSON.stringify(ready, (_k, v) => (v === undefined ? null : v))));
    return present(ctx, ready);
  } catch (e) {
    console.error("Transcript generation failed:", e);
    if (d.priceKes === 0) {
      if (d.freeConsumed && d.period) await releaseFree(db, d.ownerId, d.period).catch(() => undefined);
      const failed: ReqDoc = { ...d, state: "failed", freeConsumed: false, error: { code: "LW_UNAVAILABLE", message: "We could not create the transcript. Please try again." } };
      await reqRef(db, d.requestId).set(failed);
      return present(ctx, failed);
    }
    const back: ReqDoc = { ...d, state: "paid", lockedAt: undefined, error: { code: "LW_UNAVAILABLE", message: "Payment received. We are still preparing your transcript; please check again shortly." } };
    await reqRef(db, d.requestId).set(JSON.parse(JSON.stringify(back, (_k, v) => (v === undefined ? null : v))));
    return present(ctx, back);
  }
}

export async function transcriptPay(ctx: Ctx, p: { requestId: unknown; phone: unknown }): Promise<TranscriptRequest> {
  const d = await loadRequest(ctx, p.requestId);
  const nowMs = ctx.deps.now().getTime();
  const retriable = d.state === "payment_required" || (d.state === "payment_pending" && nowMs - (d.payStartedAt ?? 0) > OTP_RESEND_COOLDOWN_MS);
  if (!retriable) {
    if (d.state === "payment_pending") return present(ctx, d, { message: "Payment already started. Check your phone." });
    throw new LwError("LW_NOT_ALLOWED", "This request is not waiting for payment.");
  }
  const phone = ctx.deps.checkPhone(p.phone);
  if (!phone.ok) throw new LwError("LW_PAYMENT_FAILED", phone.message);

  const reference = `LWT_${d.requestId}_${nowMs.toString(36)}`;
  let charge: { status: string; displayText: string | null };
  try {
    charge = await ctx.deps.paystack.charge({
      email: `watch-${d.requestId}@samuhia.co.ke`,
      amount: EXTRA_TRANSCRIPT_PRICE_KES * 100, // exactly KES 99.00: we absorb the gateway fee
      currency: "KES",
      mobile_money: { phone: phone.e164, provider: "mpesa" },
      reference,
      metadata: { chargeType: "landlord_watch_transcript", requestId: d.requestId, ownerId: d.ownerId, month: d.month, amountKes: EXTRA_TRANSCRIPT_PRICE_KES },
    });
  } catch (e) {
    console.error("Landlord Watch charge failed:", (e as Error).message);
    throw new LwError("LW_PAYMENT_FAILED", "We could not start the M-Pesa payment. Please try again.");
  }
  const next: ReqDoc = { ...d, state: "payment_pending", reference, payStartedAt: nowMs, phoneMasked: maskPhone(phone.e164), error: null };
  await reqRef(ctx.deps.db, d.requestId).set(JSON.parse(JSON.stringify(next, (_k, v) => (v === undefined ? null : v))));
  return present(ctx, next, { message: charge.displayText || (ctx.lang === "sw" ? "Angalia simu yako kwa ombi la M-Pesa." : "Check your phone for the M-Pesa prompt.") });
}

export async function transcriptStatus(ctx: Ctx, p: { requestId: unknown }): Promise<TranscriptRequest> {
  let d = await loadRequest(ctx, p.requestId);
  const db = ctx.deps.db;
  const nowMs = ctx.deps.now().getTime();

  if (d.state === "otp_pending" && nowMs - d.createdAt > TRANSCRIPT_REQUEST_TTL_MS) {
    d = { ...d, state: "expired" }; await reqRef(db, d.requestId).update({ state: "expired" });
  }

  // Webhook can be late: ask Paystack directly once the STK push has had a few seconds.
  if (d.state === "payment_pending" && d.reference && nowMs - (d.payStartedAt ?? 0) > 8_000) {
    const v = await ctx.deps.paystack.verify(d.reference).catch(() => null);
    if (v?.status === "success") {
      await ctx.deps.settle(db, d.reference, v.data, { chargeType: "landlord_watch_transcript", requestId: d.requestId, ownerId: d.ownerId, month: d.month });
      d = await loadRequest(ctx, d.requestId);
    } else if (v?.status === "failed") {
      d = { ...d, state: "payment_required", error: { code: "LW_PAYMENT_FAILED", message: "The M-Pesa payment was not completed. You can try again." } };
      await reqRef(db, d.requestId).update({ state: "payment_required", error: d.error });
    }
  }

  // 'paid' = payment confirmed, PDF not made yet. 'generating' with an old lock = the call that was making the PDF died
  // (timeout, crash) before finishing; either way a status call picks the work up again.
  if (d.state === "paid" || (d.state === "generating" && nowMs - (d.lockedAt ?? 0) >= 180_000)) {
    // Exactly one caller generates: take the lock in a transaction (a stale lock after 3 minutes can be retaken).
    const locked = await db.runTransaction(async (tx) => {
      const cur = (await tx.get(reqRef(db, d.requestId))).data() as ReqDoc;
      if (cur.state !== "paid" && cur.state !== "generating") return null;
      if (cur.lockedAt && nowMs - cur.lockedAt < 180_000) return null;
      tx.update(reqRef(db, d.requestId), { lockedAt: nowMs });
      return cur;
    });
    if (locked) return finishGeneration(ctx, { ...locked, lockedAt: nowMs });
    d = await loadRequest(ctx, d.requestId);
  }

  if (d.state === "ready" && (!d.expiresAt || nowMs > d.expiresAt)) {
    d = { ...d, state: "expired" }; await reqRef(db, d.requestId).update({ state: "expired" });
  }
  return present(ctx, d);
}

export async function transcriptList(ctx: Ctx, p: { ownerId: unknown }): Promise<{ items: TranscriptRequest[] }> {
  const ownerId = parseOwnerId(p.ownerId);
  await assertAccess(ctx, ownerId);
  const snap = await ctx.deps.db.collection("lwTranscripts").where("ownerKey", "==", `${ownerId}|${ctx.actor.key}`).get();
  const nowMs = ctx.deps.now().getTime();
  const docs = snap.docs.map((x) => x.data() as ReqDoc).sort((a, b) => b.createdAt - a.createdAt).slice(0, LIST_LIMIT);
  // A list never carries download links: fetch one with transcriptStatus.
  const items = await Promise.all(docs.map((d) => present(ctx, d.state === "ready" && (!d.expiresAt || nowMs > d.expiresAt) ? { ...d, state: "expired" } : d, {}, false)));
  return { items };
}

