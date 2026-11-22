// One box for every 4-digit code: "LMM4683", "lmm 4683" or just "4683" (setup, a change), "LMC7391" (cancel a change) and "LMW4683" (confirm a withdrawal).
import { useState } from 'react';
import { parseLmmxCode } from './contract';
import { LmmxApiError, errorMessage } from './api';
import { ERROR_FALLBACK, ERROR_TEXT, S } from './strings';
import { Alert, Btn, Field, inputClass } from './ui';

export type CodeKind = 'otp' | 'cancel' | 'withdraw';

export function normaliseCode(raw: string, kind: CodeKind): { code: string } | { error: 'bad' | 'kind' } {
  const parsed = parseLmmxCode(raw);
  if (parsed) return parsed.kind === kind ? { code: parsed.code } : { error: 'kind' };
  const m = /^\s*(\d{4})\s*$/.exec(raw);
  return m ? { code: m[1] } : { error: 'bad' };
}

interface Props {
  title: string;
  kind: CodeKind;
  placeholder: string;
  button: string;
  tone?: 'primary' | 'danger';
  /** Does the call with the normalised 4 digits and returns the success text. Throws on failure. */
  submit: (code4: string) => Promise<string>;
  onDone?: () => void;
}

export default function CodeBox({ title, kind, placeholder, button, tone = 'primary', submit, onDone }: Props) {
  const [raw, setRaw] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [locked, setLocked] = useState(false);

  const go = async () => {
    const n = normaliseCode(raw, kind);
    if ('error' in n) { setNote({ kind: 'err', text: n.error === 'kind' ? S.codeWrongKind : S.codeBad }); return; }
    setBusy(true); setNote(null);
    try {
      const text = await submit(n.code);
      setNote({ kind: 'ok', text }); setRaw('');
      onDone?.();
    } catch (e) {
      let text = errorMessage(e, ERROR_TEXT, ERROR_FALLBACK);
      if (e instanceof LmmxApiError) {
        if (e.lmmx === 'LMMX_E_OTP_LOCKED') setLocked(true);
        if (e.lmmx === 'LMMX_E_OTP_INVALID' && typeof e.attemptsLeft === 'number') text += ` ${S.codeAttemptsLeft(e.attemptsLeft)}`;
      }
      setNote({ kind: 'err', text });
    } finally { setBusy(false); }
  };

  return (
    <div className="mt-4 border-t border-gray-100 pt-4">
      <h3 className="font-semibold text-gray-900">{title}</h3>
      <div className="mt-2 flex gap-2 items-end">
        <div className="flex-1">
          <Field label={S.codeLabel}>
            <input className={inputClass} inputMode="text" autoComplete="one-time-code" value={raw} placeholder={placeholder} maxLength={12} disabled={busy || locked}
              onChange={(e) => setRaw(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !busy && !locked) void go(); }} />
          </Field>
        </div>
        <Btn tone={tone} onClick={go} disabled={busy || locked || !raw.trim()}>{busy ? S.linking : button}</Btn>
      </div>
      <p className="mt-2 text-xs text-gray-500">{S.codeShareWarning} {S.whatsappHint}</p>
      {note && <div className="mt-2"><Alert kind={note.kind}>{note.text}</Alert></div>}
    </div>
  );
}
