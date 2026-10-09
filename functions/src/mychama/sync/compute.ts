// Pure chama-side calculations for the snapshot. NO Firebase imports: every function takes plain
// objects, so it is unit-testable (see functions/test/mychama-track-a.check.js).
//
// Money: KES, round2. Dates: "YYYY-MM-DD" in Africa/Nairobi. A section that cannot be built is
// returned as null by the caller — these functions never turn "unknown" into 0.
import {
  MYCHAMA_LIMITS,
  type ChamaTotals,
  type ContributionItem, type ContributionsSnap,
  type LoanItem, type LoansSnap,
  type MgrPotSnap, type MgrSnap, type MgrWin,
} from "../contract";
import { round2, toIsoDate } from "./dates";

const EPS = 0.009;

/** Where "now" is, for overdue / this-month decisions. */
export interface TimeCtx { today: string; month: string }   // "YYYY-MM-DD", "YYYY-MM"


// ─────────────────────────── contributions ───────────────────────────
export interface RawContribution {
  id: string; periodKey?: string; dueDate?: unknown; amount?: number; paidAmount?: number; status?: string;
}

export function buildContributions(raw: RawContribution[], t: TimeCtx): { snap: ContributionsSnap; overdue: number; dueThisMonth: number } {
  const items: ContributionItem[] = [];
  let overdue = 0;
  let dueThisMonth = 0;
  let outstandingAll = 0;

  const sorted = [...raw].sort((a, b) => (a.periodKey || "").localeCompare(b.periodKey || ""));
  for (const c of sorted) {
    const amount = round2(c.amount || 0);
    const paid = round2(c.paidAmount || 0);
    const outstanding = round2(amount - paid);
    if (outstanding <= EPS || c.status === "paid") continue;

    const periodKey = c.periodKey || "";
    const dueDate = toIsoDate(c.dueDate);
    const isOverdue = c.status === "overdue" || (dueDate ? dueDate < t.today : periodKey !== "" && periodKey < t.month);
    const inMonth = dueDate ? dueDate.slice(0, 7) === t.month : periodKey === t.month;

    outstandingAll += outstanding;
    if (isOverdue) overdue += outstanding;
    else if (inMonth) dueThisMonth += outstanding;

    items.push({ contributionId: c.id, periodKey, dueDate, amount, paid, outstanding, status: c.status || "pending" });
  }
  return {
    snap: { items: items.slice(0, MYCHAMA_LIMITS.SNAPSHOT_MAX_ITEMS_PER_LIST), outstanding: round2(outstandingAll) },
    overdue: round2(overdue),
    dueThisMonth: round2(dueThisMonth),
  };
}

// ─────────────────────────────── loans ───────────────────────────────
export interface RawInstallment { n: number; due?: number; paid?: boolean; paidAmount?: number; dueDate?: unknown }
export interface RawLoan { id: string; status?: string; principal?: number; schedule?: RawInstallment[] }

export function buildLoans(raw: RawLoan[], t: TimeCtx): { snap: LoansSnap; overdue: number; dueThisMonth: number } {
  const items: LoanItem[] = [];
  let overdue = 0;
  let dueThisMonth = 0;
  let outstandingAll = 0;

  for (const loan of raw) {
    if (loan.status !== "active" && loan.status !== "overdue") continue;
    const schedule = [...(loan.schedule || [])].sort((a, b) => a.n - b.n);
    let outstanding = 0;
    let remaining = 0;
    let next: LoanItem["nextInstallment"] = null;

    for (const inst of schedule) {
      const left = round2((inst.due || 0) - (inst.paidAmount || 0));
      if (inst.paid || left <= EPS) continue;
      const dueDate = toIsoDate(inst.dueDate);
      outstanding += left;
      remaining += 1;
      if (!next) next = { installmentNo: inst.n, due: left, dueDate };

      const isOverdue = dueDate ? dueDate < t.today : loan.status === "overdue";
      if (isOverdue) overdue += left;
      else if (dueDate && dueDate.slice(0, 7) === t.month) dueThisMonth += left;
    }
    if (remaining === 0) continue;
    outstandingAll += outstanding;
    items.push({
      loanId: loan.id, principal: round2(loan.principal || 0), outstanding: round2(outstanding),
      status: loan.status || "active", installmentsRemaining: remaining, nextInstallment: next,
    });
  }
  return {
    snap: { items: items.slice(0, MYCHAMA_LIMITS.SNAPSHOT_MAX_ITEMS_PER_LIST), outstanding: round2(outstandingAll) },
    overdue: round2(overdue),
    dueThisMonth: round2(dueThisMonth),
  };
}

// ──────────────────────────────── MGR ────────────────────────────────
export interface RawPot {
  id: string; name?: string; amount?: number; frequency?: string; status?: string; period?: number;
  periodsPerRound?: number; recipientsPerRound?: number; memberIds?: string[]; queue?: string[];
  drawDone?: boolean; cycleNumber?: number;
}
export interface RawMgrRecord { period?: number; memberId?: string; status?: string; amount?: number }
export interface RawMgrPayout { memberId?: string; round?: number; cycleNumber?: number; amount?: number; date?: unknown }
export interface RawMgrArrear { id: string; memberId?: string; amount?: number; status?: string }
export interface PotBundle { pot: RawPot; records: RawMgrRecord[]; payouts: RawMgrPayout[]; arrears: RawMgrArrear[] }

/**
 * Mirrors Chama functions/shared/mgr_engine.py: pool = amount x members x periodsPerRound, equal split
 * across recipientsPerRound; a "short round" (0 < queue < recipientsPerRound) is NOT an equal split, so
 * its amount is unknown (null). Future payout DATES are not stored anywhere in mychama1 (periods are
 * closed manually), so scheduled wins carry expectedDate = null — never an invented date.
 */
export function buildMgr(bundles: PotBundle[], memberId: string): { snap: MgrSnap; overdue: number; dueThisMonth: number } {
  const pots: MgrPotSnap[] = [];
  let overdue = 0;
  let dueThisMonth = 0;
  let dueNowAll = 0;
  let arrearsAll = 0;

  for (const { pot, records, payouts, arrears } of bundles) {
    if (pot.status !== "active" || !(pot.memberIds || []).includes(memberId)) continue;
    const amount = round2(pot.amount || 0);
    const period = pot.period || 0;

    const rec = records.find((r) => r.period === period && r.memberId === memberId);
    const currentPeriodPaid = rec?.status === "paid";
    const dueNow = currentPeriodPaid ? 0 : round2(Math.max(0, amount - (rec?.status === "partial" ? rec.amount || 0 : 0)));

    const openArrears = arrears.filter((a) => a.memberId === memberId && a.status === "open");
    const arrearsOpen = round2(openArrears.reduce((s, a) => s + (a.amount || 0), 0));

    const cycle = pot.cycleNumber || 1;
    const cyclePayouts = payouts.filter((p) => (p.cycleNumber || 1) === cycle);
    const wins: MgrWin[] = cyclePayouts
      .filter((p) => p.memberId === memberId)
      .map((p) => ({
        kind: "won" as const, potId: pot.id, potName: pot.name || "", round: p.round || 0,
        amount: typeof p.amount === "number" ? round2(p.amount) : null,
        expectedDate: toIsoDate(p.date), queuePosition: null,
      }));

    const queue = pot.queue || [];
    const recipients = pot.recipientsPerRound || 0;
    const idx = queue.indexOf(memberId);
    if (pot.drawDone && idx >= 0 && recipients > 0) {
      const shortRound = queue.length > 0 && queue.length < recipients;
      const pool = amount * (pot.memberIds || []).length * (pot.periodsPerRound || 1);
      const roundsDone = Math.floor(cyclePayouts.length / recipients);
      wins.push({
        kind: "scheduled", potId: pot.id, potName: pot.name || "",
        round: roundsDone + 1 + Math.floor(idx / recipients),
        amount: shortRound ? null : round2(pool / recipients),
        expectedDate: null, queuePosition: idx + 1,
      });
    }

    dueNowAll += dueNow;
    arrearsAll += arrearsOpen;
    // Period boundaries are not date-stamped, so "due now" is treated as due this month; arrears are overdue.
    dueThisMonth += dueNow;
    overdue += arrearsOpen;

    pots.push({
      potId: pot.id, name: pot.name || "", amountPerPeriod: amount, frequency: pot.frequency || "",
      status: pot.status || "active", period, currentPeriodPaid, dueNow, nextDueDate: null,
      arrearsOpen, arrearId: openArrears[0]?.id ?? null, wins,
    });
  }
  return {
    snap: { pots, dueNow: round2(dueNowAll), arrearsOpen: round2(arrearsAll) },
    overdue: round2(overdue),
    dueThisMonth: round2(dueThisMonth),
  };
}

// ─────────────────────────────── totals ───────────────────────────────
export function combineTotals(
  parts: Array<{ overdue: number; dueThisMonth: number } | null>,
  mgr: MgrSnap | null,
  t: TimeCtx
): ChamaTotals | null {
  const present = parts.filter((p): p is { overdue: number; dueThisMonth: number } => p !== null);
  if (present.length === 0) return null;
  let expected = 0;
  for (const pot of mgr?.pots ?? []) {
    for (const w of pot.wins) {
      if (w.kind === "scheduled" && w.amount !== null && w.expectedDate && w.expectedDate.slice(0, 7) === t.month) expected += w.amount;
    }
  }
  return {
    overdue: round2(present.reduce((s, p) => s + p.overdue, 0)),
    dueThisMonth: round2(present.reduce((s, p) => s + p.dueThisMonth, 0)),
    expectedInflowThisMonth: round2(expected),
  };
}
