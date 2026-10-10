// "Verify this phone" card: MyChama knows you by ID number but under a different phone. Tap to send a
// code to the MyChama-registered number (shown masked), enter it, and the chamas on that phone link.
import React, { useEffect, useState } from 'react';
import { Loader2, ShieldCheck, Smartphone } from 'lucide-react';
import { mychamaApi, mychamaErrorCode } from './api';
import type { PendingVerification, RequestCodeResponse } from './contract';
import { chamaErrorMessage, remainingAttemptsOf } from './format';
import { useChamaConnector } from './connector';

const PendingLinkCard: React.FC<{ pending: PendingVerification }> = ({ pending }) => {
  const { refresh } = useChamaConnector();
  const [challenge, setChallenge] = useState<RequestCodeResponse | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!challenge) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [challenge]);

  const resendIn = challenge ? Math.max(0, Math.ceil((challenge.resendAfter - now) / 1000)) : 0;

  const send = async () => {
    setBusy(true); setError('');
    try {
      setChallenge(await mychamaApi.requestCode({ pendingId: pending.pendingId }));
      setCode('');
    } catch (e) {
      setError(chamaErrorMessage(mychamaErrorCode(e)));
    } finally { setBusy(false); }
  };

  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!challenge) return;
    setBusy(true); setError('');
    try {
      const res = await mychamaApi.verifyCode({ challengeId: challenge.challengeId, code: code.trim() });
      setDone(res.linkedChamas);
      await refresh();
    } catch (err) {
      const left = remainingAttemptsOf(err);
      setError(chamaErrorMessage(mychamaErrorCode(err)) + (left !== null ? ` ${left} attempt${left === 1 ? '' : 's'} left.` : ''));
    } finally { setBusy(false); }
  };

  if (done !== null) {
    return (
      <div className="rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-800 flex items-center gap-2">
        <ShieldCheck className="w-5 h-5" /> Verified — {done} chama{done === 1 ? '' : 's'} linked.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-4">
      <div className="flex items-start gap-3">
        <Smartphone className="w-5 h-5 text-indigo-700 mt-0.5 shrink-0" />
        <div className="flex-1">
          <p className="text-sm font-semibold text-gray-900">
            {pending.chamaCount} chama{pending.chamaCount === 1 ? '' : 's'} found under {pending.maskedPhone}
          </p>
          <p className="text-xs text-gray-600 mt-1">
            That number is different from the one you signed in with. We can send a code to it to confirm it is yours.
          </p>

          {!challenge && (
            <button onClick={send} disabled={busy} className="mt-3 inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60">
              {busy && <Loader2 className="w-4 h-4 animate-spin" />} Send code to {pending.maskedPhone}
            </button>
          )}

          {challenge && (
            <form onSubmit={verify} className="mt-3 space-y-2">
              <label className="block text-xs font-medium text-gray-700">Enter the 6-digit code sent to {challenge.maskedPhone}</label>
              <div className="flex gap-2">
                <input
                  inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  className="w-32 rounded-lg border border-gray-300 px-3 py-2 text-center text-lg tracking-widest focus:ring-2 focus:ring-indigo-500"
                  placeholder="••••••"
                />
                <button type="submit" disabled={busy || code.length !== 6} className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60">
                  {busy && <Loader2 className="w-4 h-4 animate-spin" />} Verify
                </button>
              </div>
              <button type="button" onClick={send} disabled={busy || resendIn > 0} className="text-xs font-medium text-indigo-700 disabled:text-gray-400">
                {resendIn > 0 ? `Resend code in ${resendIn}s` : 'Resend code'}
              </button>
            </form>
          )}

          {error && <p className="mt-2 text-xs text-red-700">{error}</p>}
        </div>
      </div>
    </div>
  );
};

export default PendingLinkCard;
