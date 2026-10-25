// Read-only access to the landlord's rental data (Firestore, default project). Nothing here writes.
import { createHash } from "crypto";
import type * as admin from "firebase-admin";
import { OWNER_ID_PATTERN } from "./constants";
import type { RawInvoice, RawPayment, RawProperty, RawTenant, RawTranscript } from "./types";

type Db = admin.firestore.Firestore;
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const idFilter = (v: string): string | number => (/^\d+$/.test(v) ? Number(v) : v);

export interface OwnerRef {
  ownerId: string; userId: string; propertyId: string;
  /** E.164 owner phone on the property, or null if the owner never added one. */
  ownerPhone: string | null;
  property: RawProperty;
}

/** ownerId -> property. The index document is written by the PMS owner-id allocator. */
export async function resolveOwner(db: Db, ownerId: string): Promise<OwnerRef | null> {
  if (!OWNER_ID_PATTERN.test(ownerId)) return null;
  const idx = (await db.collection("propertyOwnerIds").doc(ownerId).get()).data();
  if (!idx?.userId || !idx?.propertyId) return null;
  const userId = String(idx.userId), propertyId = String(idx.propertyId);
  const snap = await db.collection("users").doc(userId).collection("properties").doc(propertyId).get();
  const p = snap.data();
  // Defence in depth: the property document must still carry this owner id.
  if (!p || p.ownerId !== ownerId) return null;
  const phone = str(p.ownerPhone);
  return {
    ownerId, userId, propertyId,
    ownerPhone: phone && /^\+254[17]\d{8}$/.test(phone) ? phone : null,
    property: {
      name: str(p.name) ?? "Property", address: str(p.address), maxUnits: Math.max(0, num(p.maxUnits)),
      commissionRatePct: Math.max(0, num(p.agentCommissionRate)), managedByAgency: num(p.agentCommissionRate) > 0,
    },
  };
}

export interface Bundle {
  tenants: RawTenant[]; invoices: RawInvoice[]; payments: RawPayment[]; transcripts: Record<string, RawTranscript>;
}

/** Everything the calculation engine needs for one property. Restricted tenants (and their invoices) are left out. */
export async function loadBundle(db: Db, ref: OwnerRef, month: string): Promise<Bundle> {
  const user = db.collection("users").doc(ref.userId);
  const pid = idFilter(ref.propertyId);
  const [tSnap, iSnap, trSnap] = await Promise.all([
    user.collection("tenants").where("propertyId", "==", pid).get(),
    user.collection("invoices").where("propertyId", "==", pid).get(),
    user.collection("transcripts").where("propertyId", "==", pid).get(),
  ]);

  const tenants: RawTenant[] = [];
  const allowed = new Set<string>();
  tSnap.forEach((d) => {
    const t = d.data();
    if (t.isRestricted === true) return;
    const id = String(t.localId ?? t.id ?? d.id);
    allowed.add(id);
    tenants.push({ id, name: str(t.name) ?? "Tenant", phone: str(t.phone), unit: str(t.unitNumber), rentAmount: num(t.rentAmount), isActive: t.isActive !== false });
  });

  const invoices: RawInvoice[] = [];
  const invoiceDocIds = new Map<string, string>();
  iSnap.forEach((d) => {
    const i = d.data();
    const tenantId = String(i.tenantId);
    if (!allowed.has(tenantId) || !/^\d{4}-\d{2}$/.test(String(i.billingMonth))) return;
    const id = String(i.localId ?? i.id ?? d.id);
    invoiceDocIds.set(id, d.id);
    invoices.push({
      id, tenantId, billingMonth: String(i.billingMonth), rentAmount: num(i.rentAmount), totalAmount: num(i.totalAmount),
      amountPaid: num(i.amountPaid), dueDate: str(i.dueDate), paidDate: str(i.paidDate),
    });
  });

  // Payment dates are only needed for the requested month (remittance by the 15th).
  const payments: RawPayment[] = [];
  const paid = invoices.filter((i) => i.billingMonth === month && i.amountPaid > 0);
  for (let k = 0; k < paid.length; k += 10) {
    await Promise.all(paid.slice(k, k + 10).map(async (inv) => {
      const snap = await user.collection("invoices").doc(invoiceDocIds.get(inv.id)!).collection("payments").get();
      snap.forEach((d) => {
        const p = d.data();
        payments.push({ invoiceId: inv.id, amount: num(p.amount), date: typeof p.paymentDate === "string" ? p.paymentDate.slice(0, 10) : null });
      });
    }));
  }

  const transcripts: Record<string, RawTranscript> = {};
  trSnap.forEach((d) => {
    const t = d.data();
    const m = String(t.billingMonth);
    if (!/^\d{4}-\d{2}$/.test(m) || !Array.isArray(t.items)) return;
    transcripts[m] = {
      billingMonth: m, status: str(t.status), notes: str(t.notes),
      items: t.items.map((it: Record<string, unknown>, n: number) => ({
        description: String(it.description ?? ""), amount: num(it.amount), isDeductible: it.isDeductible === true, sortOrder: num(it.sortOrder) || n,
      })),
    };
  });

  return { tenants, invoices, payments, transcripts };
}

/** Cheap change detector for cached snapshots: a short hash of the agent's transcript for the month (1 read). */
export async function transcriptStamp(db: Db, ref: OwnerRef, month: string): Promise<string> {
  const d = await db.collection("users").doc(ref.userId).collection("transcripts").doc(`${ref.propertyId}_${month}`).get();
  const key = d.data()?.contentKey;
  return typeof key === "string" && key ? createHash("sha1").update(key).digest("hex").slice(0, 12) : "";
}
