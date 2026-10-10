// Run:  node --experimental-strip-types --test tests/mychama/calc.test.mts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  landlordPeriodSummary, tenantMonthSummary, monthRange, previousMonthRange, lastDaysRange,
  sumRentCollected, splitInvoiceOutstanding, isoDateEat,
} from '../../src/mychama/calc.ts';

const chama = (over: Record<string, unknown> = {}) => ({
  chamaId: 'c1', chamaName: 'Alpha', memberId: 'm1', onlineCollectionEnabled: true, dataStatus: 'ok', missing: [], asOf: 1,
  contributions: { outstanding: 2000, items: [
    { contributionId: 'k1', periodKey: '2026-09', dueDate: '2026-09-05', amount: 1000, paid: 0, outstanding: 1000, status: 'overdue' },
    { contributionId: 'k2', periodKey: '2026-10', dueDate: '2026-10-25', amount: 1000, paid: 0, outstanding: 1000, status: 'pending' },
    { contributionId: 'k3', periodKey: '2026-11', dueDate: '2026-11-05', amount: 1000, paid: 0, outstanding: 1000, status: 'pending' } ] },
  loans: { outstanding: 2200, items: [{ loanId: 'l1', principal: 3000, outstanding: 2200, status: 'active', installmentsRemaining: 2, nextInstallment: { installmentNo: 3, due: 1100, dueDate: '2026-10-15' } }] },
  mgr: { dueNow: 500, arrearsOpen: 300, pots: [{ potId: 'p1', name: 'Pot', amountPerPeriod: 500, frequency: 'weekly', status: 'active', period: 2, currentPeriodPaid: false, dueNow: 500, nextDueDate: null, arrearsOpen: 300, arrearId: 'a1',
    wins: [{ kind: 'won', potId: 'p1', potName: 'Pot', round: 1, amount: 4000, expectedDate: '2026-10-03', queuePosition: null }, { kind: 'scheduled', potId: 'p1', potName: 'Pot', round: 3, amount: 4000, expectedDate: null, queuePosition: 2 }] }] },
  totals: { overdue: 1300, dueThisMonth: 2600, expectedInflowThisMonth: 0 },
  ...over,
}) as any;

const oct = monthRange('2026-10-09');

test('date helpers', () => {
  assert.deepEqual(oct, { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(previousMonthRange('2026-01-09'), { from: '2025-12-01', to: '2025-12-31' });
  assert.deepEqual(lastDaysRange('2026-10-09', 3), { from: '2026-10-07', to: '2026-10-09' });
  assert.equal(isoDateEat(new Date('2026-10-09T22:30:00Z')), '2026-10-10');   // EAT is UTC+3
});

test('rent collected: only successful payments inside the period (EAT)', () => {
  const p = [
    { amount: 1000, status: 'success', date: new Date('2026-10-02T10:00:00Z') },
    { amount: 500, status: 'failed', date: new Date('2026-10-03T10:00:00Z') },
    { amount: 700, status: 'success', date: new Date('2026-09-30T22:00:00Z') },   // = 1 Oct 01:00 EAT -> inside
    { amount: 900, status: 'success', date: new Date('2026-09-15T10:00:00Z') },
    { amount: 100, status: 'success', date: null },
  ];
  assert.equal(sumRentCollected(p, oct), 1700);
});

test('landlord: deductions = overdue-before + due-in-period, future ignored, wins received added', () => {
  const s = landlordPeriodSummary({ rentCollected: 20000, period: oct }, [chama()]);
  const byLabel = Object.fromEntries(s.lines.map((l) => [l.label, l]));
  assert.equal(byLabel['Contribution 2026-09'].bucket, 'overdue_before');
  assert.equal(byLabel['Contribution 2026-10'].bucket, 'in_period');
  assert.ok(!byLabel['Contribution 2026-11'], 'next month is outside the period');
  assert.equal(s.totals.contributions, 2000);
  assert.equal(s.totals.loans, 1100);
  assert.equal(s.totals.mgr, 800);                 // 500 due now + 300 arrears
  assert.equal(s.totals.deductions, 3900);
  assert.equal(s.winsReceived, 4000);              // won on 2026-10-03
  assert.equal(s.net, 20000 - 3900 + 4000);
  assert.equal(s.scheduledWins.length, 1);
  assert.equal(s.incomplete, false);
});

test('landlord: unavailable sections are flagged, never silently zero', () => {
  const s = landlordPeriodSummary({ rentCollected: 1000, period: oct }, [chama({ dataStatus: 'partial', missing: ['loans'], loans: null })]);
  assert.equal(s.incomplete, true);
  assert.deepEqual(s.unavailableChamas, ['Alpha']);
  assert.equal(s.totals.loans, 0);
  const gone = landlordPeriodSummary({ rentCollected: 1000, period: oct }, [chama({ dataStatus: 'unavailable', contributions: null, loans: null, mgr: null, totals: null })]);
  assert.equal(gone.totals.deductions, 0); assert.equal(gone.incomplete, true);
});

test('landlord: net can go negative; no chamas => net equals rent', () => {
  const noMgr = landlordPeriodSummary({ rentCollected: 1000, period: oct }, [chama({ mgr: { pots: [], dueNow: 0, arrearsOpen: 0 } })]);
  assert.equal(noMgr.net, 1000 - 3100);            // 2000 contributions + 1100 loan, no wins
  const none = landlordPeriodSummary({ rentCollected: 1234.5, period: oct }, []);
  assert.equal(none.net, 1234.5); assert.equal(none.incomplete, false);
});

test('tenant: totalNeed = rent + bills + chama(overdue + this month); per-chama unavailable flagged', () => {
  const s = tenantMonthSummary({ rentDue: 15000, billsDue: 1200 }, [chama(), chama({ chamaId: 'c2', chamaName: 'Beta', totals: null, dataStatus: 'unavailable', contributions: null, loans: null, mgr: null })]);
  assert.equal(s.chamaTotal, 3900);
  assert.equal(s.totalNeed, 15000 + 1200 + 3900);
  assert.equal(s.perChama[1].available, false);
  assert.equal(s.incomplete, true);
  assert.equal(s.netNeed, s.totalNeed);
});

test('tenant: expected wins this month reduce the need but never below zero', () => {
  const s = tenantMonthSummary({ rentDue: 0, billsDue: 0 }, [chama({ totals: { overdue: 0, dueThisMonth: 1000, expectedInflowThisMonth: 4000 } })]);
  assert.equal(s.netNeed, 0);
});

test('invoice split: rent first, rest are bills; paid invoices ignored', () => {
  const r = splitInvoiceOutstanding([
    { rentAmount: 10000, totalAmount: 12000, amountPaid: 3000, isPaid: false },   // outstanding 9000 -> rent 9000
    { rentAmount: 10000, totalAmount: 12000, amountPaid: 0, isPaid: false },      // rent 10000, bills 2000
    { rentAmount: 10000, totalAmount: 12000, amountPaid: 12000, isPaid: true },
  ]);
  assert.deepEqual(r, { rentDue: 19000, billsDue: 2000 });
});
