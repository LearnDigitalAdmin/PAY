import { useCallback, useEffect, useState } from 'react';
import { kes, type InstalmentView } from './contract';
import { errorMessage, lmmx } from './api';
import { ERROR_FALLBACK, ERROR_TEXT, S } from './strings';
import { Alert, Btn, Card, Spinner, Title, when } from './ui';

export default function HistoryPanel({ reloadKey }: { reloadKey: number }) {
  const [items, setItems] = useState<InstalmentView[] | null>(null);
  const [next, setNext] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async (cursor?: string) => {
    setBusy(true); setErr('');
    try {
      const r = await lmmx('lmmx_tenant_history', cursor ? { cursor } : {});
      setItems((prev) => (cursor && prev ? [...prev, ...r.items] : r.items));
      setNext(r.nextCursor);
    } catch (e) { setErr(errorMessage(e, ERROR_TEXT, ERROR_FALLBACK)); } finally { setBusy(false); }
  }, []);
  useEffect(() => { void load(); }, [load, reloadKey]);

  return (
    <Card>
      <Title>{S.historyTitle}</Title>
      {err && <div className="mt-3"><Alert kind="err">{err}</Alert></div>}
      {!items && !err && <Spinner label={S.loading} />}
      {items && items.length === 0 && <p className="mt-3 text-sm text-gray-600">{S.historyEmpty}</p>}
      {items && items.length > 0 && (
        <ul className="mt-2 divide-y divide-gray-100">
          {items.map((i) => (
            <li key={i.paymentId} className="py-3 flex justify-between gap-3">
              <div>
                <p className="font-semibold text-gray-900">{S.historyCredit(kes(i.creditMinor))}</p>
                <p className="text-xs text-gray-600">{when(i.at)} · {S.historyFees(kes(i.feesMinor))} · {S.historyPaid(kes(i.chargeMinor))}</p>
              </div>
              <span className={`self-start text-xs font-semibold rounded-full px-2 py-1 ${i.status === 'success' ? 'bg-green-100 text-green-800' : i.status === 'failed' ? 'bg-red-100 text-red-800' : 'bg-gray-100 text-gray-700'}`}>{S.historyStatus[i.status] ?? i.status}</span>
            </li>
          ))}
        </ul>
      )}
      {next && <div className="mt-3"><Btn tone="ghost" onClick={() => void load(next)} disabled={busy}>{busy ? S.loading : S.historyMore}</Btn></div>}
    </Card>
  );
}
