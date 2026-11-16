// Realistic fixtures for every lmmx_tenant_* op (VITE_LMMX_MOCK=true). State lives in memory (and the chosen scenario in
// sessionStorage), so an awaiting tenant really becomes active after the right code, and a payment really shows up after a
// few seconds. Nothing here talks to a server.
import {
  LMMX, kes, parseLmmxCode, quoteInstalment, nextDueDate, eatDate,
  type LmmxCallableMap, type LmmxErrorCode, type PendingChangeView, type InstalmentView, type TenantSummaryOut,
} from './contract';

export type Scenario = 'active' | 'awaiting' | 'frozen' | 'cooling' | 'deferred' | 'pending_otp' | 'paid_up';
export const SCENARIOS: readonly Scenario[] = ['active', 'awaiting', 'frozen', 'cooling', 'deferred', 'pending_otp', 'paid_up'];
const KEY = 'lmmx.mock.scenario';
const FAIL = 'lmmx.mock.fail';

export const mockScenario = (): Scenario => {
  try { const v = sessionStorage.getItem(KEY) as Scenario | null; return v && SCENARIOS.includes(v) ? v : 'active'; } catch { return 'active'; }
};
export function setMockScenario(s: Scenario): void { try { sessionStorage.setItem(KEY, s); } catch { /* storage unavailable */ } reset(); }
/** Make the NEXT call of any op fail with this code (null clears it). Lets every error state be seen. */
export function setMockFail(code: LmmxErrorCode | null): void { try { if (code) sessionStorage.setItem(FAIL, code); else sessionStorage.removeItem(FAIL); } catch { /* storage unavailable */ } }

class MockError extends Error {
  details: { lmmx: LmmxErrorCode; attemptsLeft?: number };
  code = 'functions/failed-precondition';
  constructor(lmmx: LmmxErrorCode, message: string, attemptsLeft?: number) { super(message); this.details = { lmmx, attemptsLeft }; }
}

const RENT = 1_000_000;
interface Store { status: TenantSummaryOut['status']; credited: number; dueDay: number; frequency: 'daily' | 'weekly' | 'biweekly'; suggested: number; pending?: PendingChangeView; history: InstalmentView[]; wrong: number; dueChanged: boolean; pendingPay: { at: number; credit: number; charge: number; fail: boolean } | null }
let st: Store;
function reset(): void {
  const s = mockScenario();
  const now = Date.now();
  st = {
    status: s === 'awaiting' ? 'awaiting_confirmation' : s === 'frozen' ? 'frozen' : 'active',
    credited: s === 'paid_up' ? RENT : s === 'awaiting' ? 0 : 250_000,
    dueDay: 5, frequency: 'weekly', suggested: 250_000, wrong: 0, dueChanged: false, pendingPay: null,
    pending:
      s === 'cooling' ? { changeId: 'chg1', kind: 'recipient', status: 'cooling_off', summary: 'Payout account changed to M-PESA ...473', coolingOffUntil: now + 30 * 3_600_000, applyAfter: now + 30 * 3_600_000, initiatedBy: 'desk' }
      : s === 'deferred' ? { changeId: 'chg2', kind: 'rent', status: 'deferred', summary: 'Rent changed to KES 12,000', applyAfter: now + 9 * 86_400_000, initiatedBy: 'desk' }
      : s === 'pending_otp' ? { changeId: 'chg3', kind: 'recipient', status: 'awaiting_tenant_otp', summary: 'Payout account changed to TILL ...902', initiatedBy: 'desk' }
      : undefined,
    history: s === 'awaiting' ? [] : [
      { paymentId: 'p3', at: now - 2 * 86_400_000, creditMinor: 150_000, chargeMinor: 157_000, feesMinor: 7_000, status: 'success' },
      { paymentId: 'p2', at: now - 5 * 86_400_000, creditMinor: 100_000, chargeMinor: 105_000, feesMinor: 5_000, status: 'success' },
      { paymentId: 'p1', at: now - 6 * 86_400_000, creditMinor: 50_000, chargeMinor: 53_500, feesMinor: 3_500, status: 'failed' },
    ],
  };
}
reset();

const delay = (ms = 350) => new Promise((r) => setTimeout(r, ms));
const today = () => eatDate(Date.now());

function summary(): TenantSummaryOut {
  const due = nextDueDate(today(), st.dueDay, 1);
  const payBy = nextDueDate(today(), st.dueDay, 1).replace(/-(\d\d)$/, (_m, d) => `-${String(Math.max(1, Number(d) - 3)).padStart(2, '0')}`);
  const remaining = Math.max(0, RENT - st.credited);
  return {
    status: st.status, firstName: 'Mary', rentMinor: RENT, dueDay: st.dueDay, frequency: st.frequency, suggestedCreditMinor: st.suggested,
    cycle: st.status === 'awaiting_confirmation' ? undefined : { cycleId: 'c1', status: remaining === 0 ? 'funded' : 'open', dueDate: due, payByDate: payBy, rentMinor: RENT, creditedMinor: st.credited, remainingMinor: remaining, settledMinor: 0, pct: Math.min(100, Math.floor((st.credited / RENT) * 100)) },
    recipient: { channel: 'till', accountNumber: '5123902', resolvedNameMasked: 'J*** M****', nameMatch: 'matched', status: 'verified' },
    pendingChange: st.pending,
    awaitingSetup: st.status === 'awaiting_confirmation' ? { otpExpiresAt: Date.now() + 25 * 60_000, summary: `Pay rent ${kes(RENT)} to J*** M**** (TILL ...902) by day ${st.dueDay} monthly.` } : undefined,
    frozen: st.status === 'frozen' ? true : undefined,
    supportPhone: '0791286165',
  };
}

function settlePendingPay(): void {
  const p = st.pendingPay;
  if (!p || Date.now() - p.at < 6_000) return;
  st.history = [{ paymentId: `p${Date.now()}`, at: p.at, creditMinor: p.credit, chargeMinor: p.charge, feesMinor: p.charge - p.credit, status: p.fail ? 'failed' : 'success' }, ...st.history];
  if (!p.fail) st.credited = Math.min(RENT, st.credited + p.credit);
  st.pendingPay = null;
}

function checkCode(raw: unknown, kind: 'otp' | 'cancel'): void {
  const p = parseLmmxCode(raw) ?? (/^\s*\d{4}\s*$/.test(String(raw)) ? { kind, code: String(raw).trim() } : null);
  if (!p || p.kind !== kind) throw new MockError('LMMX_E_VALIDATION', 'bad code shape');
  if (p.code === '0000') throw new MockError('LMMX_E_OTP_EXPIRED', 'code expired');
  if (p.code === '9999') throw new MockError('LMMX_E_OTP_LOCKED', 'locked');
  if (p.code !== '4683' && p.code !== '7391') {
    st.wrong += 1;
    if (st.wrong >= LMMX.OTP_MAX_ATTEMPTS) throw new MockError('LMMX_E_OTP_LOCKED', 'locked');
    throw new MockError('LMMX_E_OTP_INVALID', 'wrong code', LMMX.OTP_MAX_ATTEMPTS - st.wrong);
  }
  st.wrong = 0;
}

export async function mockCall(op: keyof LmmxCallableMap, d: Record<string, unknown>): Promise<unknown> {
  await delay();
  try { const f = sessionStorage.getItem(FAIL) as LmmxErrorCode | null; if (f) { sessionStorage.removeItem(FAIL); throw new MockError(f, 'forced mock error'); } } catch (e) { if (e instanceof MockError) throw e; }
  settlePendingPay();
  switch (op) {
    case 'lmmx_tenant_link': {
      const id = String(d.idNumber);
      if (id === '11111111') return { kinds: ['lmm'] };
      if (id === '22222222') return { kinds: ['legacy'] };
      if (id === '33333333') return { kinds: ['lmm', 'legacy'] };
      if (id === '99999999') throw new MockError('LMMX_E_RATE', 'rate');
      throw new MockError('LMMX_E_NOT_FOUND', 'no match'); // same failure for a wrong phone and a wrong ID
    }
    case 'lmmx_tenant_summary': return summary();
    case 'lmmx_tenant_history': {
      const page = d.cursor === 'more';
      return page ? { items: [{ paymentId: 'p0', at: Date.now() - 20 * 86_400_000, creditMinor: 200_000, chargeMinor: 209_000, feesMinor: 9_000, status: 'success' }] } : { items: st.history, nextCursor: st.history.length >= 3 ? 'more' : undefined };
    }
    case 'lmmx_tenant_quote': {
      const credit = Number(d.creditMinor);
      const remaining = Math.max(0, RENT - st.credited);
      if (st.status === 'frozen') throw new MockError('LMMX_E_FROZEN', 'frozen');
      if (st.status !== 'active') throw new MockError('LMMX_E_STATE', 'not active');
      if (!Number.isInteger(credit) || credit % 100 !== 0 || credit > remaining || (credit < LMMX.MIN_CREDIT_MINOR && credit !== remaining)) throw new MockError('LMMX_E_AMOUNT', 'amount');
      const q = quoteInstalment({ creditMinor: credit, rentMinor: RENT, channel: 'till', remainingRentMinor: remaining });
      return { quoteId: `mq-${credit}-${Date.now()}`, expiresAt: Date.now() + 10 * 60_000, creditMinor: q.creditMinor, transferReserveMinor: q.transferReserveMinor, serviceFeeMinor: q.serviceFeeMinor, collectionAllowanceMinor: q.collectionAllowanceMinor, chargeMinor: q.chargeMinor, feesMinor: q.feesMinor, payByDate: summary().cycle?.payByDate ?? today(), remainingAfterMinor: remaining - credit };
    }
    case 'lmmx_tenant_pay': {
      const m = /^mq-(\d+)-/.exec(String(d.quoteId));
      if (!m) throw new MockError('LMMX_E_QUOTE', 'quote');
      const credit = Number(m[1]);
      const q = quoteInstalment({ creditMinor: credit, rentMinor: RENT, channel: 'till', remainingRentMinor: Math.max(0, RENT - st.credited) });
      // paying from 0700000000 fails after the prompt (declined), anything else succeeds a few seconds later
      st.pendingPay = { at: Date.now(), credit, charge: q.chargeMinor, fail: String(d.payerPhone).endsWith('700000000') };
      return { reference: 'LMX_MOCK_1', displayText: 'Check your phone for the M-PESA prompt', chargeMinor: q.chargeMinor };
    }
    case 'lmmx_tenant_setDueDay': {
      const day = Number(d.dueDay);
      if (!Number.isInteger(day) || day < LMMX.DUE_DAY_MIN || day > LMMX.DUE_DAY_MAX) throw new MockError('LMMX_E_VALIDATION', 'day');
      if (st.dueChanged) throw new MockError('LMMX_E_STATE', 'already changed this cycle');
      st.dueChanged = true;
      return { dueDay: day, effectiveFromCycleDate: nextDueDate(today(), day, 30) };
    }
    case 'lmmx_tenant_setPlan': {
      st.frequency = d.frequency as Store['frequency'];
      if (typeof d.suggestedCreditMinor === 'number') st.suggested = d.suggestedCreditMinor;
      return { ok: true };
    }
    case 'lmmx_tenant_confirmSetup': {
      if (st.status !== 'awaiting_confirmation') throw new MockError('LMMX_E_STATE', 'not awaiting');
      checkCode(d.otp, 'otp');
      st.status = 'active';
      return { status: 'active' };
    }
    case 'lmmx_tenant_confirmChange': {
      if (!st.pending || st.pending.changeId !== d.changeId) throw new MockError('LMMX_E_NOT_FOUND', 'no change');
      checkCode(d.otp, 'otp');
      st.pending = { ...st.pending, status: 'cooling_off', coolingOffUntil: Date.now() + 48 * 3_600_000, applyAfter: Date.now() + 48 * 3_600_000 };
      return { changeId: st.pending.changeId, status: 'cooling_off', applyAfter: st.pending.applyAfter };
    }
    case 'lmmx_tenant_cancelChange': {
      if (!st.pending || st.pending.changeId !== d.changeId) throw new MockError('LMMX_E_NOT_FOUND', 'no change');
      checkCode(d.cancelCode, 'cancel');
      st.pending = undefined;
      return { ok: true };
    }
    default: throw new MockError('LMMX_E_FORBIDDEN', 'not a tenant op');
  }
}
