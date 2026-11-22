// Action dispatch for the two callables. No firebase-functions import here, so it is unit-testable and portable.
import type { firestore } from "firebase-admin";
import { P, PerksError } from "./types";
import * as ops from "./ops";
import { dispatch, retrySms, type Sender } from "./notify";
import { customerId, toE164 } from "./rules";

type Db = firestore.Firestore;
type Rec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const LISTABLE: Record<string, string> = { customers: P.customers, tx: P.tx, ledger: P.ledger, referrals: P.referrals, redemptions: P.redemptions, vouchers: P.vouchers, campaigns: P.campaigns, templates: P.templates, smsLog: P.smsLog, audit: P.audit };

async function recent(db: Db, coll: string, n: number, since?: number): Promise<Rec[]> {
  let q: firestore.Query = db.collection(coll);
  if (since) q = q.where("createdAt", ">=", since);
  const snap = await q.orderBy("createdAt", "desc").limit(n).get();
  return snap.docs.map((d) => d.data() as Rec);
}
async function forCustomer(db: Db, coll: string, cid: string, n: number): Promise<Rec[]> {
  const q = await db.collection(coll).where("customerId", "==", cid).orderBy("createdAt", "desc").limit(n).get();
  return q.docs.map((d) => d.data() as Rec);
}

export async function handleOperator(db: Db, send: Sender, uid: string, action: string, p: Rec): Promise<unknown> {
  const withUid = { operatorUid: uid };
  const sms = async <T extends { notifications?: import("./types").Notification[] }>(r: T): Promise<T> => { await dispatch(db, send, r.notifications || []); return r; };
  switch (action) {
    case "recordSale": return sms(await ops.recordSale(db, { ...p, ...withUid } as never));
    case "redeem": return sms(await ops.redeem(db, { ...p, ...withUid } as never));
    case "reverseSale": return ops.reverseSale(db, { ...withUid, transactionId: p.transactionId, reason: p.reason });
    case "createCustomer": return sms(await ops.createCustomer(db, { operatorUid: uid, phone: p.phone }));
    case "registerReferral": return ops.registerReferral(db, { ...withUid, inviteePhone: p.inviteePhone, code: p.code });
    case "createVoucher": return ops.createVoucher(db, { ...withUid, type: p.type, value: p.value, expiresAt: p.expiresAt, campaignId: p.campaignId });
    case "bulkVouchers": {
      const n = Math.min(20, Math.max(1, Number(p.count) || 5)), out = [];
      for (let i = 0; i < n; i++) out.push(await ops.createVoucher(db, { ...withUid, type: p.type, value: p.value }));
      return { created: out.length, vouchers: out };
    }
    case "assignVoucher": return sms(await ops.assignVoucher(db, { ...withUid, voucherId: p.voucherId, phone: p.phone }));
    case "setVoucherStatus": return ops.setVoucherStatus(db, { ...withUid, voucherId: p.voucherId, status: p.status });
    case "saveCampaign": return ops.saveCampaign(db, { ...p, ...withUid } as never);
    case "setCampaignActive": return ops.setCampaignActive(db, { id: p.id, active: p.active });
    case "setActiveCampaign": return ops.setActiveCampaign(db, { id: p.id });
    case "saveTemplate": return ops.saveTemplate(db, { ...withUid, id: p.id, body: p.body, active: p.active });
    case "updateSettings": return ops.updateSettings(db, { ...withUid, patch: p.patch });
    case "getSettings": return ops.getSettings(db);
    case "retrySms": return retrySms(db, send, { id: p.id });
    case "setConsent": return ops.setMarketingConsent(db, { customerId: customerId(toE164(p.phone)), marketing: p.marketing === true, source: "operator", actor: uid });
    case "runDraw": {
      const s = await ops.getSettings(db);
      if (!s.referralDrawEnabled || !s.drawProductionApproved) throw new PerksError("failed-precondition", "The reward draw is disabled pending legal and regulatory review.");
      throw new PerksError("unimplemented", "The reward draw is not implemented.");
    }
    case "getCustomer": {
      const cid = customerId(toE164(p.phone)), c = await db.doc(`${P.customers}/${cid}`).get();
      if (!c.exists) return { found: false };
      const [tx, ledger, smsLog, vouchers] = await Promise.all([P.tx, P.ledger, P.smsLog, P.vouchers].map((k) => forCustomer(db, k, cid, 50)));
      return { found: true, customer: c.data(), tx, ledger, smsLog, vouchers };
    }
    case "list": {
      const coll = LISTABLE[String(p.collection)];
      if (!coll) throw new PerksError("invalid-argument", "Unknown collection.");
      const since = Number(p.since) > 0 ? Number(p.since) : undefined;
      return { items: await recent(db, coll, Math.min(1000, Math.max(1, Number(p.limit) || 50)), since) };
    }
    default: throw new PerksError("invalid-argument", "Unknown action.");
  }
}

/** Customers only ever see their own account. The phone comes from the verified OTP token, never from the request. */
export async function handleCustomer(db: Db, who: { uid: string; phone: string }, action: string, p: Rec): Promise<unknown> {
  const cid = customerId(toE164(who.phone)), ref = db.doc(`${P.customers}/${cid}`), snap = await ref.get();
  if (!snap.exists) return { registered: false };
  const c = snap.data() as Rec;
  if (!c.authUid) await ref.set({ authUid: who.uid }, { merge: true });
  else if (c.authUid !== who.uid) throw new PerksError("permission-denied", "This account is linked to a different sign-in.");
  switch (action) {
    case "summary": {
      const [tx, ledger, vouchers, refs] = await Promise.all([forCustomer(db, P.tx, cid, 50), forCustomer(db, P.ledger, cid, 50), forCustomer(db, P.vouchers, cid, 50),
        db.collection(P.referrals).where("referrerCustomerId", "==", cid).get().then((q) => q.docs.map((d) => d.data() as Rec))]);
      const strip = ({ authUid: _a, ...rest }: Rec) => rest; // eslint-disable-line @typescript-eslint/no-unused-vars
      return { registered: true, customer: strip(c), tx, ledger, vouchers, referrals: refs.map((r) => ({ status: r.status, createdAt: r.createdAt, rewardedAt: r.rewardedAt })) };
    }
    case "setMarketing": return ops.setMarketingConsent(db, { customerId: cid, marketing: p.value === true, source: "customer", actor: who.uid });
    default: throw new PerksError("invalid-argument", "Unknown action.");
  }
}
