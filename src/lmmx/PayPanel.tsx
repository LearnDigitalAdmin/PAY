// Pay tab: amount -> live server quote (rent / fees / you pay) -> M-PESA number -> STK prompt -> wait for the SERVER to show the
// credit. The screen never says "received" until `lmmx_tenant_summary` shows the credit (or history shows the failure).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LMMX, kes, normalizeKePhone, quoteInstalment, type TenantQuoteOut, type TenantSummaryOut } from './contract';
import { LmmxApiError, errorMessage, lmmx } from './api';
import { ERROR_FALLBACK, ERROR_TEXT, S } from './strings';
import { Alert, Btn, Card, Field, Spinner, Title, inputClass } from './ui';

type Stage = 'form' | 'sending' | 'waiting' | 'success' | 'failed' | 'timeout';
const POLL_MS = 4000;
const GIVE_UP_MS = 120_000;
const localPhone = (e164: string) => (e164.startsWith('+254') ? `0${e164.slice(4)}` : e164);

export default function PayPanel({ s, defaultPhone, onPaid }: { s: TenantSummaryOut; defaultPhone: string; onPaid: () => void }) {
  const remaining = s.cycle?.remainingMinor ?? 0;
  const [amount, setAmount] = useState('');
  const [phone, setPhone] = useState(defaultPhone);
  const [quote, setQuote] = useState<TenantQuoteOut | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [note, setNote] = useState<{ kind: 'err' | 'info'; text: string } | null>(null);
  const [stage, setStage] = useState<Stage>('form');
  const paid = useRef<{ baseline: number; credit: number; since: number; charge: number; phone: string } | null>(null);
  const seq = useRef(0);

  const n = amount === '' ? NaN : Number(amount);
  const minor = n * 100;
  const maxKes = LMMX.MAX_CREDIT_MINOR / 100;
  const isLast = Number.isInteger(n) && minor === remaining;       // the last instalment may be smaller than the minimum
  // The server decides what may be paid (LMMX_E_AMOUNT); here only the shape and the contract's limits are checked.
  const valid = Number.isInteger(n) && n <= maxKes && (minor >= LMMX.MIN_CREDIT_MINOR || isLast) && minor > 0;
  const phoneE164 = normalizeKePhone(phone);
  const blocked = !!s.frozen || s.status !== 'active';

  // Instant preview from the contract's fee engine, until the server's exact quote arrives.
  const preview = useMemo(() => (valid ? quoteInstalment({ creditMinor: minor, rentMinor: s.rentMinor, channel: s.recipient.channel, remainingRentMinor: remaining || undefined }) : null), [valid, minor, s.rentMinor, s.recipient.channel, remaining]);

  // Live quote, debounced; a newer keystroke makes an older answer harmless.
  useEffect(() => {
    setQuote(null);
    if (!valid || blocked || stage !== 'form') return;
    const mine = ++seq.current;
    setQuoting(true);
    const t = setTimeout(async () => {
      try {
        const q = await lmmx('lmmx_tenant_quote', { creditMinor: minor });
        if (mine === seq.current) { setQuote(q); setNote(null); }
      } catch (e) { if (mine === seq.current) setNote({ kind: 'err', text: errorMessage(e, ERROR_TEXT, S.quoteFailed) }); }
      finally { if (mine === seq.current) setQuoting(false); }
    }, 500);
    return () => { clearTimeout(t); };
  }, [valid, minor, blocked, stage]);

  const lines = quote ?? preview;
  const exact = !!quote;

  const pay = async () => {
    if (!valid || !phoneE164 || !quote) return;
    if (quote.expiresAt <= Date.now()) {
      try { setQuote(await lmmx('lmmx_tenant_quote', { creditMinor: minor })); setNote({ kind: 'info', text: S.quoteExpired }); }
      catch (e) { setNote({ kind: 'err', text: errorMessage(e, ERROR_TEXT, S.quoteFailed) }); }
      return;
    }
    setStage('sending'); setNote(null);
    try {
      await lmmx('lmmx_tenant_pay', { quoteId: quote.quoteId, payerPhone: phoneE164 });
      paid.current = { baseline: s.cycle?.creditedMinor ?? 0, credit: quote.creditMinor, since: Date.now(), charge: quote.chargeMinor, phone: phoneE164 };
      setStage('waiting');
    } catch (e) {
      setStage('form');
      if (e instanceof LmmxApiError && e.lmmx === 'LMMX_E_QUOTE') {
        try { setQuote(await lmmx('lmmx_tenant_quote', { creditMinor: minor })); } catch { /* the error below is enough */ }
      }
      setNote({ kind: 'err', text: errorMessage(e, ERROR_TEXT, ERROR_FALLBACK) });
    }
  };

  // While waiting: ask the server (summary, and history for a decline) until it shows the outcome. No guessing.
  const check = useCallback(async (): Promise<boolean> => {
    const p = paid.current; if (!p) return true;
    try {
      const [sum, hist] = await Promise.all([lmmx('lmmx_tenant_summary', {}), lmmx('lmmx_tenant_history', {})]);
      if ((sum.cycle?.creditedMinor ?? 0) >= p.baseline + p.credit) { setStage('success'); onPaid(); return true; }
      if (hist.items.some((i) => i.status === 'failed' && i.at >= p.since - 5000 && i.chargeMinor === p.charge)) { setStage('failed'); return true; }
    } catch { /* keep waiting; the next check tries again */ }
    return false;
  }, [onPaid]);

  useEffect(() => {
    if (stage !== 'waiting') return;
    const p = paid.current;
    const id = setInterval(async () => {
      if (await check()) { clearInterval(id); return; }
      if (p && Date.now() - p.since > GIVE_UP_MS) { clearInterval(id); setStage('timeout'); }
    }, POLL_MS);
    return () => clearInterval(id);
  }, [stage, check]);

  const reset = () => { paid.current = null; setAmount(''); setQuote(null); setNote(null); setStage('form'); };

  if (stage === 'sending') return <Card><Spinner label={S.paying} /></Card>;

  if (stage === 'waiting' || stage === 'timeout') {
    const p = paid.current;
    return (
      <Card>
        <Title>{stage === 'waiting' ? S.waitingTitle : S.timeoutTitle}</Title>
        {stage === 'waiting' && p && <p className="mt-2 text-sm text-gray-800">{S.waitingBody(localPhone(p.phone), kes(p.charge))}</p>}
        {stage === 'waiting' ? <div className="mt-3"><Spinner label={S.waitingNote} /></div> : <p className="mt-2 text-sm text-gray-800">{S.timeoutBody}</p>}
        <div className="mt-4 flex flex-wrap gap-3">
          <Btn tone="ghost" onClick={() => void check()}>{S.checkNow}</Btn>
          {stage === 'waiting' && <Btn tone="ghost" onClick={() => setStage('failed')}>{S.didNotGetPrompt}</Btn>}
          {stage === 'timeout' && <Btn tone="ghost" onClick={reset}>{S.done}</Btn>}
        </div>
      </Card>
    );
  }
  if (stage === 'success') {
    return <Card><Alert kind="ok"><strong>{S.successTitle}</strong><br />{S.successBody(kes(paid.current?.credit ?? 0))}</Alert><div className="mt-4"><Btn onClick={reset}>{S.done}</Btn></div></Card>;
  }
  if (stage === 'failed') {
    return <Card><Alert kind="err"><strong>{S.failedTitle}</strong><br />{S.failedBody}</Alert><div className="mt-4"><Btn onClick={reset}>{S.payAgain}</Btn></div></Card>;
  }

  const quick = Array.from(new Set([s.suggestedCreditMinor, s.suggestedCreditMinor * 2, remaining])).filter((q) => q >= LMMX.MIN_CREDIT_MINOR && q <= remaining && q % 100 === 0).slice(0, 3);

  return (
    <Card>
      <Title>{S.payTitle}</Title>
      {blocked && <div className="mt-3"><Alert kind="warn">{s.frozen ? S.frozenBody(s.supportPhone) : ERROR_TEXT.LMMX_E_STATE}</Alert></div>}
      <div className="mt-3 grid gap-3">
        <Field label={S.amountLabel} hint={`${S.amountHint(kes(LMMX.MIN_CREDIT_MINOR), kes(LMMX.MAX_CREDIT_MINOR))} ${S.amountLastSmaller}`} error={amount !== '' && !valid ? S.amountInvalid : undefined}>
          <input className={inputClass} inputMode="numeric" value={amount} placeholder={s.suggestedCreditMinor ? String(Math.ceil(s.suggestedCreditMinor / 100)) : '500'} disabled={blocked}
            onChange={(e) => setAmount(e.target.value.replace(/\D/g, '').slice(0, 7))} />
        </Field>
        {quick.length > 0 && (
          <div role="group" aria-label={S.quickLabel} className="flex flex-wrap gap-2">
            {quick.map((q) => <Btn key={q} tone="ghost" disabled={blocked} onClick={() => setAmount(String(q / 100))}>{q === remaining && q !== s.suggestedCreditMinor ? `${S.quickFull} ${kes(q)}` : kes(q)}</Btn>)}
          </div>
        )}
        <Field label={S.phoneLabel} hint={S.phoneHint} error={phone !== '' && !phoneE164 ? S.phoneInvalid : undefined}>
          <input className={inputClass} inputMode="tel" autoComplete="tel" value={phone} placeholder="0712 345 678" disabled={blocked} onChange={(e) => setPhone(e.target.value)} />
        </Field>

        {lines && (
          <dl className="rounded-lg bg-gray-50 p-3 text-sm" aria-live="polite">
            <div className="flex justify-between py-1"><dt className="text-gray-600">{S.linesGoes}</dt><dd className="font-semibold">{kes(lines.creditMinor)}</dd></div>
            <div className="flex justify-between py-1"><dt className="text-gray-600">{S.linesFees}</dt><dd className="font-semibold">{kes(lines.feesMinor)}</dd></div>
            <div className="flex justify-between py-1 border-t border-gray-200 mt-1 pt-2"><dt className="font-semibold text-gray-900">{S.linesPay}</dt><dd className="font-bold text-gray-900">{kes(lines.chargeMinor)}</dd></div>
            <p className="mt-1 text-xs text-gray-500">{exact ? '' : quoting ? S.quoting : S.estimate}</p>
          </dl>
        )}
        {note && <Alert kind={note.kind}>{note.text}</Alert>}
        <Btn onClick={pay} disabled={blocked || !valid || !phoneE164 || !quote || quoting}>{quote ? S.payButton(kes(quote.chargeMinor)) : S.payButton(valid ? kes(minor) : '')}</Btn>
      </div>
    </Card>
  );
}
