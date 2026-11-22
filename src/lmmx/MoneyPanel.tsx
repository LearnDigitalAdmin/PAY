// Money tab: "Pay my landlord now" and "Withdraw to my M-PESA". Nobody types an amount: the SERVER takes everything available (at least KES 50) and
// does it within 24 hours. A withdrawal goes only to the phone on the account, after a code texted to that phone. Nothing here is trusted: the amounts
// shown come from the server, and the server re-checks everything when the request is made.
import { useState } from 'react';
import { LMMX, eatDate, kes, normalizeKePhone, shortDate, withdrawBreakdown, type TenantSummaryOut, type WithdrawStartOut } from './contract';
import { LmmxApiError, errorMessage, lmmx } from './api';
import { ERROR_FALLBACK, ERROR_TEXT, MONEY, SHOW_SERVER_MESSAGE } from './strings';
import { Alert, Btn, Card, Field, Title, inputClass } from './ui';
import CodeBox from './CodeBox';

/** Specific server messages for the money errors, the friendly table for everything else. */
const moneyError = (e: unknown): string => (e instanceof LmmxApiError && e.lmmx && SHOW_SERVER_MESSAGE.includes(e.lmmx) && e.message ? e.message : errorMessage(e, ERROR_TEXT, ERROR_FALLBACK));

export default function MoneyPanel({ s, defaultPhone, onChanged }: { s: TenantSummaryOut; defaultPhone: string; onChanged: () => void }) {
  const avail = s.availableMinor ?? 0;
  const min = kes(LMMX.MIN_PAYOUT_MINOR);
  const blocked = !!s.frozen || avail < LMMX.MIN_PAYOUT_MINOR || !!s.payoutPending;
  const opensAt = s.withdrawEligibleAt;
  const tooNew = typeof opensAt === 'number' && Date.now() < opensAt;   // the server enforces this too; this only explains it
  const bd = avail >= LMMX.MIN_PAYOUT_MINOR ? withdrawBreakdown(avail) : null;
  const [payStage, setPayStage] = useState<'idle' | 'confirm' | 'busy'>('idle');
  const [payNote, setPayNote] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [phone, setPhone] = useState(defaultPhone);
  const [wd, setWd] = useState<WithdrawStartOut | null>(null);
  const [wdBusy, setWdBusy] = useState(false);
  const [wdNote, setWdNote] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [wdDone, setWdDone] = useState(false);
  const [wdMsg, setWdMsg] = useState('');
  const phoneOk = !!normalizeKePhone(phone);

  const pay = async () => {
    setPayStage('busy'); setPayNote(null);
    try { const r = await lmmx('lmmx_tenant_payLandlord', {}); setPayNote({ kind: 'ok', text: r.message }); onChanged(); }
    catch (e) { setPayNote({ kind: 'err', text: moneyError(e) }); }
    finally { setPayStage('idle'); }
  };
  const start = async () => {
    setWdBusy(true); setWdNote(null);
    try { setWd(await lmmx('lmmx_tenant_withdrawStart', { phone: normalizeKePhone(phone) ?? phone })); }
    catch (e) { setWdNote({ kind: 'err', text: moneyError(e) }); }
    finally { setWdBusy(false); }
  };

  return (
    <div className="grid gap-4">
      <Card>
        <Title>{MONEY.title}</Title>
        <p className="mt-1 text-sm text-gray-600">{MONEY.availableLabel}</p>
        <p className="mt-1 text-3xl font-extrabold text-green-800">{kes(avail)}</p>
        <p className="mt-2 text-xs text-gray-600">{MONEY.explain(min)}</p>
        {s.payoutPending && <div className="mt-3"><Alert kind="info">{MONEY.pending}</Alert></div>}
        {!s.payoutPending && avail < LMMX.MIN_PAYOUT_MINOR && <div className="mt-3"><Alert kind="info">{MONEY.none(min)}</Alert></div>}
        {s.frozen && <div className="mt-3"><Alert kind="warn">{ERROR_TEXT.LMMX_E_FROZEN}</Alert></div>}
      </Card>

      <Card>
        <h3 className="font-semibold text-gray-900">{MONEY.payTitle}</h3>
        <p className="mt-1 text-sm text-gray-600">{MONEY.payExplain}</p>
        {payStage === 'idle' && <div className="mt-3"><Btn disabled={blocked} onClick={() => setPayStage('confirm')}>{MONEY.payButton}</Btn></div>}
        {payStage !== 'idle' && (
          <div className="mt-3 grid gap-2">
            <Alert kind="warn">{MONEY.payConfirm(kes(avail))}</Alert>
            <div className="flex gap-2"><Btn disabled={payStage === 'busy'} onClick={pay}>{payStage === 'busy' ? '…' : MONEY.payYes}</Btn><Btn tone="ghost" disabled={payStage === 'busy'} onClick={() => setPayStage('idle')}>{MONEY.payNo}</Btn></div>
          </div>
        )}
        {payNote && <div className="mt-3"><Alert kind={payNote.kind}>{payNote.text}</Alert></div>}
      </Card>

      <Card>
        <h3 className="font-semibold text-gray-900">{MONEY.wdTitle}</h3>
        <p className="mt-1 text-sm text-gray-600">{MONEY.wdExplain}</p>
        {tooNew && opensAt && <div className="mt-3"><Alert kind="info">{MONEY.wdOpens(shortDate(eatDate(opensAt)))}</Alert></div>}
        {!tooNew && bd && !wd && !wdDone && <p className="mt-2 text-sm font-medium text-gray-800">{MONEY.wdFeeLines(kes(bd.serviceFeeMinor), kes(bd.transferFeeMinor), kes(bd.netMinor))}</p>}
        {!wd && !wdDone && (
          <div className="mt-3 grid gap-3">
            <Field label={MONEY.wdPhone} hint={MONEY.wdPhoneHint} error={phone !== '' && !phoneOk ? MONEY.badPhone : undefined}>
              <input className={inputClass} inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} disabled={wdBusy} />
            </Field>
            <Btn disabled={blocked || tooNew || !phoneOk || wdBusy} onClick={start}>{wdBusy ? MONEY.wdSending : MONEY.wdSend}</Btn>
          </div>
        )}
        {wd && !wdDone && (
          <div className="mt-3">
            <Alert kind="info">{MONEY.wdSummary(kes(wd.availableMinor), kes(wd.serviceFeeMinor), kes(wd.transferFeeMinor), kes(wd.netMinor))}</Alert>
            <CodeBox title={MONEY.wdCodeTitle} kind="withdraw" placeholder="LMW1234" button={MONEY.wdConfirm} tone="primary"
              submit={async (code) => { const r = await lmmx('lmmx_tenant_withdrawConfirm', { otp: code }); setWdMsg(r.message); setWdDone(true); setWd(null); onChanged(); return r.message; }} />
            <div className="mt-2"><Btn tone="ghost" onClick={() => setWd(null)}>{MONEY.payNo}</Btn></div>
          </div>
        )}
        {wdDone && <div className="mt-3"><Alert kind="ok">{wdMsg || MONEY.wdDone}</Alert></div>}
        {wdNote && <div className="mt-3"><Alert kind={wdNote.kind}>{wdNote.text}</Alert></div>}
        <p className="mt-3 text-xs text-gray-500">{MONEY.wdRules}</p>
      </Card>
    </div>
  );
}
