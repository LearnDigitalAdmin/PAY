// Pure MyChama calculations for the PAY portal. NO Firebase / React imports and NO access to rental
// collections: callers pass in rent totals they ALREADY have on screen, plus the chama snapshot.
// KES, dates "YYYY-MM-DD" (Africa/Nairobi). A chama section that is unavailable (null) is never treated
// as zero — it sets `incomplete` and is listed so the UI can say "figures incomplete".
import type { ChamaSnapshotChama } from './contract';

const EAT_OFFSET_MS = 3 * 3600 * 1000;
const round2 = (n: number): number => Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
const pad = (n: number): string => String(n).padStart(2, '0');

export interface PeriodRange { from: string; to: string }          // inclusive
export interface RentPaymentLike { amount: number; status: string; date: Date | null }

export const isoDateEat = (d: Date): string => new Date(d.getTime() + EAT_OFFSET_MS).toISOString().slice(0, 10);

export function monthRange(todayIso: string): PeriodRange {
  const [y, m] = todayIso.split('-').map(Number);
  return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}` };
}
export function previousMonthRange(todayIso: string): PeriodRange {
  const [y, m] = todayIso.split('-').map(Number);
  return monthRange(m === 1 ? `${y - 1}-12-15` : `${y}-${pad(m - 1)}-15`);
}
export function lastDaysRange(todayIso: string, days: number): PeriodRange {
  const to = new Date(`${todayIso}T00:00:00Z`);
  const from = new Date(to.getTime() - (days - 1) * 86400000);
  return { from: from.toISOString().slice(0, 10), to: todayIso };
}

/** Sum of SUCCESSFUL rent payments whose date falls inside the period. */
export function sumRentCollected(payments: RentPaymentLike[], period: PeriodRange): number {
  return round2(payments.reduce((sum, p) => {
    if (p.status !== 'success' || !p.date) return sum;
    const day = isoDateEat(p.date);
    return day >= period.from && day <= period.to ? sum + p.amount : sum;
  }, 0));
}

/** Tenant side: split what is still owed on unpaid invoices into rent vs bills (water, power, other). */
export function splitInvoiceOutstanding(invoices: Array<{ rentAmount: number; totalAmount: number; amountPaid: number; isPaid: boolean }>): { rentDue: number; billsDue: number } {
  let rentDue = 0;
  let billsDue = 0;
  for (const inv of invoices) {
    if (inv.isPaid) continue;
    const outstanding = Math.max(0, round2(inv.totalAmount - inv.amountPaid));
    const rentPart = Math.min(Math.max(0, inv.rentAmount), outstanding);
    rentDue += rentPart;
    billsDue += outstanding - rentPart;
  }
  return { rentDue: round2(rentDue), billsDue: round2(billsDue) };
}

// ───────────────────────────── shared pieces ─────────────────────────────
export type ObligationKind = 'contribution' | 'loan' | 'mgr' | 'mgr_arrears';
export interface ObligationLine {
  kind: ObligationKind; chamaId: string; chamaName: string; label: string; amount: number; dueDate: string | null;
  bucket: 'in_period' | 'overdue_before';
}
export interface WinLine {
  chamaId: string; chamaName: string; potName: string; round: number; kind: 'won' | 'scheduled';
  amount: number | null; date: string | null; queuePosition: number | null;
}

const endOfMonth = (periodKey: string): string | null => {
  const m = /^(\d{4})-(\d{2})$/.exec(periodKey);
  return m ? `${m[1]}-${m[2]}-${pad(new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate())}` : null;
};

function isIncomplete(c: ChamaSnapshotChama): boolean {
  return c.dataStatus !== 'ok' || c.contributions === null || c.loans === null || c.mgr === null;
}

function collectWins(chamas: ChamaSnapshotChama[]): WinLine[] {
  const out: WinLine[] = [];
  for (const c of chamas) for (const pot of c.mgr?.pots ?? []) for (const w of pot.wins) {
    out.push({ chamaId: c.chamaId, chamaName: c.chamaName, potName: w.potName || pot.name, round: w.round, kind: w.kind, amount: w.amount, date: w.expectedDate, queuePosition: w.queuePosition });
  }
  return out;
}

// ───────────────────────────── landlord ─────────────────────────────
export interface LandlordSummary {
  period: PeriodRange;
  rentCollected: number;
  lines: ObligationLine[];
  totals: { contributions: number; loans: number; mgr: number; deductions: number };
  winsReceived: number;
  scheduledWins: WinLine[];
  /** rentCollected − deductions + winsReceived (may be negative: the landlord owes the chama more than they collected). */
  net: number;
  incomplete: boolean;
  unavailableChamas: string[];
}

/**
 * Deductions = what the landlord owes their chamas that falls due inside the period, plus anything
 * already overdue from before it. Items due AFTER the period are ignored. Loans contribute the NEXT
 * instalment only (the snapshot carries no full schedule). MGR "due now" has no date, so it counts as
 * due in the period; open MGR arrears count as overdue.
 */
export function landlordPeriodSummary(input: { rentCollected: number; period: PeriodRange }, chamas: ChamaSnapshotChama[]): LandlordSummary {
  const { period } = input;
  const lines: ObligationLine[] = [];
  let incomplete = false;

  const place = (dueDate: string | null): 'in_period' | 'overdue_before' | null => {
    if (!dueDate) { incomplete = true; return 'in_period'; }   // undated: counted, but flagged
    if (dueDate < period.from) return 'overdue_before';
    return dueDate <= period.to ? 'in_period' : null;
  };

  for (const c of chamas) {
    if (isIncomplete(c)) incomplete = true;
    for (const item of c.contributions?.items ?? []) {
      const due = item.dueDate ?? endOfMonth(item.periodKey);
      const bucket = place(due);
      if (bucket && item.outstanding > 0) lines.push({ kind: 'contribution', chamaId: c.chamaId, chamaName: c.chamaName, label: `Contribution ${item.periodKey}`, amount: item.outstanding, dueDate: due, bucket });
    }
    for (const loan of c.loans?.items ?? []) {
      const next = loan.nextInstallment;
      if (!next) continue;
      const bucket = place(next.dueDate);
      if (bucket && next.due > 0) lines.push({ kind: 'loan', chamaId: c.chamaId, chamaName: c.chamaName, label: `Loan instalment ${next.installmentNo}`, amount: next.due, dueDate: next.dueDate, bucket });
    }
    for (const pot of c.mgr?.pots ?? []) {
      if (pot.dueNow > 0) lines.push({ kind: 'mgr', chamaId: c.chamaId, chamaName: c.chamaName, label: `MGR ${pot.name}`, amount: pot.dueNow, dueDate: pot.nextDueDate, bucket: 'in_period' });
      if (pot.arrearsOpen > 0) lines.push({ kind: 'mgr_arrears', chamaId: c.chamaId, chamaName: c.chamaName, label: `MGR arrears ${pot.name}`, amount: pot.arrearsOpen, dueDate: null, bucket: 'overdue_before' });
    }
  }

  const sum = (kinds: ObligationKind[]) => round2(lines.filter((l) => kinds.includes(l.kind)).reduce((s, l) => s + l.amount, 0));
  const totals = { contributions: sum(['contribution']), loans: sum(['loan']), mgr: sum(['mgr', 'mgr_arrears']), deductions: 0 };
  totals.deductions = round2(totals.contributions + totals.loans + totals.mgr);

  const wins = collectWins(chamas);
  const winsReceived = round2(wins.filter((w) => w.kind === 'won' && w.amount !== null && w.date !== null && w.date >= period.from && w.date <= period.to).reduce((s, w) => s + (w.amount ?? 0), 0));
  const scheduledWins = wins.filter((w) => w.kind === 'scheduled');

  return {
    period, rentCollected: round2(input.rentCollected), lines, totals, winsReceived, scheduledWins,
    net: round2(input.rentCollected - totals.deductions + winsReceived), incomplete,
    unavailableChamas: chamas.filter(isIncomplete).map((c) => c.chamaName),
  };
}

// ───────────────────────────── tenant ─────────────────────────────
export interface TenantChamaLine { chamaId: string; chamaName: string; overdue: number; dueThisMonth: number; available: boolean }
export interface TenantSummary {
  rentDue: number; billsDue: number;
  perChama: TenantChamaLine[];
  chamaTotal: number;
  /** rent + bills + chama (overdue + due this month) */
  totalNeed: number;
  /** MGR wins with a known amount AND date this month (usually 0: scheduled wins have no date) */
  expectedWinsThisMonth: number;
  scheduledWins: WinLine[];
  /** totalNeed − expectedWinsThisMonth, never below 0 */
  netNeed: number;
  incomplete: boolean;
}

/** "This month I need KES X for rent, bills and chama." Chama figures come from the server totals. */
export function tenantMonthSummary(input: { rentDue: number; billsDue: number }, chamas: ChamaSnapshotChama[]): TenantSummary {
  const perChama: TenantChamaLine[] = chamas.map((c) => ({
    chamaId: c.chamaId, chamaName: c.chamaName,
    overdue: c.totals?.overdue ?? 0, dueThisMonth: c.totals?.dueThisMonth ?? 0, available: c.totals !== null,
  }));
  const chamaTotal = round2(perChama.reduce((s, c) => s + c.overdue + c.dueThisMonth, 0));
  const expected = round2(chamas.reduce((s, c) => s + (c.totals?.expectedInflowThisMonth ?? 0), 0));
  const totalNeed = round2(input.rentDue + input.billsDue + chamaTotal);
  return {
    rentDue: round2(input.rentDue), billsDue: round2(input.billsDue), perChama, chamaTotal, totalNeed,
    expectedWinsThisMonth: expected, scheduledWins: collectWins(chamas).filter((w) => w.kind === 'scheduled'),
    netNeed: Math.max(0, round2(totalNeed - expected)),
    incomplete: chamas.some(isIncomplete),
  };
}
