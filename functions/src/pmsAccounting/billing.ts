// What the PMS account holder has PAID Samuhia for the app itself: plan subscriptions and SMS credits.
// PMS shows these as business expenses in the agent's accounts. Both source collections are server-only (Firestore rules deny
// every client), so the PMS app reads them through the callable in ./index.ts. This file is PURE: no Firestore, no clock.

export interface BillingRow {
  kind: "subscription" | "sms";
  reference: string;
  /** KES actually paid (gross, what left the account holder's M-Pesa). */
  amount: number;
  /** ISO timestamp of the completed payment. */
  paidAt: string;
  planId?: string;
  planName?: string;
  /** How many months this payment covers, for spreading an annual plan over its year. 1 for monthly plans and SMS. */
  periodMonths: number;
  tokens?: number;
}

type Doc = Record<string, unknown>;
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Firestore Timestamp | Date | ISO string | millis -> ISO string ("" when unknown). */
export function toIso(v: unknown): string {
  if (!v) return "";
  if (typeof v === "string") { const d = new Date(v); return Number.isNaN(d.getTime()) ? "" : d.toISOString(); }
  if (typeof v === "number") return new Date(v).toISOString();
  const o = v as { toDate?: () => Date; seconds?: number; _seconds?: number };
  if (typeof o.toDate === "function") return o.toDate().toISOString();
  const sec = o.seconds ?? o._seconds;
  return typeof sec === "number" ? new Date(sec * 1000).toISOString() : "";
}

/** subscriptions/{SUB_…}. Paystack's real amount (kobo) wins over any amount field the writer stored. */
export function subscriptionRow(reference: string, d: Doc): BillingRow | null {
  if (str(d.status) !== "success") return null;
  const resp = (d.paystackResponse ?? {}) as Doc;
  const kes = num(resp.amount) > 0 ? num(resp.amount) / 100 : num(d.amount);
  const paidAt = toIso(d.completedAt) || toIso(d.paidAt) || toIso(d.createdAt);
  if (!(kes > 0) || !paidAt) return null;
  const days = num(d.daysToAdd) || 30;
  return {
    kind: "subscription", reference, amount: Math.round(kes * 100) / 100, paidAt,
    planId: str(d.planId) || undefined, planName: str(d.planName) || undefined,
    periodMonths: days >= 300 ? 12 : Math.max(1, Math.round(days / 30)),
  };
}

/** sms-topup-transactions/{SMS_…} (PMS top-ups only; MyRegister ones live in another project). */
export function smsRow(reference: string, d: Doc): BillingRow | null {
  if (str(d.status) !== "success") return null;
  const kes = num(d.grossAmount) > 0 ? num(d.grossAmount) : num(d.amountKes) > 0 ? num(d.amountKes) : num(d.amount);
  const paidAt = toIso(d.completedAt) || toIso(d.createdAt);
  if (!(kes > 0) || !paidAt) return null;
  return { kind: "sms", reference, amount: Math.round(kes * 100) / 100, paidAt, periodMonths: 1, tokens: num(d.tokens) || undefined };
}

/** Newest first, capped, so a very old account cannot return an unbounded payload. */
export function mergeBilling(rows: Array<BillingRow | null>, cap = 500): BillingRow[] {
  return rows.filter((r): r is BillingRow => r !== null).sort((a, b) => b.paidAt.localeCompare(a.paidAt)).slice(0, cap);
}
