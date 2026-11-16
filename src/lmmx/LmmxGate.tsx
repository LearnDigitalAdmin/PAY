// After a tenant signs in: find out which accounts match this phone + ID (`lmmx_tenant_link`) and send them to the right place.
//   only Lipa Mdogo Mdogo -> /lmmx/app      only the Plot Yangu invoice -> /tenant (exactly as before)      both -> a chooser
// A tenant who already has a rent-invoice profile is checked quietly with the ID on that profile; if anything goes wrong
// they land on /tenant as they always did, so the existing sign-in cannot be broken by this step.
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../Firebase';
import { useSession } from '../session/session';
import { validIdNumber, type IdType } from './contract';
import { LmmxApiError, lmmx } from './api';
import { decideDestination, rememberKinds, type Kind } from './route';
import { S } from './strings';
import { Alert, Btn, Card, Field, Spinner, Title, inputClass } from './ui';

export default function LmmxGate() {
  const navigate = useNavigate();
  const session = useSession();
  const [stage, setStage] = useState<'checking' | 'form' | 'choose'>('checking');
  const [idType, setIdType] = useState<IdType>('national_id');
  const [idNumber, setIdNumber] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const started = useRef(false);

  const go = (kinds: readonly Kind[], quiet: boolean) => {
    rememberKinds(kinds);
    const d = decideDestination(kinds);
    if (d === 'lmm') navigate('/lmmx/app', { replace: true });
    else if (d === 'legacy') navigate('/tenant', { replace: true });
    else if (d === 'choose') setStage('choose');
    else if (quiet) navigate('/tenant', { replace: true });
    else { setError(S.linkFailed); setBusy(false); }
  };

  useEffect(() => {
    if (started.current || !session.user) return;
    started.current = true;
    (async () => {
      try {
        const snap = await getDoc(doc(db, 'tenants', session.user!.uid));
        if (!snap.exists()) { setStage('form'); return; }          // a new person: ask for the ID
        const id = String(snap.data().idNumber ?? '').trim();
        if (!validIdNumber('national_id', id)) { navigate('/tenant', { replace: true }); return; }
        const out = await lmmx('lmmx_tenant_link', { idType: 'national_id', idNumber: id });
        go(out.kinds, true);
      } catch { navigate('/tenant', { replace: true }); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.user]);

  const submit = async () => {
    const id = idNumber.trim();
    if (!validIdNumber(idType, id)) { setError(S.idInvalid); return; }
    setBusy(true); setError('');
    try {
      const out = await lmmx('lmmx_tenant_link', { idType, idNumber: id });
      go(out.kinds, false);
    } catch (e) {
      // One generic failure for a wrong phone and a wrong ID: never say which one did not match.
      setError(e instanceof LmmxApiError && e.lmmx === 'LMMX_E_RATE' ? S.linkRate : e instanceof LmmxApiError && e.network ? S.linkNetwork : S.linkFailed);
      setBusy(false);
    }
  };

  const shell = (children: React.ReactNode) => <main className="min-h-screen bg-gradient-to-br from-green-50 to-emerald-100 p-4 flex items-start sm:items-center justify-center"><div className="w-full max-w-md">{children}</div></main>;

  if (stage === 'checking') return shell(<Card><Spinner label={S.checking} /></Card>);

  if (stage === 'choose') {
    return shell(
      <Card>
        <Title>{S.chooserTitle}</Title>
        <div className="mt-4 grid gap-3">
          <button type="button" onClick={() => navigate('/tenant', { replace: true })} className="text-left min-h-11 rounded-xl border-2 border-gray-200 p-4 hover:border-green-600 focus:outline-none focus:ring-2 focus:ring-green-600">
            <span className="block font-bold text-gray-900">{S.chooserLegacyTitle}</span><span className="block text-sm text-gray-600">{S.chooserLegacyBody}</span>
          </button>
          <button type="button" onClick={() => navigate('/lmmx/app', { replace: true })} className="text-left min-h-11 rounded-xl border-2 border-gray-200 p-4 hover:border-green-600 focus:outline-none focus:ring-2 focus:ring-green-600">
            <span className="block font-bold text-gray-900">{S.chooserLmmTitle}</span><span className="block text-sm text-gray-600">{S.chooserLmmBody}</span>
          </button>
        </div>
      </Card>
    );
  }

  return shell(
    <Card>
      <Title>{S.linkTitle}</Title>
      <p className="mt-1 text-sm text-gray-600">{S.linkIntro}</p>
      <div className="mt-4 grid gap-3">
        <Field label={S.idTypeLabel}>
          <select className={inputClass} value={idType} onChange={(e) => setIdType(e.target.value as IdType)} disabled={busy}>
            {(Object.keys(S.idTypes) as IdType[]).map((t) => <option key={t} value={t}>{S.idTypes[t]}</option>)}
          </select>
        </Field>
        <Field label={S.idNumberLabel} hint={S.idNumberHint(idType)}>
          <input className={inputClass} value={idNumber} autoComplete="off" inputMode={idType === 'passport' ? 'text' : 'numeric'} maxLength={9} disabled={busy}
            onChange={(e) => { setIdNumber(e.target.value); setError(''); }} onKeyDown={(e) => { if (e.key === 'Enter' && !busy) void submit(); }} />
        </Field>
        {error && <Alert kind="err">{error}</Alert>}
        <Btn onClick={submit} disabled={busy || !idNumber.trim()}>{busy ? S.linking : S.linkButton}</Btn>
        <button type="button" onClick={() => navigate('/tenant', { replace: true })} className="text-sm text-gray-600 underline min-h-11">{S.linkSkip}</button>
      </div>
    </Card>
  );
}
