// Pay a MyChama obligation (contribution, loan instalment, MGR) from the portal. This is separate from the
// rent PaymentModal on purpose. The server decides everything that matters (member, fees, target
// validity); the client only sends the target, the net amount and an idempotency key.
import React, { useRef, useState } from 'react';
import { CheckCircle, Loader2, Smartphone, X } from 'lucide-react';
import { mychamaApi, mychamaErrorCode } from './api';
import type { ChamaSnapshotChama, MyChamaPurpose, PayInitiateRequest, PayInitiateResponse } from './contract';
import { chamaErrorMessage, formatKES } from './format';
import { useChamaConnector } from './connector';

export interface PayTarget {
  purpose: MyChamaPurpose;
  label: string;
  amount: number;                      // default net amount (what is due)
  contributionId?: string;
  loanId?: string;
  installmentNo?: number;
  potId?: string;
  potPeriod?: number;
  arrearId?: string;
}

const newRequestId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

interface Props { chama: ChamaSnapshotChama; target: PayTarget; onClose: () => void }

const MyChamaPayModal: React.FC<Props> = ({ chama, target, onClose }) => {
  const { refresh, syncing } = useChamaConnector();
  const requestId = useRef(newRequestId());          // same key on retry => the server dedupes
  const [amount, setAmount] = useState(String(target.amount));
  const [phone, setPhone] = useState('');
  const [step, setStep] = useState<'form' | 'submitting' | 'waiting'>('form');
  const [result, setResult] = useState<PayInitiateResponse | null>(null);
  const [error, setError] = useState('');
  const [checked, setChecked] = useState(false);

  const net = Number(amount);
  const valid = Number.isFinite(net) && net > 0;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) { setError('Please enter a valid amount.'); return; }
    setStep('submitting'); setError('');
    const req: PayInitiateRequest = {
      chamaId: chama.chamaId, purpose: target.purpose, amount: Math.round(net * 100) / 100,
      contributionId: target.contributionId, loanId: target.loanId, installmentNo: target.installmentNo,
      potId: target.potId, potPeriod: target.potPeriod, arrearId: target.arrearId,
      phone: phone.trim() || undefined, clientRequestId: requestId.current,
    };
    try {
      setResult(await mychamaApi.payInitiate(req));
      setStep('waiting');
    } catch (err) {
      setError(chamaErrorMessage(mychamaErrorCode(err)));
      setStep('form');
    }
  };

  const check = async () => { setChecked(false); await refresh(); setChecked(true); };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h3 className="text-lg font-bold text-gray-900">{target.label}</h3>
            <p className="text-sm text-gray-600">{chama.chamaName}</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-gray-500 hover:text-gray-800"><X className="w-5 h-5" /></button>
        </div>

        {step !== 'waiting' && (
          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Amount to pay (KES)</label>
              <input type="number" min="1" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-4 py-3 focus:ring-2 focus:ring-indigo-500" />
              <p className="mt-1 text-xs text-gray-500">Due: {formatKES(target.amount)}. Transaction fees are added to your M-Pesa/Airtel prompt.</p>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">M-Pesa / Airtel number <span className="text-gray-400">(optional)</span></label>
              <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Leave blank to use your MyChama number"
                className="w-full rounded-lg border border-gray-300 px-4 py-3 focus:ring-2 focus:ring-indigo-500" />
            </div>
            {error && <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
            <button type="submit" disabled={step === 'submitting' || !valid}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 py-3 font-semibold text-white hover:bg-indigo-700 disabled:opacity-60">
              {step === 'submitting' ? <Loader2 className="w-5 h-5 animate-spin" /> : <Smartphone className="w-5 h-5" />}
              {step === 'submitting' ? 'Sending prompt…' : `Pay ${valid ? formatKES(net) : ''}`}
            </button>
          </form>
        )}

        {step === 'waiting' && result && (
          <div className="space-y-4">
            <div className="flex items-start gap-3 rounded-lg border border-green-200 bg-green-50 p-4">
              <CheckCircle className="mt-0.5 w-5 h-5 shrink-0 text-green-600" />
              <div className="text-sm text-green-900">
                <p className="font-semibold">{result.message || 'Check your phone to approve the payment.'}</p>
                <p className="mt-1">You will pay {formatKES(result.grossAmount)} (includes fees).</p>
                <p className="mt-1 text-xs text-green-800">Reference: {result.reference}</p>
              </div>
            </div>
            <p className="text-xs text-gray-600">Once you approve, MyChama records the payment and your balance here updates after a refresh.</p>
            <div className="flex gap-2">
              <button onClick={check} disabled={syncing} className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-indigo-300 py-2.5 text-sm font-semibold text-indigo-700 hover:bg-indigo-50 disabled:opacity-60">
                {syncing && <Loader2 className="w-4 h-4 animate-spin" />} Check status
              </button>
              <button onClick={onClose} className="flex-1 rounded-lg bg-indigo-600 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700">Done</button>
            </div>
            {checked && !syncing && <p className="text-xs text-gray-500">Balances refreshed. If this item still shows as due, approval may still be pending — try again in a minute.</p>}
          </div>
        )}
      </div>
    </div>
  );
};

export default MyChamaPayModal;
