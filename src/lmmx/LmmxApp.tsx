// The standalone Lipa Mdogo Mdogo app for a tenant: Home, Pay, History, Settings. Reached after `lmmx_tenant_link` (see LmmxGate).
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AuthService, auth } from '../Firebase';
import type { TenantSummaryOut } from './contract';
import { LmmxApiError, errorMessage, isMock, lmmx } from './api';
import { SCENARIOS, setMockFail, setMockScenario, mockScenario } from './mock';
import { recalledKinds } from './route';
import Dashboard from './Dashboard';
import HistoryPanel from './HistoryPanel';
import PayPanel from './PayPanel';
import MoneyPanel from './MoneyPanel';
import SettingsPanel from './SettingsPanel';
import { ERROR_TEXT, S } from './strings';
import { Alert, Btn, Card, Spinner } from './ui';

type Tab = 'home' | 'pay' | 'money' | 'history' | 'settings';
const TABS: Tab[] = ['home', 'pay', 'money', 'history', 'settings'];

export default function LmmxApp({ demo = false }: { demo?: boolean }) {
  const navigate = useNavigate();
  const [s, setS] = useState<TenantSummaryOut | null>(null);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState<Tab>('home');
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    try { setS(await lmmx('lmmx_tenant_summary', {})); setErr(''); }
    catch (e) {
      // Not linked (or not a standalone tenant): back to the link step instead of a dead end.
      if (!demo && e instanceof LmmxApiError && (e.lmmx === 'LMMX_E_NOT_FOUND' || e.lmmx === 'LMMX_E_NEEDS_REAUTH')) { navigate('/lmmx', { replace: true }); return; }
      setErr(errorMessage(e, ERROR_TEXT, S.loadFailed));
    }
  }, [navigate, demo]);
  useEffect(() => { void load(); }, [load]);
  const changed = useCallback(() => { void load(); setTick((t) => t + 1); }, [load]);

  const signOut = async () => { try { await AuthService.signOut(); } finally { navigate('/'); } };
  const hasLegacy = recalledKinds().includes('legacy');
  const defaultPhone = auth.currentUser?.phoneNumber ? `0${auth.currentUser.phoneNumber.replace(/^\+254/, '')}` : '';

  return (
    <main className="min-h-screen bg-gradient-to-br from-green-50 to-emerald-100 pb-10">
      <header className="bg-white shadow-sm">
        <div className="max-w-xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <div><h1 className="text-lg font-bold text-gray-900">{S.brand}</h1><p className="text-xs text-gray-600">{S.tagline}</p></div>
          {!demo && <Btn tone="ghost" onClick={signOut}>{S.signOut}</Btn>}
        </div>
        <nav className="max-w-xl mx-auto px-2 flex" aria-label={S.brand}>
          {TABS.map((t) => (
            <button key={t} type="button" onClick={() => setTab(t)} aria-current={tab === t ? 'page' : undefined}
              className={`flex-1 min-h-11 px-2 py-2 text-sm font-semibold border-b-4 ${tab === t ? 'border-green-600 text-green-800' : 'border-transparent text-gray-600'}`}>{S.tabs[t]}</button>
          ))}
        </nav>
      </header>

      <div className="max-w-xl mx-auto px-4 mt-4 grid gap-4">
        {isMock() && <Alert kind="info">{S.mockBanner}</Alert>}
        {isMock() && <MockTools />}
        {err && <Card><Alert kind="err">{err}</Alert><div className="mt-3"><Btn tone="ghost" onClick={() => void load()}>{S.retry}</Btn></div></Card>}
        {!s && !err && <Card><Spinner label={S.loading} /></Card>}
        {s && tab === 'home' && <Dashboard s={s} onChanged={changed} />}
        {s && tab === 'pay' && <PayPanel s={s} defaultPhone={defaultPhone} onPaid={changed} />}
        {s && tab === 'money' && <MoneyPanel s={s} defaultPhone={defaultPhone} onChanged={changed} />}
        {s && tab === 'history' && <HistoryPanel reloadKey={tick} />}
        {s && tab === 'settings' && <SettingsPanel s={s} onChanged={changed} />}
        {s && <p className="text-center text-xs text-gray-600">{S.support(s.supportPhone)}</p>}
        {!demo && hasLegacy && <button type="button" onClick={() => navigate('/tenant')} className="text-sm text-gray-700 underline min-h-11">{S.switchToInvoice}</button>}
      </div>
    </main>
  );
}

/** Demo-only controls: pick a scenario or force the next call to fail with any error code. Only rendered with VITE_LMMX_MOCK=true. */
function MockTools() {
  const [sc, setSc] = useState(mockScenario());
  const codes = Object.keys(ERROR_TEXT) as Parameters<typeof setMockFail>[0][];
  return (
    <details className="rounded-lg border border-gray-300 bg-white p-3 text-sm">
      <summary className="font-semibold cursor-pointer">Demo tools</summary>
      <label className="block mt-2">Scenario
        <select className="mt-1 w-full border rounded p-2" value={sc} onChange={(e) => { const v = e.target.value as typeof sc; setSc(v); setMockScenario(v); location.reload(); }}>
          {SCENARIOS.map((x) => <option key={x}>{x}</option>)}
        </select>
      </label>
      <label className="block mt-2">Fail the next call with
        <select className="mt-1 w-full border rounded p-2" defaultValue="" onChange={(e) => setMockFail((e.target.value || null) as Parameters<typeof setMockFail>[0])}>
          <option value="">(none)</option>{codes.map((c) => <option key={c}>{c}</option>)}
        </select>
      </label>
    </details>
  );
}
