// Pure report maths. No I/O. Money is integer minor units (cents).
import { MRI_DUE_DAY, MRI_MAX_ANNUAL_KES, MRI_MIN_ANNUAL_KES, MRI_RATE_PCT, REPORT_VERSION } from "./constants";
import { freshnessDetail } from "./freshness";
import type { BillLine, Check, Computed, MonthRow, ReportInput, TenantRow } from "./types";

export const toMinor = (kes: unknown): number => {
  const n = Number(kes);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
export const isMonth = (v: unknown): v is string => typeof v === "string" && MONTH.test(v);
const monthOf = (date: string): string => String(date).slice(0, 7);
/** x% of an amount in minor units, half-up, with the % given to 2 decimals. */
export const pctOf = (minor: number, pct: number): number => Math.floor((minor * Math.round(pct * 100) + 5000) / 10_000);

export function monthsOfYearUpTo(month: string): string[] {
  const y = month.slice(0, 4), last = Number(month.slice(5, 7));
  return Array.from({ length: last }, (_, i) => `${y}-${String(i + 1).padStart(2, "0")}`);
}
export const dueDateFor = (month: string): string => {
  const y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7));
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, "0")}-${String(MRI_DUE_DAY).padStart(2, "0")}`;
};

interface Split { date: string; rent: number; bills: number }
/**
 * Applies an invoice's payments, oldest first: base rent first, then bills; anything above the invoice total is advance rent.
 * (Rent-first is the cautious order for tax: it never understates rent received.)
 */
export function allocatePayments(rent: number, total: number, payments: { date: string; amount: number }[]): Split[] {
  const rentMinor = Math.max(0, toMinor(rent));
  const billsMinor = Math.max(0, toMinor(total) - rentMinor);
  let rentLeft = rentMinor, billsLeft = billsMinor;
  const sorted = payments.map((p, i) => ({ ...p, i })).filter((p) => toMinor(p.amount) > 0 && /^\d{4}-\d{2}-\d{2}/.test(String(p.date)))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.i - b.i));
  return sorted.map((p) => {
    let amt = toMinor(p.amount);
    const r = Math.min(amt, rentLeft); rentLeft -= r; amt -= r;
    const b = Math.min(amt, billsLeft); billsLeft -= b; amt -= b;
    return { date: String(p.date).slice(0, 10), rent: r + amt, bills: b };   // amt left over = advance rent
  });
}

const ruleOutRent = /^\s*(base\s+|monthly\s+)?rent(\s+(income|collected|received|payment|amount))?\s*$/i;

export function computeReport(input: ReportInput): Computed {
  const month = input.month;
  if (!isMonth(month)) throw new RangeError("month must be YYYY-MM");
  const year = month.slice(0, 4);
  const monthsYtd = monthsOfYearUpTo(month);

  // ---- 1. allocate every payment to rent / bills, and sum rent RECEIVED per calendar month (cash basis, as MRI requires)
  const rentByMonth = new Map<string, number>();
  const tenantMonth = new Map<string, { rent: number; bills: number }>();      // tenantId -> received in the return month
  const paidToInvoice = new Map<string, number>();                              // invoiceId -> rent paid (any date)
  for (const inv of input.invoices) {
    const split = allocatePayments(inv.rent, inv.total, inv.payments ?? []);
    let rentPaid = 0;
    for (const s of split) {
      rentPaid += s.rent;
      const m = monthOf(s.date);
      if (m.startsWith(year) && m <= month) rentByMonth.set(m, (rentByMonth.get(m) ?? 0) + s.rent);
      if (m === month) {
        const t = tenantMonth.get(inv.tenantId) ?? { rent: 0, bills: 0 };
        t.rent += s.rent; t.bills += s.bills; tenantMonth.set(inv.tenantId, t);
      }
    }
    paidToInvoice.set(inv.id, rentPaid);
  }

  // ---- 2. per-tenant rows for the return month
  const invoicesOfMonth = input.invoices.filter((i) => i.month === month);
  const rows: TenantRow[] = [];
  const seen = new Set<string>();
  const byTenant = new Map(input.tenants.map((t) => [t.id, t]));
  const ids = new Set<string>([...input.tenants.filter((t) => t.active).map((t) => t.id), ...invoicesOfMonth.map((i) => i.tenantId), ...tenantMonth.keys()]);
  for (const id of ids) {
    const t = byTenant.get(id);
    const inv = invoicesOfMonth.filter((i) => i.tenantId === id);
    const invoicedRent = inv.reduce((s, i) => s + Math.max(0, toMinor(i.rent)), 0);
    const invoicedBills = inv.reduce((s, i) => s + Math.max(0, toMinor(i.total) - Math.max(0, toMinor(i.rent))), 0);
    const paidRentForMonthInvoices = inv.reduce((s, i) => s + (paidToInvoice.get(i.id) ?? 0), 0);
    const got = tenantMonth.get(id) ?? { rent: 0, bills: 0 };
    const outstanding = Math.max(0, invoicedRent - paidRentForMonthInvoices);
    const note = inv.length === 0 ? (t?.active ? "No invoice for the month" : "") : outstanding > 0 ? "Rent outstanding" : "";
    rows.push({
      unit: t?.unit ?? "-", name: t?.name ?? "Former tenant", contractRent: t?.active ? Math.max(0, toMinor(t.rent)) : 0,
      invoicedRent, receivedRent: got.rent, outstandingRent: outstanding, invoicedBills, receivedBills: got.bills, note,
    });
    seen.add(id);
  }
  rows.sort((a, b) => a.unit.localeCompare(b.unit, undefined, { numeric: true }) || a.name.localeCompare(b.name));
  const sum = (k: keyof TenantRow) => rows.reduce((s, r) => s + (r[k] as number), 0);
  const totals = {
    contractRent: sum("contractRent"), invoicedRent: sum("invoicedRent"), receivedRent: sum("receivedRent"),
    outstandingRent: sum("outstandingRent"), invoicedBills: sum("invoicedBills"), receivedBills: sum("receivedBills"),
  };

  // ---- 3. gross rent, commission, final rental income
  const grossRent = rentByMonth.get(month) ?? 0;
  const ratePct = input.property.managed ? Math.max(0, Math.min(100, Number(input.property.commissionRatePct) || 0)) : 0;
  const commissionOf = (gross: number) => pctOf(gross, ratePct);
  const commission = commissionOf(grossRent);
  const finalIncome = grossRent - commission;

  // ---- 4. bills register: commission (a bill) + the agent's other deductions. Base rent is never a bill.
  const lines: BillLine[] = [];
  const excluded: Computed["bills"]["excluded"] = [];
  if (commission > 0) lines.push({ description: `Agent commission (${ratePct}% of rent received)`, amount: commission, source: "agent_commission" });
  for (const it of input.statementItems.filter((x) => x.month === month)) {
    const amount = toMinor(it.amount);
    const description = String(it.description ?? "").trim() || "Bill";
    if (amount <= 0) continue;
    if (ruleOutRent.test(description)) { excluded.push({ description, amount, reason: "Base rent is income, not a bill" }); continue; }
    if (/commission/i.test(description) && commission > 0) { excluded.push({ description, amount, reason: "Agent commission is already listed above" }); continue; }
    lines.push({ description, amount, source: "agent_statement" });
  }
  const billsTotal = lines.reduce((s, l) => s + l.amount, 0);

  // ---- 5. the KES 288,000 / 15,000,000 annual test (on the landlord's total rent when the portfolio is supplied)
  const activeRoll = input.tenants.filter((t) => t.active).reduce((s, t) => s + Math.max(0, toMinor(t.rent)), 0) * 12;
  const propertyYtd = monthsYtd.reduce((s, m) => s + (rentByMonth.get(m) ?? 0), 0);
  const pf = input.portfolio;
  const portfolioRoll = pf ? Math.max(toMinor(pf.annualRentRoll), activeRoll) : null;
  const portfolioYtd = pf ? Math.max(toMinor(pf.ytdReceived), propertyYtd) : null;
  const rollBasis = portfolioRoll ?? activeRoll, ytdBasis = portfolioYtd ?? propertyYtd;
  const basis = Math.max(rollBasis, ytdBasis);
  const min = MRI_MIN_ANNUAL_KES * 100, max = MRI_MAX_ANNUAL_KES * 100;
  const status = basis < min ? "below" : basis > max ? "above" : "within";
  const residential = input.property.residential !== false;
  const regime = !residential ? "below_threshold" : status === "within" ? "mri" : status === "below" ? "below_threshold" : "above_threshold";
  const applies = residential && status === "within";
  const mriTax = applies ? pctOf(grossRent, MRI_RATE_PCT) : 0;

  // ---- 6. month-by-month table (annual report and the year-to-date context)
  const monthly: MonthRow[] = monthsYtd.map((m) => {
    const g = rentByMonth.get(m) ?? 0, c = commissionOf(g);
    return { month: m, grossRent: g, commission: c, finalIncome: g - c, mriTax: applies ? pctOf(g, MRI_RATE_PCT) : 0 };
  });
  const annual = input.kind === "annual_summary"
    ? { gross: monthly.reduce((s, r) => s + r.grossRent, 0), commission: monthly.reduce((s, r) => s + r.commission, 0), finalIncome: monthly.reduce((s, r) => s + r.finalIncome, 0), mriTax: monthly.reduce((s, r) => s + r.mriTax, 0) }
    : null;

  // ---- 7. compliance checks
  const activeTenants = input.tenants.filter((t) => t.active).length;
  const withoutInvoice = rows.filter((r) => r.note === "No invoice for the month").length;
  const checks: Check[] = [];
  checks.push({ id: "residential", label: "Residential property", result: residential ? "pass" : "fail",
    detail: residential ? "Recorded as residential. MRI covers residential rent only." : "Recorded as non-residential. MRI does not apply to commercial rent." });
  checks.push({ id: "threshold_min", label: `Annual rent at least KES ${MRI_MIN_ANNUAL_KES.toLocaleString("en-US")}`, result: status === "below" ? "fail" : "pass",
    detail: status === "below" ? "Below the MRI band: MRI is not payable. Declare any rent in the annual income tax return where required." : "At or above the minimum, so the MRI band is reached." });
  checks.push({ id: "threshold_max", label: `Annual rent at most KES ${MRI_MAX_ANNUAL_KES.toLocaleString("en-US")}`, result: status === "above" ? "fail" : "pass",
    detail: status === "above" ? "Above the MRI band: normal income tax applies and expenses are deductible." : "Within the maximum." });
  checks.push({ id: "base_rent_not_bill", label: "Base rent excluded from bills", result: "pass",
    detail: excluded.some((e) => e.reason.startsWith("Base rent")) ? "Statement lines that were base rent were removed from the bills register." : "No base rent appears in the bills register." });
  checks.push({ id: "gross_basis", label: "MRI base is gross rent received", result: "info",
    detail: "MRI is charged on gross rent received with no deduction. The agent's commission and other bills reduce the landlord's final income here, but they do not reduce the MRI base." });
  checks.push({ id: "invoices", label: "Every active tenant has an invoice", result: withoutInvoice === 0 ? "pass" : "warn",
    detail: withoutInvoice === 0 ? "All active tenants were invoiced for the month." : `${withoutInvoice} active tenant(s) have no invoice for ${month}.` });
  checks.push({ id: "outstanding", label: "Rent outstanding", result: totals.outstandingRent === 0 ? "pass" : "info",
    detail: totals.outstandingRent === 0 ? "No rent is outstanding for the month's invoices." : "Rent still unpaid is not part of this month's MRI: tax follows rent received, in the month it is received." });
  checks.push({ id: "portfolio", label: "Threshold tested on all properties", result: pf ? "pass" : "warn",
    detail: pf ? `Tested on the landlord's ${pf.propertyCount} propert${pf.propertyCount === 1 ? "y" : "ies"}.` : "Only this property's figures were available, so the band was tested on this property alone." });

  if (input.dataAsOf) {
    checks.push({ id: "data_fresh", label: "Records recently synced", result: input.dataAsOf.level === "fresh" ? "pass" : "warn", detail: freshnessDetail(input.dataAsOf) });
  }

  return {
    schema: 1, version: REPORT_VERSION, kind: input.kind, month, year, property: input.property, landlord: input.landlord,
    rows, totals, grossRent, commission: { ratePct, amount: commission }, finalIncome,
    bills: { lines, total: billsTotal, excluded },
    mri: { ratePct: MRI_RATE_PCT, applies, base: grossRent, tax: mriTax, dueDate: dueDateFor(month), regime },
    threshold: {
      minAnnual: min, maxAnnual: max, basis,
      basisLabel: basis === ytdBasis && ytdBasis >= rollBasis ? "Rent received so far this year" : "Contracted rent for the year (active tenants x 12)",
      propertyRoll: activeRoll, propertyYtd, portfolioRoll, portfolioYtd, scope: pf ? "landlord" : "property", status, monthlyEquivalent: Math.round(min / 12),
    },
    monthly, annual, checks, occupancy: { activeTenants, invoiced: rows.filter((r) => r.invoicedRent > 0).length, withoutInvoice },
    ...(input.dataAsOf ? { dataAsOf: input.dataAsOf } : {}),
  };
}
