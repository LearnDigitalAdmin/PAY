// Getting a ReportInput: validate what the PMS app sends, or read the landlord's synced records from Firestore.
import { createHash } from "crypto";
import type * as admin from "firebase-admin";
import { MAX_INPUT_BYTES, MAX_INVOICES, MAX_TENANTS, REPORT_KINDS, type ReportKind } from "./constants";
import { isMonth } from "./calc";
import { CrError } from "./errors";
import { classifyFreshness, isBlocked, staleBlockMessage, toMillis, type DataAsOf } from "./freshness";
import type { ReportInput } from "./types";

type Db = admin.firestore.Firestore;
const num = (v: unknown, max = 1e10): number => { const n = Number(v); return Number.isFinite(n) ? Math.min(Math.max(n, 0), max) : 0; };
const str = (v: unknown, max = 120): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const strOrNull = (v: unknown, max = 120): string | null => str(v, max) || null;
const DATE = /^\d{4}-\d{2}-\d{2}/;
const idFilter = (v: string): string | number => (/^\d+$/.test(v) ? Number(v) : v);

export function parseKind(v: unknown): ReportKind {
  if (!REPORT_KINDS.includes(v as ReportKind)) throw new CrError("CR_BAD_REQUEST", "Choose a report type.");
  return v as ReportKind;
}
export function parseMonth(v: unknown, now: Date): string {
  if (!isMonth(v)) throw new CrError("CR_BAD_REQUEST", "Choose a valid month.");
  const nowMonth = `${new Date(now.getTime() + 3 * 3_600_000).toISOString().slice(0, 7)}`;
  if (v > nowMonth) throw new CrError("CR_BAD_REQUEST", "Choose a month that has started.");
  if (v < "2016-01") throw new CrError("CR_BAD_REQUEST", "Choose a valid month.");
  return v;
}

/** The PMS app sends the records it holds on the device. Nothing in here sets a price. Everything is clamped and re-typed. */
export function sanitizeInput(raw: unknown, kind: ReportKind, month: string): ReportInput {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const tenantsRaw = Array.isArray(r.tenants) ? r.tenants : [];
  const invoicesRaw = Array.isArray(r.invoices) ? r.invoices : [];
  if (tenantsRaw.length > MAX_TENANTS || invoicesRaw.length > MAX_INVOICES) throw new CrError("CR_TOO_LARGE", "This property has too many records for one report.");
  const p = (r.property ?? {}) as Record<string, any>;
  const input: ReportInput = {
    schema: 1, kind, month,
    landlord: { name: str(r.landlord?.name), kraPin: strOrNull(r.landlord?.kraPin, 20), phone: null },
    property: {
      id: str(p.id, 60), name: str(p.name) || "Property", address: strOrNull(p.address, 200),
      commissionRatePct: Math.min(num(p.commissionRatePct, 100), 100), managed: p.managed === true && num(p.commissionRatePct) > 0, residential: p.residential !== false,
    },
    tenants: tenantsRaw.map((t: any) => ({ id: str(t?.id, 40), unit: strOrNull(t?.unit, 30), name: str(t?.name) || "Tenant", rent: num(t?.rent), active: t?.active !== false })).filter((t) => t.id),
    invoices: invoicesRaw.map((i: any) => ({
      id: str(i?.id, 40), tenantId: str(i?.tenantId, 40), month: isMonth(i?.month) ? i.month : "", rent: num(i?.rent), total: num(i?.total),
      payments: (Array.isArray(i?.payments) ? i.payments : []).slice(0, 60).filter((x: any) => DATE.test(String(x?.date))).map((x: any) => ({ date: String(x.date).slice(0, 10), amount: num(x.amount) })),
    })).filter((i) => i.id && i.tenantId && i.month),
    statementItems: (Array.isArray(r.statementItems) ? r.statementItems : []).slice(0, 400).filter((s: any) => isMonth(s?.month))
      .map((s: any) => ({ month: s.month, description: str(s.description, 120), amount: num(s.amount) })),
  };
  if (!input.property.id) throw new CrError("CR_BAD_REQUEST", "Choose a property.");
  const pf = r.portfolio;
  if (pf && typeof pf === "object") input.portfolio = { propertyCount: Math.max(1, Math.round(num(pf.propertyCount, 10_000))), annualRentRoll: num(pf.annualRentRoll), ytdReceived: num(pf.ytdReceived) };
  if (input.tenants.length === 0 && input.invoices.length === 0) throw new CrError("CR_NO_DATA", "There are no tenants or invoices for this property yet.");
  if (Buffer.byteLength(JSON.stringify(input)) > MAX_INPUT_BYTES) throw new CrError("CR_TOO_LARGE", "This property has too many records for one report.");
  return input;
}

/** The fingerprint covers the records only: when they were synced is stated beside it, not inside it. */
export const hashInput = (input: ReportInput): string => {
  const { dataAsOf: _dataAsOf, ...records } = input;
  void _dataAsOf;
  return createHash("sha256").update(JSON.stringify(records)).digest("hex");
};

export interface Owned { userId: string; propertyId: string }

/**
 * When did this landlord's app last sync to the cloud (epoch ms), or null if there is no sign it ever did.
 * The app stamps `lastSyncTime` on the user document on every full upload (every 12 hours while it is open) and on every
 * record it pushes live, so the newest of those is the best evidence of how current the cloud copy is.
 */
export async function loadSyncedAt(db: Db, userId: string): Promise<number | null> {
  const user = db.collection("users").doc(userId);
  const newest = async (collection: "invoices" | "tenants"): Promise<number | null> => {
    try {
      const snap = await user.collection(collection).orderBy("lastSyncTime", "desc").limit(1).get();
      return snap.empty ? null : toMillis(snap.docs[0].data().lastSyncTime);
    } catch (e) {
      console.warn(`Could not read the newest ${collection} sync time:`, e);   // the user document's own stamp still counts
      return null;
    }
  };
  const [own, inv, ten] = await Promise.all([user.get().then((s) => toMillis(s.data()?.lastSyncTime)), newest("invoices"), newest("tenants")]);
  const known = [own, inv, ten].filter((t): t is number => t !== null);
  return known.length ? Math.max(...known) : null;
}

/** Everything for one property from the landlord's synced records (cloud sync is a paid-plan feature, so this is a Business+ / Watch / Desk path). */
/** Refuses a report (and so its payment) on records over 7 days old or never synced. */
export function assertRecordsCurrent(d: DataAsOf | undefined): void {
  if (d && isBlocked(d)) throw new CrError("CR_STALE_DATA", staleBlockMessage(d));
}

/** The cheap form of the same check, for the steps that must not read the whole property (order, checkout). */
export async function assertSyncedRecently(db: Db, userId: string, nowMs: number): Promise<void> {
  assertRecordsCurrent(classifyFreshness(await loadSyncedAt(db, userId), nowMs));
}

export async function loadInputFromFirestore(db: Db, o: Owned, kind: ReportKind, month: string, nowMs: number = Date.now()): Promise<ReportInput> {
  const user = db.collection("users").doc(o.userId);
  const pid = idFilter(o.propertyId);
  const year = month.slice(0, 4);
  const [uSnap, pSnap, syncedAt] = await Promise.all([user.get(), user.collection("properties").doc(o.propertyId).get(), loadSyncedAt(db, o.userId)]);
  const u = uSnap.data(), p = pSnap.data();
  if (!u || !p) throw new CrError("CR_NOT_FOUND", "Property not found.");

  const [tSnap, iSnap, trSnap, allTenants, yearInv] = await Promise.all([
    user.collection("tenants").where("propertyId", "==", pid).get(),
    user.collection("invoices").where("propertyId", "==", pid).get(),
    user.collection("transcripts").where("propertyId", "==", pid).get(),
    user.collection("tenants").get(),
    user.collection("invoices").where("billingMonth", ">=", `${year}-01`).where("billingMonth", "<=", month).get(),
  ]);
  if (tSnap.size > MAX_TENANTS) throw new CrError("CR_TOO_LARGE", "This property has too many tenants for one report.");

  const tenants = tSnap.docs.filter((d) => d.data().isRestricted !== true).map((d) => {
    const t = d.data();
    return { id: String(t.localId ?? t.id ?? d.id), unit: strOrNull(t.unitNumber, 30), name: str(t.name) || "Tenant", rent: num(t.rentAmount), active: t.isActive !== false };
  });
  const allowed = new Set(tenants.map((t) => t.id));

  // invoices that can carry a payment dated this year: billed from July of last year to December of this year
  const from = `${Number(year) - 1}-07`, to = `${year}-12`;
  const docs = iSnap.docs.filter((d) => { const m = String(d.data().billingMonth); return m >= from && m <= to && allowed.has(String(d.data().tenantId)); });
  if (docs.length > MAX_INVOICES) throw new CrError("CR_TOO_LARGE", "This property has too many invoices for one report.");
  const invoices: ReportInput["invoices"] = [];
  for (let k = 0; k < docs.length; k += 10) {
    await Promise.all(docs.slice(k, k + 10).map(async (d) => {
      const i = d.data();
      const paid = num(i.amountPaid) > 0;
      const pays = paid ? (await d.ref.collection("payments").get()).docs.map((x) => x.data()) : [];
      invoices.push({
        id: String(i.localId ?? i.id ?? d.id), tenantId: String(i.tenantId), month: String(i.billingMonth), rent: num(i.rentAmount), total: num(i.totalAmount),
        payments: pays.filter((x) => DATE.test(String(x.paymentDate))).map((x) => ({ date: String(x.paymentDate).slice(0, 10), amount: num(x.amount) })),
      });
    }));
  }

  const statementItems: ReportInput["statementItems"] = [];
  trSnap.forEach((d) => {
    const t = d.data(), m = String(t.billingMonth);
    if (!isMonth(m) || !m.startsWith(year) || !Array.isArray(t.items)) return;
    for (const it of t.items) if (it && it.isDeductible === true) statementItems.push({ month: m, description: str(it.description, 120), amount: num(it.amount) });
  });

  const roll = allTenants.docs.filter((d) => d.data().isActive !== false && d.data().isRestricted !== true).reduce((s, d) => s + num(d.data().rentAmount), 0) * 12;
  const ytd = yearInv.docs.reduce((s, d) => s + Math.min(num(d.data().amountPaid), num(d.data().rentAmount)), 0);   // by billing month, rent first
  const propsSnap = await user.collection("properties").get();

  const input: ReportInput = {
    schema: 1, kind, month,
    landlord: { name: str(u.company) || str(u.name), kraPin: strOrNull(u.kraPin, 20), phone: null },
    property: {
      id: o.propertyId, name: str(p.name) || "Property", address: strOrNull(p.address, 200),
      commissionRatePct: Math.min(num(p.agentCommissionRate, 100), 100), managed: num(p.agentCommissionRate) > 0, residential: p.isResidential !== false && p.type !== "commercial",
    },
    tenants, invoices, statementItems,
    portfolio: { propertyCount: Math.max(1, propsSnap.size), annualRentRoll: roll, ytdReceived: ytd },
    dataAsOf: classifyFreshness(syncedAt, nowMs),
  };
  if (tenants.length === 0 && invoices.length === 0) throw new CrError("CR_NO_DATA", "There are no synced tenant or invoice records for this property. Cloud sync must be on for a report to be made from the account.");
  return input;
}
