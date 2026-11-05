// Lipa Mos Mos plans and the tenant-facing callables. Public callables like processPayment: nothing in a request can choose WHERE
// money goes (that is the landlord's sealed recipient) or HOW MUCH is credited (recomputed here and verified with Paystack later).
import * as admin from "firebase-admin";
import axios from "axios";
import * as crypto from "crypto";
import { HttpsError, onCall, CallableRequest } from "firebase-functions/v2/https";
import { PAYSTACK_API_BASE, PAYSTACK_SECRET_KEY } from "../desk/paystack";
import { checkSafaricomPhone, toMsisdn } from "../phone/safaricom";
import { FREQUENCY_DAYS, LMM, isFrequency, type Frequency } from "./config";
import { chargeFor, isValidCredit } from "./fees";
import { openInvoices } from "./invoices";
import { sendOnce, lmmText } from "./sms";

import { BUNDLE_SECRETS } from "../secretsBundle";

const db = () => admin.firestore();
export const plansCol = () => db().collection("lmm_plans");
export const paymentsCol = () => db().collection("lmm_payments");

export interface PlanDoc {
  agentId: string; tenantId: string; tenantName: string; tenantPhone: string; frequency: Frequency; status: "active" | "paused";
  creditedMinor: number;     // confirmed by Paystack, waiting in Samuhia's account for the next settlement
  inFlightMinor: number;     // being transferred to the landlord right now
  settledTotalMinor: number; unappliedMinor: number;   // paid out to the landlord but not yet matched to an invoice
  settleSeq: number; lastPaymentAt: number; lastSmsAt: number; missedCount: number; milestonesSent: number[];
  createdAt: number;
}
export const planIdOf = (agentId: string, tenantId: string): string => `${agentId}_${tenantId}`;
const asId = (v: unknown, label: string): string => {
  const s = String(v ?? "").trim();
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(s)) throw new HttpsError("invalid-argument", `${label} is not valid`);
  return s;
};

/** Lipa Mos Mos is offered only when the landlord has a sealed, active recipient and the feature has not been paused. (Firestore can only pause it.) */
export async function lmmAvailable(agentId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const [cfg, rec] = await Promise.all([db().collection("lmm_config").doc("global").get(), db().collection("lmm_recipients").doc(agentId).get()]);
  if (cfg.exists && cfg.data()?.enabled === false) return { ok: false, reason: "Lipa Mos Mos is paused right now. Please try again later." };
  const r = rec.data();
  if (!r || r.status !== "active") return { ok: false, reason: "This landlord has not enabled Lipa Mos Mos yet." };
  return { ok: true };
}

async function loadTenant(agentId: string, tenantId: string) {
  const snap = await db().collection("users").doc(agentId).collection("tenants").doc(tenantId).get();
  if (!snap.exists) throw new HttpsError("not-found", "Tenant not found");
  const t = snap.data() as Record<string, any>;
  return { name: String(t.name ?? ""), phone: String(t.phone ?? ""), rentMinor: Math.max(0, Math.round((Number(t.rentAmount) || 0) * 100)), active: t.isActive !== false };
}

/** What the tenant owes right now: every open invoice (less money already paid to the landlord but not yet matched), else one month's rent. */
export async function resolveTarget(agentId: string, tenantId: string, plan?: Pick<PlanDoc, "unappliedMinor">): Promise<{ targetMinor: number; basis: "invoices" | "rent" }> {
  const open = await openInvoices(agentId, tenantId);
  const unapplied = plan?.unappliedMinor ?? 0;
  if (open.length > 0) return { targetMinor: Math.max(0, open.reduce((s, i) => s + i.outstandingMinor, 0) - unapplied), basis: "invoices" };
  const t = await loadTenant(agentId, tenantId);
  return { targetMinor: Math.max(0, t.rentMinor - unapplied), basis: "rent" };
}

/** Settlement day: the next 5th (Nairobi time), as YYYY-MM-DD. */
export function nextSettleOn(now: number): string {
  const d = new Date(now + 3 * 3_600_000);
  let y = d.getUTCFullYear(), m = d.getUTCMonth();
  if (d.getUTCDate() > LMM.SETTLE_DAY) { m += 1; if (m > 11) { m = 0; y += 1; } }
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(LMM.SETTLE_DAY).padStart(2, "0")}`;
}

/** A sensible instalment: what is left, spread over the payments between now and the 5th (never below the minimum, never above what is owed). */
export function suggestInstalment(remainingMinor: number, frequency: Frequency, now: number): number {
  if (remainingMinor <= 0) return 0;
  const days = Math.max(1, Math.round((Date.parse(`${nextSettleOn(now)}T00:00:00+03:00`) - now) / 86_400_000));
  const periods = Math.max(1, Math.floor(days / FREQUENCY_DAYS[frequency]));
  const each = Math.ceil(remainingMinor / periods / 100) * 100;
  return Math.min(remainingMinor, Math.max(LMM.MIN_CREDIT_MINOR, Math.min(each, LMM.MAX_CREDIT_MINOR)));
}

async function ensurePlan(agentId: string, tenantId: string, frequency: Frequency, now: number): Promise<{ id: string; plan: PlanDoc; created: boolean }> {
  const id = planIdOf(agentId, tenantId);
  const ref = plansCol().doc(id);
  const snap = await ref.get();
  if (snap.exists) {
    const p = snap.data() as PlanDoc;
    if (p.frequency !== frequency) await ref.update({ frequency });
    return { id, plan: { ...p, frequency }, created: false };
  }
  const t = await loadTenant(agentId, tenantId);
  if (!t.active) throw new HttpsError("failed-precondition", "This tenancy is not active");
  const plan: PlanDoc = {
    agentId, tenantId, tenantName: t.name, tenantPhone: t.phone, frequency, status: "active", creditedMinor: 0, inFlightMinor: 0, settledTotalMinor: 0,
    unappliedMinor: 0, settleSeq: 0, lastPaymentAt: 0, lastSmsAt: 0, missedCount: 0, milestonesSent: [], createdAt: now,
  };
  try { await ref.create(plan); } catch (e) { if ((e as { code?: number }).code !== 6) throw e; }
  return { id, plan, created: true };
}

const view = async (id: string, plan: PlanDoc, now: number) => {
  const { targetMinor, basis } = await resolveTarget(plan.agentId, plan.tenantId, plan);
  const remaining = Math.max(0, targetMinor - plan.creditedMinor);
  return {
    planId: id, frequency: plan.frequency, status: plan.status, basis, targetMinor, creditedMinor: plan.creditedMinor, remainingMinor: remaining,
    pct: targetMinor > 0 ? Math.min(100, Math.floor((plan.creditedMinor * 100) / targetMinor)) : 100,
    settlesOn: nextSettleOn(now), suggestedMinor: suggestInstalment(remaining, plan.frequency, now),
  };
};

type Req = { agentId?: unknown; tenantId?: unknown; frequency?: unknown; amount?: unknown; phone?: unknown };
const opts = { region: "africa-south1", cors: true, timeoutSeconds: 60, memory: "256MiB" as const, maxInstances: 10 };

export const lmm_getPlan = onCall(opts, async (request: CallableRequest<Req>) => {
  const agentId = asId(request.data?.agentId, "agentId"), tenantId = asId(request.data?.tenantId, "tenantId");
  const avail = await lmmAvailable(agentId);
  if (!avail.ok) return { available: false, reason: avail.reason };
  const snap = await plansCol().doc(planIdOf(agentId, tenantId)).get();
  const now = Date.now();
  if (!snap.exists) {
    const { targetMinor, basis } = await resolveTarget(agentId, tenantId);
    return { available: true, plan: null, targetMinor, basis, settlesOn: nextSettleOn(now), suggestedMinor: suggestInstalment(targetMinor, "weekly", now) };
  }
  return { available: true, plan: await view(snap.id, snap.data() as PlanDoc, now) };
});

export const lmm_start = onCall({ ...opts, secrets: BUNDLE_SECRETS }, async (request: CallableRequest<Req>) => {
  const agentId = asId(request.data?.agentId, "agentId"), tenantId = asId(request.data?.tenantId, "tenantId");
  if (!isFrequency(request.data?.frequency)) throw new HttpsError("invalid-argument", "Choose daily, weekly or biweekly");
  const avail = await lmmAvailable(agentId);
  if (!avail.ok) throw new HttpsError("failed-precondition", avail.reason);
  const now = Date.now();
  const { id, plan, created } = await ensurePlan(agentId, tenantId, request.data.frequency, now);
  const v = await view(id, plan, now);
  if (created && plan.tenantPhone && v.targetMinor > 0) {
    await sendOnce(`start_${id}`, toMsisdn(plan.tenantPhone), lmmText.started({ name: plan.tenantName, targetMinor: v.targetMinor }));
  }
  return { available: true, plan: v };
});

export const lmm_pay = onCall({ ...opts, secrets: BUNDLE_SECRETS }, async (request: CallableRequest<Req>) => {
  const agentId = asId(request.data?.agentId, "agentId"), tenantId = asId(request.data?.tenantId, "tenantId");
  const phone = checkSafaricomPhone(request.data?.phone);
  if (!phone.ok) throw new HttpsError("invalid-argument", phone.message);
  const credit = Math.round(Number(request.data?.amount) * 100);
  if (!isValidCredit(credit)) throw new HttpsError("invalid-argument", `Enter a whole-shilling amount from KES ${LMM.MIN_CREDIT_MINOR / 100} to KES ${(LMM.MAX_CREDIT_MINOR / 100).toLocaleString("en-KE")}`);
  const avail = await lmmAvailable(agentId);
  if (!avail.ok) throw new HttpsError("failed-precondition", avail.reason);

  const now = Date.now();
  const freq: Frequency = isFrequency(request.data?.frequency) ? request.data.frequency : "weekly";
  const { id, plan } = await ensurePlan(agentId, tenantId, freq, now);
  if (plan.status !== "active") throw new HttpsError("failed-precondition", "This plan is paused");
  const { targetMinor } = await resolveTarget(agentId, tenantId, plan);
  const remaining = targetMinor - plan.creditedMinor;
  if (remaining <= 0) throw new HttpsError("failed-precondition", "Your rent is already fully covered. Your landlord will be paid shortly.");
  if (credit > remaining) throw new HttpsError("invalid-argument", `That is more than you owe. The balance is KES ${(remaining / 100).toLocaleString("en-KE")}.`);

  // no double prompts, no runaway attempts
  const recent = await paymentsCol().where("planId", "==", id).where("createdAt", ">", now - 24 * 3_600_000).get();
  if (recent.docs.some((d) => d.data().status === "initiating" || (d.data().status === "pending" && now - Number(d.data().createdAt) < 3 * 60_000))) {
    throw new HttpsError("failed-precondition", "A payment prompt is already waiting on your phone. Please finish it, or wait a few minutes.");
  }
  if (recent.size >= 20) throw new HttpsError("resource-exhausted", "Too many attempts today. Please try again tomorrow.");

  const c = chargeFor(credit);
  const reference = `LMM_${tenantId}_${now.toString(36)}${crypto.randomBytes(3).toString("hex")}`.slice(0, 60);
  const email = `tenant${tenantId}@samuhia.co.ke`;
  await paymentsCol().doc(reference).set({
    reference, planId: id, agentId, tenantId, phone: phone.e164, creditMinor: c.creditMinor, chargeMinor: c.chargeMinor, surchargeMinor: c.surchargeMinor,
    surchargeBps: c.surchargeBps, status: "initiating", settled: false, createdAt: now,
  });
  try {
    // NO split_code and NO subaccount: the money lands in Samuhia's own Paystack balance and waits for settlement.
    const res = await axios.post(`${PAYSTACK_API_BASE}/charge`, {
      email, amount: c.chargeMinor, currency: "KES", mobile_money: { phone: phone.e164, provider: "mpesa" }, reference,
      metadata: { lmm: true, planId: id, creditMinor: c.creditMinor, chargeMinor: c.chargeMinor },
    }, { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY.value()}`, "Content-Type": "application/json" }, timeout: 30_000 });
    if (!res.data?.status) throw new Error(res.data?.message || "Paystack refused the charge");
    await paymentsCol().doc(reference).update({ status: "pending" });
    return { reference, status: res.data.data?.status ?? "pending", displayText: res.data.data?.display_text || "Check your phone for the M-PESA prompt", creditMinor: c.creditMinor, chargeMinor: c.chargeMinor, surchargeMinor: c.surchargeMinor };
  } catch (err) {
    await paymentsCol().doc(reference).update({ status: "failed", error: String((err as Error)?.message ?? err).slice(0, 200) });
    const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message || (err as Error)?.message || "Could not start the payment";
    throw new HttpsError("internal", `Payment could not be started: ${msg}`);
  }
});
