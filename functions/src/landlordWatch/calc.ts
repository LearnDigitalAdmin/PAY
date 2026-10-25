// The Landlord Watch calculation engine. PURE: no Firestore, no clock except `now`, no secrets. It produces the
// UNMASKED ("open") snapshot; mask.ts lowers it to what a given actor may see. Definitions: contract section 5.
//
// Commission is a percentage of BASE RENT only (never water, power or other charges). A part-paid invoice counts its
// full base rent, exactly like the PMS landlord transcript does (rentAmount of every invoice that is paid or part-paid).
import { REMITTANCE_DAY, TREND_MONTHS } from "./constants";
import { count, dayLabel, money, monthLabel, pct, round2, shiftMonth, STR, toDay } from "./format";
import type {
  Lang, RawInvoice, RawPayment, RawProperty, RawTenant, RawTranscript, Snapshot, Statement, StatementItem, TenantRow, TenantStatus,
} from "./types";

export interface CalcInput {
  ownerId: string;
  month: string;
  lang: Lang;
  property: RawProperty;
  /** Tenants that are not restricted. */
  tenants: RawTenant[];
  /** Invoices of those tenants, every month (needed for the trend and the month list). */
  invoices: RawInvoice[];
  /** Payments of the invoices of `month`. */
  payments: RawPayment[];
  /** The agent's landlord transcripts, by billing month. */
  transcripts: Record<string, RawTranscript>;
  /** Opaque, stable per-tenant reference (never the real id). */
  tenantRef: (tenantId: string) => string;
  now?: Date;
}

const EPS = 0.005;
const paidInFull = (i: RawInvoice) => i.totalAmount > 0 && i.amountPaid >= i.totalAmount - EPS;
const paidAny = (i: RawInvoice) => i.amountPaid > EPS;
const dueDateOf = (month: string) => `${month}-${String(REMITTANCE_DAY).padStart(2, "0")}`;

interface Totals {
  billed: number; collected: number; pending: number;
  baseRentBilled: number; baseRentCollected: number;
  commissionOnCollected: number; commissionOnExpected: number;
}

export function totalsFor(invoices: RawInvoice[], ratePct: number): Totals {
  let billed = 0, collected = 0, pending = 0, baseRentBilled = 0, baseRentCollected = 0;
  for (const i of invoices) {
    billed += i.totalAmount;
    collected += i.amountPaid;
    pending += Math.max(0, i.totalAmount - i.amountPaid);
    baseRentBilled += i.rentAmount;
    if (paidAny(i)) baseRentCollected += i.rentAmount;
  }
  const rate = Math.max(0, ratePct) / 100;
  return {
    billed: round2(billed), collected: round2(collected), pending: round2(pending),
    baseRentBilled: round2(baseRentBilled), baseRentCollected: round2(baseRentCollected),
    commissionOnCollected: round2(baseRentCollected * rate), commissionOnExpected: round2(baseRentBilled * rate),
  };
}

const STATEMENT_STATUS = new Set(["draft", "finalized", "sent", "acknowledged"]);

/** The agent's statement for a month: their transcript when they issued one, otherwise a clearly-labelled estimate. */
export function statementFor(t: Totals, transcript: RawTranscript | undefined, ratePct: number, lang: Lang): Statement {
  if (transcript && transcript.items.length) {
    const items: StatementItem[] = [...transcript.items]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((i) => ({ label: i.description, kind: i.isDeductible ? "deduction" : "income", amount: money(i.amount) }));
    const income = round2(transcript.items.filter((i) => !i.isDeductible).reduce((s, i) => s + i.amount, 0));
    const deductions = round2(transcript.items.filter((i) => i.isDeductible).reduce((s, i) => s + i.amount, 0));
    return {
      source: "agent",
      status: transcript.status && STATEMENT_STATUS.has(transcript.status) ? (transcript.status as Statement["status"]) : null,
      notes: transcript.notes,
      items, income: money(income), deductions: money(deductions), netPayable: money(income - deductions),
    };
  }
  const s = STR[lang];
  return {
    source: "estimate", status: null, notes: null,
    items: [
      { label: s.collectedLine, kind: "income", amount: money(t.collected) },
      { label: s.commissionLine(ratePct), kind: "deduction", amount: money(t.commissionOnCollected) },
    ],
    income: money(t.collected), deductions: money(t.commissionOnCollected), netPayable: money(t.collected - t.commissionOnCollected),
  };
}

const ORDER: Record<TenantStatus, number> = { unpaid: 0, partial: 1, paid: 2, no_invoice: 3, masked: 4 };

export function buildOpenSnapshot(input: CalcInput): Snapshot {
  const { ownerId, month, lang, property, tenants, transcripts } = input;
  const ratePct = property.commissionRatePct;
  const due = dueDateOf(month);

  const invoicesM = input.invoices.filter((i) => i.billingMonth === month);
  const totals = totalsFor(invoicesM, ratePct);
  const statement = statementFor(totals, transcripts[month], ratePct, lang);

  // ---- tenants ----
  const byTenant = new Map<string, RawInvoice[]>();
  for (const i of invoicesM) byTenant.set(i.tenantId, [...(byTenant.get(i.tenantId) ?? []), i]);
  const paymentsByInvoice = new Map<string, RawPayment[]>();
  for (const p of input.payments) paymentsByInvoice.set(p.invoiceId, [...(paymentsByInvoice.get(p.invoiceId) ?? []), p]);

  const shown = tenants.filter((t) => t.isActive || byTenant.has(t.id));
  const rows: TenantRow[] = shown.map((t) => {
    const invs = byTenant.get(t.id) ?? [];
    const billed = invs.reduce((s, i) => s + i.totalAmount, 0);
    const paid = invs.reduce((s, i) => s + i.amountPaid, 0);
    let status: TenantStatus = "no_invoice";
    if (invs.length) status = billed > 0 && paid >= billed - EPS ? "paid" : paid > EPS ? "partial" : "unpaid";

    const payDays = invs.flatMap((i) => (paymentsByInvoice.get(i.id) ?? []).map((p) => p.date)).filter((d): d is string => !!d).sort();
    const paidOn = status === "unpaid" || status === "no_invoice" ? null : payDays[payDays.length - 1] ?? toDay(invs.find((i) => i.paidDate)?.paidDate) ?? null;
    const dueDate = toDay(invs[0]?.dueDate) ?? null;
    const limit = dueDate ?? due;
    return {
      ref: input.tenantRef(t.id), name: t.name, phone: t.phone ?? "", unit: t.unit, status,
      rent: money(invs.length ? invs.reduce((s, i) => s + i.rentAmount, 0) : t.rentAmount),
      billed: money(billed), paid: money(paid), balance: money(Math.max(0, billed - paid)),
      dueDate, paidOn, paidOnTime: paidOn ? paidOn <= limit : null,
    };
  });
  rows.sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.name.localeCompare(b.name));

  const fullyPaid = invoicesM.filter(paidInFull).length;
  const partial = invoicesM.filter((i) => paidAny(i) && !paidInFull(i)).length;
  const unpaid = invoicesM.filter((i) => !paidAny(i)).length;
  const noInvoice = tenants.filter((t) => t.isActive && !byTenant.has(t.id)).length;

  // ---- occupancy (units, not properties) ----
  const active = tenants.filter((t) => t.isActive).length;
  const maxUnits = Math.max(0, property.maxUnits);
  const occupancy = maxUnits > 0 ? Math.min(100, (active / maxUnits) * 100) : 0;

  // ---- remittance by the 15th ----
  const rate = Math.max(0, ratePct) / 100;
  let byDue = 0, afterDue = 0, commByDue = 0, commAfterDue = 0;
  for (const inv of invoicesM.filter(paidAny)) {
    const pays = paymentsByInvoice.get(inv.id) ?? [];
    const consistent = pays.length > 0 && Math.abs(pays.reduce((s, p) => s + p.amount, 0) - inv.amountPaid) <= 0.01;
    // When payment records are missing or disagree with the invoice, treat the invoice total as one payment on its paid date.
    const entries = consistent ? pays.map((p) => ({ amount: p.amount, date: p.date })) : [{ amount: inv.amountPaid, date: toDay(inv.paidDate) ?? pays[0]?.date ?? null }];
    const dates = entries.map((e) => e.date).filter((d): d is string => !!d).sort();
    const first = dates[0] ?? null;
    // An unknown date is given the benefit of the doubt (counted as on time).
    for (const e of entries) {
      if (e.date === null || e.date <= due) byDue += e.amount; else afterDue += e.amount;
    }
    const commission = inv.rentAmount * rate;
    if (first === null || first <= due) commByDue += commission; else commAfterDue += commission;
  }

  // ---- trend: the last 6 months ending at `month` ----
  const trend = Array.from({ length: TREND_MONTHS }, (_, k) => shiftMonth(month, k - (TREND_MONTHS - 1))).map((m) => {
    const tt = totalsFor(input.invoices.filter((i) => i.billingMonth === m), ratePct);
    const st = statementFor(tt, transcripts[m], ratePct, lang);
    return { month: m, billed: money(tt.billed), collected: money(tt.collected), pending: money(tt.pending), netPayable: st.netPayable };
  });

  const months = Array.from(new Set([...input.invoices.map((i) => i.billingMonth), ...Object.keys(transcripts)])).sort().reverse();

  return {
    schema: 1, ownerId, month,
    generatedAt: (input.now ?? new Date()).toISOString(),
    mask: { level: "open", reason: "locked", unlockedUntil: null, canUnlock: true },
    property: { name: property.name, address: property.address, maxUnits: count(maxUnits), commissionRatePct: pct(ratePct), managedByAgency: property.managedByAgency },
    months,
    summary: {
      tenants: { active: count(active), occupiedUnits: count(active), vacantUnits: count(Math.max(0, maxUnits - active)), occupancyPct: pct(occupancy) },
      invoices: { total: count(invoicesM.length), paid: count(fullyPaid), partial: count(partial), unpaid: count(unpaid), noInvoice: count(noInvoice) },
      billed: money(totals.billed), collected: money(totals.collected), pending: money(totals.pending),
      collectionRatePct: pct(totals.billed > 0 ? (totals.collected / totals.billed) * 100 : 0),
      baseRent: { billed: money(totals.baseRentBilled), collected: money(totals.baseRentCollected) },
      commission: { ratePct: pct(ratePct), onCollected: money(totals.commissionOnCollected), onExpected: money(totals.commissionOnExpected) },
      net: {
        expected: money(totals.billed - totals.commissionOnExpected),
        payable: statement.netPayable,
        stillToCollect: money(Math.max(0, totals.pending - (totals.commissionOnExpected - totals.commissionOnCollected))),
      },
      statement,
      remittance: {
        dueDate: due,
        collectedByDue: money(byDue), collectedAfterDue: money(afterDue),
        netByDue: money(byDue - commByDue), netAfterDue: money(afterDue - commAfterDue),
      },
    },
    tenants: rows,
    trend,
  };
}

/** Human label used by the PDF and SMS: "October 2026" / "Oktoba 2026". */
export { monthLabel, dayLabel };
