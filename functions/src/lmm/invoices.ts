// Reading a tenant's open invoices and crediting a settled amount to them, oldest first. Same fields and the same exactly-once guard
// (`paystackRefs`) as the rest of PAY, so PMS and the reminder jobs keep working unchanged: a part-payment leaves status "partial".
import * as admin from "firebase-admin";

const db = () => admin.firestore();
const r2 = (n: number) => Math.round(n * 100) / 100;

export interface OpenInvoice { id: string; billingMonth: string; dueDate: string; outstandingMinor: number }

/** The tenant's unpaid invoices, oldest due date first. */
export async function openInvoices(agentId: string, tenantId: string): Promise<OpenInvoice[]> {
  const base = db().collection("users").doc(agentId).collection("invoices");
  let snap = await base.where("tenantId", "==", Number(tenantId)).get();
  if (snap.empty) snap = await base.where("tenantId", "==", tenantId).get();
  return snap.docs
    .map((d) => { const x = d.data(); return { id: d.id, billingMonth: String(x.billingMonth ?? ""), dueDate: String(x.dueDate ?? ""), isPaid: x.isPaid === true, total: Number(x.totalAmount) || 0, paid: Number(x.amountPaid) || 0 }; })
    .filter((x) => !x.isPaid && x.total - x.paid > 0.004)
    .map((x) => ({ id: x.id, billingMonth: x.billingMonth, dueDate: x.dueDate, outstandingMinor: Math.round((x.total - x.paid) * 100) }))
    .sort((a, b) => (a.dueDate || a.billingMonth).localeCompare(b.dueDate || b.billingMonth) || a.id.localeCompare(b.id));
}

/** Credits `amountMinor` to one invoice exactly once per `reference`. Returns what was applied (never more than the invoice still owed). */
export async function creditInvoice(agentId: string, invoiceId: string, reference: string, amountMinor: number): Promise<{ appliedMinor: number; isPaid: boolean } | null> {
  const ref = db().collection("users").doc(agentId).collection("invoices").doc(invoiceId);
  return db().runTransaction(async (t) => {
    const snap = await t.get(ref);
    if (!snap.exists) return null;
    const inv = snap.data() as Record<string, any>;
    const total = Number(inv.totalAmount) || 0;
    const before = Number(inv.amountPaid) || 0;
    const refs: string[] = Array.isArray(inv.paystackRefs) ? inv.paystackRefs : [];
    if (refs.includes(reference)) return { appliedMinor: 0, isPaid: before >= total - 0.005 };
    const amountPaid = Math.min(r2(before + amountMinor / 100), total);
    const appliedMinor = Math.round((amountPaid - before) * 100);
    const isPaid = amountPaid >= total - 0.005;
    t.update(ref, {
      amountPaid, arrears: Math.max(0, r2(total - amountPaid)), isPaid, status: isPaid ? "paid" : "partial",
      paidDate: isPaid ? new Date().toISOString().split("T")[0] : inv.paidDate ?? null,
      paymentReference: reference, paystackRefs: admin.firestore.FieldValue.arrayUnion(reference), paidNotifiedAmount: amountPaid, hasPaid: isPaid,
      lastModified: new Date().toISOString(),
    });
    return { appliedMinor, isPaid };
  });
}

export interface Allocation { lines: { invoiceId: string; billingMonth: string; minor: number }[]; leftMinor: number }
/** Decides, once, which invoices a settled amount goes to (oldest first). Pure given the open invoices. */
export function allocate(open: OpenInvoice[], amountMinor: number): Allocation {
  let left = amountMinor; const lines: Allocation["lines"] = [];
  for (const inv of open) {
    if (left <= 0) break;
    const give = Math.min(left, inv.outstandingMinor);
    if (give > 0) { lines.push({ invoiceId: inv.id, billingMonth: inv.billingMonth, minor: give }); left -= give; }
  }
  return { lines, leftMinor: left };
}

/** Applies a stored allocation. Safe to run again: each invoice is credited once per `settlementId:invoiceId`. */
export async function applyAllocation(agentId: string, tenantId: string, tenantName: string, settlementId: string, a: Allocation): Promise<void> {
  for (const line of a.lines) {
    const res = await creditInvoice(agentId, line.invoiceId, `${settlementId}:${line.invoiceId}`, line.minor);
    if (!res || res.appliedMinor <= 0) continue;
    // the tenant's payment history (same place the normal rent flow writes it)
    await db().collection("payments").doc(String(tenantId)).collection("billingMonths").doc(line.billingMonth || "unknown").set({
      payments: admin.firestore.FieldValue.arrayUnion({
        userName: tenantName, agentId, amount: res.appliedMinor / 100, invoiceId: line.invoiceId, billingMonth: line.billingMonth, currency: "KES",
        reference: `${settlementId}:${line.invoiceId}`, status: "success", provider: "lipa-mos-mos", initiatedAt: new Date().toISOString(),
      }), lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  }
}
