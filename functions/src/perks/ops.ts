// Perks write operations. Every money/points change is ONE Firestore transaction: ledger entry + cached balance + record.
// Idempotency keys make a double tap (or a retried request) return the original result instead of recording twice.
import { createHash, randomInt } from "crypto";
import type { firestore } from "firebase-admin";
import { DEFAULT_SETTINGS, P, PerksError, type Notification, type PerksSettings, type VoucherStatus, type VoucherType } from "./types";
import { campaignLive, cleanItems, cleanMoney, cleanPoints, customerId, normCode, pointsFor, qualifiesReferral, rateFor, redemptionValueKes, TEMPLATE_IDS, toE164, validateTemplateBody } from "./rules";

type Db = firestore.Firestore;
type Tx = firestore.Transaction;
type Rec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const makeCode = (n = 6) => Array.from({ length: n }, () => ALPHA[randomInt(ALPHA.length)]).join("");
const need = (key: unknown) => { const k = String(key ?? ""); if (k.length < 8 || k.length > 80) throw new PerksError("invalid-argument", "A request id (idempotency key) is required."); return k; };

export const settingsFrom = (d: Rec | undefined): PerksSettings => ({ ...DEFAULT_SETTINGS, ...(d || {}) });
export async function getSettings(db: Db): Promise<PerksSettings> { return settingsFrom((await db.doc(`${P.settings}/main`).get()).data()); }

const audit = (tx: Tx, db: Db, actor: string, action: string, ref: string, extra: Rec, now: number) => { tx.set(db.collection(P.audit).doc(), { actor, action, ref, ...extra, at: now, createdAt: now }); };
const ledger = (tx: Tx, db: Db, e: { customerId: string; type: string; points: number; balanceAfter: number; referenceId: string; description: string; createdBy: string; now: number }) => {
  const r = db.collection(P.ledger).doc();
  tx.set(r, { id: r.id, customerId: e.customerId, type: e.type, points: e.points, balanceAfter: e.balanceAfter, referenceId: e.referenceId, description: e.description, createdBy: e.createdBy, createdAt: e.now });
};
const balanceValue = (b: number, s: PerksSettings) => redemptionValueKes(b, s);

async function allocCode(tx: Tx, db: Db): Promise<string> {
  for (let i = 0; i < 8; i++) { const c = makeCode(); if (!(await tx.get(db.doc(`${P.codes}/${c}`))).exists) return c; }
  throw new PerksError("aborted", "Could not allocate a referral code. Try again.");
}

// ───────────────────────── sales ─────────────────────────
export interface SaleArgs { operatorUid: string; phone: unknown; items: unknown; nonEligibleAmount?: unknown; referralCode?: unknown; idempotencyKey: unknown }
export async function recordSale(db: Db, a: SaleArgs, now = Date.now()) {
  const key = need(a.idempotencyKey), phone = toE164(a.phone), cid = customerId(phone), items = cleanItems(a.items);
  const ne = a.nonEligibleAmount === undefined || a.nonEligibleAmount === "" ? 0 : cleanMoney(a.nonEligibleAmount, true, "Non-eligible amount");
  const code = a.referralCode ? normCode(a.referralCode) : "";
  const txId = "T" + sha(`${a.operatorUid}:${key}`).slice(0, 20);
  return db.runTransaction(async (tx) => {
    const sRef = db.doc(`${P.settings}/main`), cRef = db.doc(`${P.customers}/${cid}`), tRef = db.doc(`${P.tx}/${txId}`), rRef = db.doc(`${P.referrals}/${cid}`);
    const [sSnap, cSnap, tSnap, rSnap] = await Promise.all([tx.get(sRef), tx.get(cRef), tx.get(tRef), tx.get(rRef)]);
    const cur: Rec = cSnap.data() || {};
    if (tSnap.exists) return { duplicate: true, transaction: tSnap.data() as Rec, customer: { id: cid, phone, pointsBalance: cur.pointsBalance || 0, referralCode: cur.referralCode }, notifications: [] as Notification[] };
    const s = settingsFrom(sSnap.data());
    const lines = items.map((i) => { const pointsRate = rateFor(i.itemType, s); return { ...i, eligibleAmount: i.price, pointsRate, pointsEarned: pointsFor(i.price, pointsRate) }; });
    const eligible = lines.reduce((n, l) => n + l.eligibleAmount, 0), points = lines.reduce((n, l) => n + l.pointsEarned, 0), total = eligible + ne;
    const isNew = !cSnap.exists, txCount: number = cur.txCount || 0;
    const referralCode: string = isNew ? await allocCode(tx, db) : cur.referralCode;

    let ref: Rec | null = rSnap.exists ? (rSnap.data() as Rec) : null, refIsNew = false;
    if (!ref && code) {
      if (txCount > 0) throw new PerksError("failed-precondition", "A referral can only be attached on a customer's first visit.");
      const cs = await tx.get(db.doc(`${P.codes}/${code}`));
      if (!cs.exists) throw new PerksError("not-found", "Referral code not found.");
      const inviterId = (cs.data() as Rec).customerId as string;
      if (inviterId === cid) throw new PerksError("failed-precondition", "Self-referral is not allowed.");
      ref = { id: cid, referrerCustomerId: inviterId, referredCustomerId: cid, referralCode: code, status: "PENDING", referrerReward: s.referrerReward, inviteeReward: s.inviteeReward, qualifyingTransactionId: null, qualifyingAmount: null, drawResult: null, createdAt: now, rewardedAt: null };
      refIsNew = true;
    }
    const qualifies = !!ref && ref.status === "PENDING" && qualifiesReferral(eligible, s);
    let inviter: Rec | null = null;
    if (qualifies && ref) { const i = await tx.get(db.doc(`${P.customers}/${ref.referrerCustomerId}`)); inviter = i.exists ? (i.data() as Rec) : null; }

    // ---- all reads done; writes only below ----
    let bal: number = cur.pointsBalance || 0;
    const txDoc: Rec = { id: txId, customerId: cid, phone, totalAmount: total, eligibleAmount: eligible, nonEligibleAmount: ne, pointsEarned: points,
      pointsRateSnapshot: { services: s.servicesPointsRate, products: s.productsPointsRate }, status: "COMPLETED", createdBy: a.operatorUid, createdAt: now, idempotencyKey: key, referralCode: code || null,
      items: lines.map((l, n) => ({ id: `${txId}-${n + 1}`, itemName: l.itemName, itemType: l.itemType, quantity: 1, unitPrice: l.price, totalPrice: l.price, eligibleAmount: l.eligibleAmount, pointsRate: l.pointsRate, pointsEarned: l.pointsEarned })) };
    tx.set(tRef, txDoc);
    if (points > 0) { bal += points; ledger(tx, db, { customerId: cid, type: "EARN", points, balanceAfter: bal, referenceId: txId, description: `Sale ${txId}`, createdBy: a.operatorUid, now }); }
    const notifications: Notification[] = [];
    if (isNew) notifications.push({ customerId: cid, type: "welcome", vars: { referralCode } });
    if (refIsNew && ref) tx.set(rRef, ref);
    if (qualifies && ref) {
      if (inviter) {
        bal += s.inviteeReward;
        ledger(tx, db, { customerId: cid, type: "REFERRAL", points: s.inviteeReward, balanceAfter: bal, referenceId: ref.id, description: "Welcome referral reward", createdBy: a.operatorUid, now });
        const ib: number = (inviter.pointsBalance || 0) + s.referrerReward;
        ledger(tx, db, { customerId: ref.referrerCustomerId, type: "REFERRAL", points: s.referrerReward, balanceAfter: ib, referenceId: ref.id, description: "Referral reward", createdBy: a.operatorUid, now });
        tx.set(db.doc(`${P.customers}/${ref.referrerCustomerId}`), { pointsBalance: ib, updatedAt: now }, { merge: true });
        tx.set(rRef, { ...ref, status: "REWARDED", qualifyingTransactionId: txId, qualifyingAmount: eligible, rewardedAt: now }, { merge: true });
        audit(tx, db, a.operatorUid, "REFERRAL_REWARDED", ref.id, { txId }, now);
        notifications.push({ customerId: ref.referrerCustomerId, type: "referralReferrer", vars: { referrerReward: s.referrerReward, pointsBalance: ib, balanceValue: balanceValue(ib, s) } });
        notifications.push({ customerId: cid, type: "referralInvitee", vars: { inviteeReward: s.inviteeReward, pointsBalance: bal, balanceValue: balanceValue(bal, s) } });
      } else tx.set(rRef, { ...ref, status: "REJECTED" }, { merge: true });
    }
    tx.set(cRef, { id: cid, phone, pointsBalance: bal, totalEligibleSpend: (cur.totalEligibleSpend || 0) + eligible, txCount: txCount + 1, referralCode,
      referredBy: ref ? ref.referrerCustomerId : cur.referredBy ?? null, loyaltyConsent: isNew ? true : cur.loyaltyConsent !== false, marketingConsent: cur.marketingConsent === true,
      authUid: cur.authUid ?? null, createdAt: cur.createdAt || now, updatedAt: now }, { merge: true });
    if (isNew) tx.set(db.doc(`${P.codes}/${referralCode}`), { customerId: cid, createdAt: now });
    notifications.unshift({ customerId: cid, type: "sale", transactionId: txId, vars: { amount: total, pointsEarned: points, pointsBalance: bal, balanceValue: balanceValue(bal, s), service: lines.map((l) => l.itemName).join(", ").slice(0, 60) } });
    return { duplicate: false, transaction: txDoc, customer: { id: cid, phone, pointsBalance: bal, referralCode }, notifications };
  });
}

export async function reverseSale(db: Db, a: { operatorUid: string; transactionId: unknown; reason: unknown }, now = Date.now()) {
  const id = String(a.transactionId ?? ""), reason = String(a.reason ?? "").trim();
  if (!id) throw new PerksError("invalid-argument", "Transaction id required.");
  if (reason.length < 3 || reason.length > 200) throw new PerksError("invalid-argument", "Give a reason (3 to 200 characters).");
  return db.runTransaction(async (tx) => {
    const tRef = db.doc(`${P.tx}/${id}`), tSnap = await tx.get(tRef);
    if (!tSnap.exists) throw new PerksError("not-found", "Transaction not found.");
    const t = tSnap.data() as Rec;
    if (t.status !== "COMPLETED") throw new PerksError("failed-precondition", "Only completed sales can be reversed.");
    const cRef = db.doc(`${P.customers}/${t.customerId}`), c = ((await tx.get(cRef)).data() || {}) as Rec;
    const bal: number = c.pointsBalance || 0;
    if (bal < t.pointsEarned) throw new PerksError("failed-precondition", "The customer has already spent these points; reverse the redemption first.");
    const after = bal - t.pointsEarned;
    if (t.pointsEarned > 0) ledger(tx, db, { customerId: t.customerId, type: "REVERSAL", points: -t.pointsEarned, balanceAfter: after, referenceId: id, description: `Reversal of ${id}: ${reason}`, createdBy: a.operatorUid, now });
    tx.set(tRef, { status: "REVERSED", reversedAt: now, reversedBy: a.operatorUid, reversalReason: reason }, { merge: true });
    tx.set(cRef, { pointsBalance: after, totalEligibleSpend: Math.max(0, (c.totalEligibleSpend || 0) - t.eligibleAmount), updatedAt: now }, { merge: true });
    audit(tx, db, a.operatorUid, "SALE_REVERSED", id, { reason }, now);
    return { reversed: true, pointsBalance: after };
  });
}

// ───────────────────────── redemption (operator only) ─────────────────────────
export async function redeem(db: Db, a: { operatorUid: string; phone: unknown; points: unknown; idempotencyKey: unknown }, now = Date.now()) {
  const key = need(a.idempotencyKey), cid = customerId(toE164(a.phone)), pts = cleanPoints(a.points), rid = "R" + sha(`${a.operatorUid}:${key}`).slice(0, 20);
  return db.runTransaction(async (tx) => {
    const sRef = db.doc(`${P.settings}/main`), cRef = db.doc(`${P.customers}/${cid}`), rRef = db.doc(`${P.redemptions}/${rid}`);
    const [sSnap, cSnap, rSnap] = await Promise.all([tx.get(sRef), tx.get(cRef), tx.get(rRef)]);
    if (rSnap.exists) return { duplicate: true, redemption: rSnap.data() as Rec, notifications: [] as Notification[] };
    if (!cSnap.exists) throw new PerksError("not-found", "Customer not found.");
    const s = settingsFrom(sSnap.data()), c = cSnap.data() as Rec, bal: number = c.pointsBalance || 0;
    if (pts < s.minimumRedemption) throw new PerksError("failed-precondition", `Minimum redemption is ${s.minimumRedemption} points.`);
    if (pts > bal) throw new PerksError("failed-precondition", "Customer does not have enough points.");
    const value = redemptionValueKes(pts, s), after = bal - pts;
    ledger(tx, db, { customerId: cid, type: "REDEEM", points: -pts, balanceAfter: after, referenceId: rid, description: "Redeemed in shop", createdBy: a.operatorUid, now });
    const redemption = { id: rid, customerId: cid, phone: c.phone, points: pts, valueKes: value, balanceAfter: after, createdBy: a.operatorUid, createdAt: now };
    tx.set(rRef, redemption);
    tx.set(cRef, { pointsBalance: after, updatedAt: now }, { merge: true });
    return { duplicate: false, redemption, notifications: [{ customerId: cid, type: "redeem", vars: { pointsRedeemed: pts, discount: value, pointsBalance: after, balanceValue: balanceValue(after, s) } }] as Notification[] };
  });
}

/** Operator adds a customer by phone (no name, no sale). Idempotent: an existing customer is returned unchanged. */
export async function createCustomer(db: Db, a: { operatorUid: string; phone: unknown }, now = Date.now()) {
  const phone = toE164(a.phone), cid = customerId(phone);
  return db.runTransaction(async (tx) => {
    const cRef = db.doc(`${P.customers}/${cid}`), snap = await tx.get(cRef);
    if (snap.exists) return { created: false, customer: snap.data() as Rec, notifications: [] as Notification[] };
    const code = await allocCode(tx, db);
    const customer = { id: cid, phone, pointsBalance: 0, totalEligibleSpend: 0, txCount: 0, referralCode: code, referredBy: null, loyaltyConsent: true, marketingConsent: false, authUid: null, createdAt: now, updatedAt: now };
    tx.set(cRef, customer);
    tx.set(db.doc(`${P.codes}/${code}`), { customerId: cid, createdAt: now });
    audit(tx, db, a.operatorUid, "CUSTOMER_CREATED", cid, {}, now);
    return { created: true, customer: customer as Rec, notifications: [{ customerId: cid, type: "welcome", vars: { referralCode: code } }] as Notification[] };
  });
}

// ───────────────────────── referrals ─────────────────────────
export async function registerReferral(db: Db, a: { operatorUid: string; inviteePhone: unknown; code: unknown }, now = Date.now()) {
  const phone = toE164(a.inviteePhone), cid = customerId(phone), code = normCode(a.code);
  return db.runTransaction(async (tx) => {
    const cRef = db.doc(`${P.customers}/${cid}`), rRef = db.doc(`${P.referrals}/${cid}`), kRef = db.doc(`${P.codes}/${code}`), sRef = db.doc(`${P.settings}/main`);
    const [cSnap, rSnap, kSnap, sSnap] = await Promise.all([tx.get(cRef), tx.get(rRef), tx.get(kRef), tx.get(sRef)]);
    if (!kSnap.exists) throw new PerksError("not-found", "Referral code not found.");
    const inviterId = (kSnap.data() as Rec).customerId as string;
    if (inviterId === cid) throw new PerksError("failed-precondition", "Self-referral is not allowed.");
    if (rSnap.exists) throw new PerksError("already-exists", "This customer already has a referrer.");
    if (cSnap.exists && (cSnap.data() as Rec).txCount > 0) throw new PerksError("failed-precondition", "Only a new customer can be referred.");
    const s = settingsFrom(sSnap.data());
    const newCode = cSnap.exists ? (cSnap.data() as Rec).referralCode : await allocCode(tx, db);
    const ref = { id: cid, referrerCustomerId: inviterId, referredCustomerId: cid, referralCode: code, status: "PENDING", referrerReward: s.referrerReward, inviteeReward: s.inviteeReward, qualifyingTransactionId: null, qualifyingAmount: null, drawResult: null, createdAt: now, rewardedAt: null };
    tx.set(rRef, ref);
    tx.set(cRef, { id: cid, phone, pointsBalance: 0, totalEligibleSpend: 0, txCount: 0, referralCode: newCode, referredBy: inviterId, loyaltyConsent: true, marketingConsent: false, authUid: null, createdAt: now, updatedAt: now }, { merge: true });
    if (!cSnap.exists) tx.set(db.doc(`${P.codes}/${newCode}`), { customerId: cid, createdAt: now });
    audit(tx, db, a.operatorUid, "REFERRAL_REGISTERED", cid, { code }, now);
    return ref;
  });
}

// ───────────────────────── vouchers (single use, status-guarded) ─────────────────────────
const VTYPES: VoucherType[] = ["DISCOUNT", "AIRTIME", "POINTS"];
const voucherText = (t: string, v: number) => (t === "POINTS" ? `${v} points` : t === "AIRTIME" ? `KES ${v} airtime` : `KES ${v} off`);
export async function createVoucher(db: Db, a: { operatorUid: string; type: unknown; value: unknown; expiresAt?: unknown; campaignId?: unknown }, now = Date.now()) {
  if (!VTYPES.includes(a.type as VoucherType)) throw new PerksError("invalid-argument", "Voucher type must be DISCOUNT, AIRTIME or POINTS.");
  const value = cleanMoney(a.value, false, "Voucher value"), type = a.type as VoucherType;
  const expiresAt = a.expiresAt ? Number(a.expiresAt) : null;
  if (expiresAt !== null && !(expiresAt > now)) throw new PerksError("invalid-argument", "Expiry must be in the future.");
  for (let i = 0; i < 6; i++) {
    const code = `${type.slice(0, 4)}${value}-${makeCode(5)}`;
    try {
      await db.doc(`${P.vouchers}/${code}`).create({ id: code, code, type, value, status: "AVAILABLE", customerId: null, campaignId: a.campaignId ? String(a.campaignId) : null, expiresAt, createdBy: a.operatorUid, createdAt: now, redeemedAt: null });
      return { id: code, code, type, value };
    } catch (e) { if ((e as { code?: number }).code !== 6) throw e; }
  }
  throw new PerksError("aborted", "Could not create a unique voucher code.");
}
export async function assignVoucher(db: Db, a: { operatorUid: string; voucherId: unknown; phone: unknown }, now = Date.now()) {
  const vid = String(a.voucherId ?? ""), cid = customerId(toE164(a.phone));
  return db.runTransaction(async (tx) => {
    const vRef = db.doc(`${P.vouchers}/${vid}`), cRef = db.doc(`${P.customers}/${cid}`), sRef = db.doc(`${P.settings}/main`);
    const [vSnap, cSnap, sSnap] = await Promise.all([tx.get(vRef), tx.get(cRef), tx.get(sRef)]);
    if (!vSnap.exists) throw new PerksError("not-found", "Voucher not found.");
    if (!cSnap.exists) throw new PerksError("not-found", "Customer not found.");
    const v = vSnap.data() as Rec, c = cSnap.data() as Rec, s = settingsFrom(sSnap.data());
    if (v.status !== "AVAILABLE") throw new PerksError("failed-precondition", "Voucher is not available.");
    if (v.expiresAt && v.expiresAt < now) throw new PerksError("failed-precondition", "Voucher has expired.");
    let bal: number = c.pointsBalance || 0;
    const patch: Rec = { customerId: cid, status: "AWARDED", awardedAt: now };
    if (v.type === "POINTS") { bal += v.value; ledger(tx, db, { customerId: cid, type: "VOUCHER", points: v.value, balanceAfter: bal, referenceId: vid, description: `Voucher ${vid}`, createdBy: a.operatorUid, now }); tx.set(cRef, { pointsBalance: bal, updatedAt: now }, { merge: true }); patch.status = "REDEEMED"; patch.redeemedAt = now; }
    tx.set(vRef, patch, { merge: true });
    audit(tx, db, a.operatorUid, "VOUCHER_ASSIGNED", vid, { customerId: cid }, now);
    return { voucherId: vid, status: patch.status as VoucherStatus, notifications: [{ customerId: cid, type: "voucher", vars: { voucherCode: vid, voucherValue: voucherText(v.type, v.value), pointsBalance: bal, balanceValue: balanceValue(bal, s) } }] as Notification[] };
  });
}
export async function setVoucherStatus(db: Db, a: { operatorUid: string; voucherId: unknown; status: unknown }, now = Date.now()) {
  const vid = String(a.voucherId ?? ""), next = a.status;
  if (next !== "REDEEMED" && next !== "VOID") throw new PerksError("invalid-argument", "Status must be REDEEMED or VOID.");
  return db.runTransaction(async (tx) => {
    const vRef = db.doc(`${P.vouchers}/${vid}`), snap = await tx.get(vRef);
    if (!snap.exists) throw new PerksError("not-found", "Voucher not found.");
    const v = snap.data() as Rec;
    if (next === "REDEEMED" && v.status !== "AWARDED") throw new PerksError("failed-precondition", "Only an awarded voucher can be redeemed.");
    if (next === "VOID" && v.status !== "AVAILABLE" && v.status !== "AWARDED") throw new PerksError("failed-precondition", "This voucher can no longer be voided.");
    tx.set(vRef, { status: next, ...(next === "REDEEMED" ? { redeemedAt: now } : { voidedAt: now }) }, { merge: true });
    audit(tx, db, a.operatorUid, `VOUCHER_${next}`, vid, {}, now);
    return { voucherId: vid, status: next };
  });
}

// ───────────────────────── campaigns, templates, settings, consent ─────────────────────────
export async function saveCampaign(db: Db, a: { operatorUid: string; id?: unknown; name: unknown; advert: unknown; destinationUrl: unknown; priority?: unknown; startDate?: unknown; endDate?: unknown; promotes?: unknown }, now = Date.now()) {
  const name = String(a.name ?? "").trim(), advert = String(a.advert ?? "").trim(), url = String(a.destinationUrl ?? "").trim();
  if (name.length < 2 || name.length > 60) throw new PerksError("invalid-argument", "Campaign name must be 2 to 60 characters.");
  if (advert.length < 5 || advert.length > 160) throw new PerksError("invalid-argument", "Advert must be 5 to 160 characters.");
  if (!/^https:\/\/[^\s]+$/.test(url) || url.length > 200) throw new PerksError("invalid-argument", "Destination must be an https link.");
  const day = (v: unknown) => { const t = String(v ?? ""); if (t && !/^\d{4}-\d{2}-\d{2}$/.test(t)) throw new PerksError("invalid-argument", "Dates must be YYYY-MM-DD."); return t || null; };
  const startDate = day(a.startDate), endDate = day(a.endDate);
  if (startDate && endDate && endDate < startDate) throw new PerksError("invalid-argument", "End date is before the start date.");
  const id = a.id ? String(a.id) : "K" + makeCode(7), ref = db.doc(`${P.campaigns}/${id}`), snap = await ref.get();
  if (a.id && !snap.exists) throw new PerksError("not-found", "Campaign not found.");
  const doc = { id, name, advert, destinationUrl: url, priority: Math.max(1, Math.min(99, Number(a.priority) || 1)), startDate, endDate, promotes: String(a.promotes ?? "").slice(0, 80), active: snap.exists ? (snap.data() as Rec).active !== false : true, createdAt: snap.exists ? (snap.data() as Rec).createdAt : now, updatedAt: now };
  await ref.set(doc, { merge: true });
  return doc;
}
export async function setCampaignActive(db: Db, a: { id: unknown; active: unknown }, now = Date.now()) {
  const id = String(a.id ?? ""), ref = db.doc(`${P.campaigns}/${id}`);
  if (!(await ref.get()).exists) throw new PerksError("not-found", "Campaign not found.");
  await ref.set({ active: a.active === true, updatedAt: now }, { merge: true });
  if (a.active !== true) { const s = await getSettings(db); if (s.activeCampaignId === id) await db.doc(`${P.settings}/main`).set({ activeCampaignId: "" }, { merge: true }); }
  return { id, active: a.active === true };
}
export async function setActiveCampaign(db: Db, a: { id: unknown }, now = Date.now()) {
  const id = String(a.id ?? ""), snap = await db.doc(`${P.campaigns}/${id}`).get();
  if (!snap.exists) throw new PerksError("not-found", "Campaign not found.");
  if (!campaignLive(snap.data() as Rec as never, now)) throw new PerksError("failed-precondition", "That campaign is paused or outside its dates.");
  await db.doc(`${P.settings}/main`).set({ activeCampaignId: id }, { merge: true });
  return { activeCampaignId: id };
}
export async function saveTemplate(db: Db, a: { operatorUid: string; id: unknown; body: unknown; active?: unknown }, now = Date.now()) {
  const id = String(a.id ?? "");
  if (!(TEMPLATE_IDS as string[]).includes(id)) throw new PerksError("invalid-argument", "Unknown template.");
  const body = validateTemplateBody(a.body);
  await db.doc(`${P.templates}/${id}`).set({ id, body, active: a.active !== false, updatedAt: now, updatedBy: a.operatorUid }, { merge: true });
  return { id, body };
}
const NUM_KEYS: Record<string, [number, number]> = { servicesPointsRate: [0, 100], productsPointsRate: [0, 100], minimumRedemption: [1, 100000], referrerReward: [0, 10000], inviteeReward: [0, 10000], referralMinimumPurchase: [0, 100000], smsCost: [0, 50] };
/** drawProductionApproved is deliberately NOT editable here (legal/regulatory sign-off is a console-only change). Rates apply to new sales only. */
export async function updateSettings(db: Db, a: { operatorUid: string; patch: unknown }, now = Date.now()) {
  const p = (a.patch ?? {}) as Rec, out: Rec = {};
  for (const [k, [lo, hi]] of Object.entries(NUM_KEYS)) if (p[k] !== undefined) { const n = Number(p[k]); if (!Number.isFinite(n) || n < lo || n > hi) throw new PerksError("invalid-argument", `${k} must be between ${lo} and ${hi}.`); out[k] = k === "smsCost" ? n : Math.floor(n); }
  if (p.referralDrawEnabled !== undefined) out.referralDrawEnabled = p.referralDrawEnabled === true;
  if (!Object.keys(out).length) throw new PerksError("invalid-argument", "Nothing to update.");
  await db.runTransaction(async (tx) => { tx.set(db.doc(`${P.settings}/main`), out, { merge: true }); audit(tx, db, a.operatorUid, "SETTINGS_UPDATED", "main", { keys: Object.keys(out) }, now); });
  return getSettings(db);
}
export async function setMarketingConsent(db: Db, a: { customerId: string; marketing: boolean; source: string; actor: string }, now = Date.now()) {
  return db.runTransaction(async (tx) => {
    const cRef = db.doc(`${P.customers}/${a.customerId}`), snap = await tx.get(cRef);
    if (!snap.exists) throw new PerksError("not-found", "Customer not found.");
    tx.set(cRef, { marketingConsent: a.marketing === true, marketingConsentUpdatedAt: now, updatedAt: now }, { merge: true });
    tx.set(db.collection(P.consentLog).doc(), { customerId: a.customerId, kind: "marketing", value: a.marketing === true, source: a.source, actor: a.actor, createdAt: now });
    return { marketingConsent: a.marketing === true };
  });
}
