import { useCallback, useEffect, useMemo, useState } from 'react';
import { httpsCallable } from 'firebase/functions';
import { functions } from './Firebase';

type Frequency = 'daily' | 'weekly' | 'biweekly';
/** Set while the plan holds under KES 300: what a payout will cost the tenant, or that it is too small to send. */
type Payout =
  | { kind: 'fee_from_rent'; creditedMinor: number; feeMinor: number; netMinor: number; thresholdMinor: number }
  | { kind: 'too_small'; creditedMinor: number; minMinor: number; thresholdMinor: number };
interface PlanView {
  frequency: Frequency; status: string; targetMinor: number; creditedMinor: number; remainingMinor: number; pct: number; settlesOn: string; dueOn?: string | null; suggestedMinor: number; payout?: Payout | null;
}
interface Res { available: boolean; reason?: string; plan?: PlanView | null; targetMinor?: number; settlesOn?: string; suggestedMinor?: number }

const kes = (minor: number) => `KES ${(minor / 100).toLocaleString('en-KE', { maximumFractionDigits: 2 })}`;
/** Same rule as the server: 5% extra under KES 100, otherwise 2.5%, rounded up to a whole shilling. The server recomputes it; this is only the preview. */
const chargeFor = (kesAmount: number) => {
  const bps = kesAmount < 100 ? 500 : 250;
  return Math.ceil((kesAmount * (10000 + bps)) / 10000);
};
/** "2026-11-05" -> "5 Nov 2026" */
const niceDate = (iso?: string | null) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : iso || '';
};
const call = <T,>(name: string, data: unknown) => httpsCallable<unknown, T>(functions, name)(data).then((r) => r.data);

interface Props { agentId: string; tenantId: number | string; phone?: string; onPaid?: () => void }

/** Lipa Mos Mos: pay rent a little at a time. Money waits safely until the target or the invoice due date, then the landlord is paid. */
export default function LipaMosMos({ agentId, tenantId, phone: phoneIn = '', onPaid }: Props) {
  const [res, setRes] = useState<Res | null>(null);
  const [freq, setFreq] = useState<Frequency>('weekly');
  const [amount, setAmount] = useState('');
  const [phone, setPhone] = useState(phoneIn);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const ids = useMemo(() => ({ agentId, tenantId: String(tenantId) }), [agentId, tenantId]);

  const load = useCallback(async () => {
    try { const r = await call<Res>('lmm_getPlan', ids); setRes(r); if (r.plan?.frequency) setFreq(r.plan.frequency); }
    catch (e: any) { setRes({ available: false, reason: e?.message || 'Could not load Lipa Mos Mos' }); }
  }, [ids]);
  useEffect(() => { void load(); }, [load]);

  if (!res) return <div className="bg-white rounded-xl shadow-md p-6 text-sm text-gray-500">Loading Lipa Mos Mos...</div>;
  if (!res.available) return <div className="bg-white rounded-xl shadow-md p-6"><p className="font-semibold text-gray-900">Lipa Mos Mos</p><p className="text-sm text-gray-600 mt-1">{res.reason}</p></div>;

  const plan = res.plan;
  const suggested = (plan?.suggestedMinor ?? res.suggestedMinor ?? 0) / 100;
  const n = Number(amount);
  const valid = Number.isInteger(n) && n >= 10 && n <= 150000;
  const small = valid && n < 100;

  const start = async () => {
    setBusy(true); setMsg(null);
    try { await call('lmm_start', { ...ids, frequency: freq }); await load(); setMsg({ kind: 'ok', text: 'Your plan is on. Pay a little at a time.' }); }
    catch (e: any) { setMsg({ kind: 'err', text: e?.message || 'Could not start the plan' }); } finally { setBusy(false); }
  };
  const pay = async () => {
    setBusy(true); setMsg(null);
    try {
      const out = await call<{ displayText: string }>('lmm_pay', { ...ids, frequency: freq, amount: n, phone });
      setMsg({ kind: 'ok', text: `${out.displayText}. Approve the M-PESA prompt on your phone.` });
      setAmount(''); setTimeout(() => { void load(); onPaid?.(); }, 15000);
    } catch (e: any) { setMsg({ kind: 'err', text: e?.message || 'Payment could not be started' }); } finally { setBusy(false); }
  };

  return (
    <div className="bg-white rounded-xl shadow-md p-6 mb-8">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-bold text-gray-900">Lipa Mos Mos</h3>
          <p className="text-sm text-gray-600 mt-1">Pay your rent a little at a time. Your landlord is paid when it is fully covered, or on the due date with whatever you have paid.</p>
        </div>
      </div>

      {plan && (
        <div className="mt-4">
          <div className="flex justify-between text-sm text-gray-700"><span>{kes(plan.creditedMinor)} paid</span><span>{kes(plan.targetMinor)} due</span></div>
          <div className="mt-1 h-3 w-full rounded-full bg-gray-200 overflow-hidden" role="progressbar" aria-valuenow={plan.pct} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full bg-green-600 transition-all" style={{ width: `${plan.pct}%` }} />
          </div>
          <p className="text-xs text-gray-500 mt-1">{plan.pct}% done. Balance {kes(plan.remainingMinor)}. {plan.dueOn ? `Due ${niceDate(plan.dueOn)}. ` : ''}Landlord is paid by {niceDate(plan.settlesOn)}.</p>
          {plan.payout?.kind === 'fee_from_rent' && (
            <p role="note" className="mt-3 rounded-lg border border-yellow-300 bg-yellow-50 p-3 text-sm text-yellow-900">
              <strong>Under KES {plan.payout.thresholdMinor / 100} paid.</strong> If this is all you have by the due date, a transfer fee of {kes(plan.payout.feeMinor)} is deducted: only {kes(plan.payout.netMinor)} of your {kes(plan.payout.creditedMinor)} reaches your rent, and you still owe {kes(plan.payout.feeMinor)} on your invoice. Pay KES {plan.payout.thresholdMinor / 100} or more in total and there is no fee for you.
            </p>
          )}
          {plan.payout?.kind === 'too_small' && (
            <p role="note" className="mt-3 rounded-lg border border-yellow-300 bg-yellow-50 p-3 text-sm text-yellow-900">
              <strong>Not enough to send yet.</strong> The least we can send your landlord is {kes(plan.payout.minMinor)}, and you have paid {kes(plan.payout.creditedMinor)}. It stays safely on your plan until you pay more. Pay KES {plan.payout.thresholdMinor / 100} or more in total to avoid any fee.
            </p>
          )}
        </div>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <label className="text-sm text-gray-700">How often
          <select className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" value={freq} onChange={(e) => setFreq(e.target.value as Frequency)} disabled={busy}>
            <option value="daily">Daily</option><option value="weekly">Weekly</option><option value="biweekly">Every 2 weeks</option>
          </select>
        </label>
        <label className="text-sm text-gray-700">Amount (KES, whole shillings)
          <input className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" inputMode="numeric" value={amount} placeholder={suggested ? String(Math.ceil(suggested)) : '500'} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))} disabled={busy} />
        </label>
        <label className="text-sm text-gray-700">M-PESA number
          <input className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" inputMode="tel" value={phone} placeholder="0712 345 678" onChange={(e) => setPhone(e.target.value)} disabled={busy} />
        </label>
      </div>

      {valid && (
        <p className="mt-2 text-sm text-gray-700">
          You will be charged <strong>KES {chargeFor(n).toLocaleString('en-KE')}</strong>: KES {n.toLocaleString('en-KE')} goes to your rent plus a {small ? '5' : '2.5'}% fee. Your rent is credited exactly KES {n.toLocaleString('en-KE')}.
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-3">
        {!plan && <button type="button" onClick={start} disabled={busy} className="px-4 py-2 rounded-lg bg-blue-600 text-white font-semibold disabled:opacity-50">Start my plan</button>}
        <button type="button" onClick={pay} disabled={busy || !valid || !phone} className="px-4 py-2 rounded-lg bg-green-600 text-white font-semibold disabled:opacity-50">{busy ? 'Please wait...' : 'Pay now'}</button>
      </div>
      {msg && <p role={msg.kind === 'err' ? 'alert' : 'status'} className={`mt-3 text-sm break-words ${msg.kind === 'err' ? 'text-red-700' : 'text-green-700'}`}>{msg.text}</p>}
    </div>
  );
}
