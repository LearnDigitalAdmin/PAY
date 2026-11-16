// Settings tab: change the due day (next cycle, with the lock rules explained) and how often / how much the tenant plans to pay.
import { useState } from 'react';
import { LMMX, isValidCredit, shortDate, type Frequency, type TenantSummaryOut } from './contract';
import { LmmxApiError, errorMessage, lmmx } from './api';
import { ERROR_FALLBACK, ERROR_TEXT, S } from './strings';
import { Alert, Btn, Card, Field, Title, inputClass } from './ui';

export default function SettingsPanel({ s, onChanged }: { s: TenantSummaryOut; onChanged: () => void }) {
  const [day, setDay] = useState(String(s.dueDay));
  const [dayBusy, setDayBusy] = useState(false);
  const [dayNote, setDayNote] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [freq, setFreq] = useState<Frequency>(s.frequency);
  const [sugg, setSugg] = useState(String(s.suggestedCreditMinor / 100));
  const [planBusy, setPlanBusy] = useState(false);
  const [planNote, setPlanNote] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const frozen = !!s.frozen || s.status !== 'active';

  const saveDay = async () => {
    const d = Number(day);
    if (!Number.isInteger(d) || d < LMMX.DUE_DAY_MIN || d > LMMX.DUE_DAY_MAX) { setDayNote({ kind: 'err', text: S.dueDayLabel }); return; }
    setDayBusy(true); setDayNote(null);
    try {
      const r = await lmmx('lmmx_tenant_setDueDay', { dueDay: d });
      setDayNote({ kind: 'ok', text: S.dueDaySaved(shortDate(r.effectiveFromCycleDate)) }); onChanged();
    } catch (e) {
      // LMMX_E_STATE = already changed this cycle, or inside the lock window before the due date
      setDayNote({ kind: 'err', text: e instanceof LmmxApiError && e.lmmx === 'LMMX_E_STATE' ? S.dueDayState : errorMessage(e, ERROR_TEXT, ERROR_FALLBACK) });
    } finally { setDayBusy(false); }
  };

  const savePlan = async () => {
    const n = sugg.trim() === '' ? undefined : Number(sugg);
    const minor = n === undefined ? undefined : n * 100;
    if (minor !== undefined && !isValidCredit(minor)) { setPlanNote({ kind: 'err', text: S.amountInvalid }); return; }
    setPlanBusy(true); setPlanNote(null);
    try { await lmmx('lmmx_tenant_setPlan', minor === undefined ? { frequency: freq } : { frequency: freq, suggestedCreditMinor: minor }); setPlanNote({ kind: 'ok', text: S.planSaved }); onChanged(); }
    catch (e) { setPlanNote({ kind: 'err', text: errorMessage(e, ERROR_TEXT, ERROR_FALLBACK) }); } finally { setPlanBusy(false); }
  };

  return (
    <div className="grid gap-4">
      <Card>
        <Title>{S.dueDayTitle}</Title>
        <p className="mt-1 text-sm text-gray-600">{S.dueDayHelp}</p>
        <div className="mt-3 flex gap-2 items-end">
          <div className="flex-1"><Field label={S.dueDayLabel}>
            <select className={inputClass} value={day} onChange={(e) => setDay(e.target.value)} disabled={dayBusy || frozen}>
              {Array.from({ length: LMMX.DUE_DAY_MAX }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </Field></div>
          <Btn onClick={saveDay} disabled={dayBusy || frozen || Number(day) === s.dueDay}>{dayBusy ? S.linking : S.dueDaySave}</Btn>
        </div>
        {dayNote && <div className="mt-3"><Alert kind={dayNote.kind}>{dayNote.text}</Alert></div>}
      </Card>

      <Card>
        <Title>{S.planTitle}</Title>
        <p className="mt-1 text-sm text-gray-600">{S.planHelp}</p>
        <div className="mt-3 grid gap-3">
          <Field label={S.frequencyLabel}>
            <select className={inputClass} value={freq} onChange={(e) => setFreq(e.target.value as Frequency)} disabled={planBusy || frozen}>
              {(Object.keys(S.frequencies) as Frequency[]).map((f) => <option key={f} value={f}>{S.frequencies[f]}</option>)}
            </select>
          </Field>
          <Field label={S.suggestedLabel}>
            <input className={inputClass} inputMode="numeric" value={sugg} onChange={(e) => setSugg(e.target.value.replace(/\D/g, ''))} disabled={planBusy || frozen} />
          </Field>
          <Btn onClick={savePlan} disabled={planBusy || frozen}>{planBusy ? S.linking : S.planSave}</Btn>
          {planNote && <Alert kind={planNote.kind}>{planNote.text}</Alert>}
        </div>
      </Card>
    </div>
  );
}
