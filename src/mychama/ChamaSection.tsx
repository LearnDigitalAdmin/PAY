// The MyChama section shown inside the landlord and tenant dashboards. It never reads rental data itself:
// the host screen passes in the rent figures it already has.
import React, { useEffect, useState } from 'react';
import { AlertTriangle, Loader2, RefreshCw, Users } from 'lucide-react';
import type { ChamaSnapshotChama } from './contract';
import type { RentPaymentLike } from './calc';
import ChamaCard from './ChamaCard';
import { chamaErrorMessage, timeAgo } from './format';
import MyChamaPayModal, { type PayTarget } from './MyChamaPayModal';
import PendingLinkCard from './PendingLinkCard';
import { LandlordSummary, TenantSummary } from './SummaryPanel';
import { useChamaConnector } from './connector';

export type ChamaSectionProps =
  | { role: 'landlord'; rentPayments: RentPaymentLike[] }
  | { role: 'tenant'; rentDue: number; billsDue: number };

const ChamaSection: React.FC<ChamaSectionProps> = (props) => {
  const { snapshot, snapshotLoaded, syncing, syncError, staleByTime, refresh } = useChamaConnector();
  const [paying, setPaying] = useState<{ chama: ChamaSnapshotChama; target: PayTarget } | null>(null);
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(''), 4000);
    return () => clearTimeout(t);
  }, [note]);

  const chamas = snapshot?.chamas ?? [];
  const pending = snapshot?.pending ?? [];
  const stale = snapshot?.status === 'stale' || staleByTime;
  const loading = !snapshotLoaded && syncing;

  const onRefresh = async () => {
    const res = await refresh();
    if (res?.throttled) setNote('Already up to date.');
  };

  return (
    <section className="mb-6 sm:mb-8" aria-label="MyChama">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Users className="w-5 h-5 text-indigo-700" />
          <h3 className="text-lg font-bold text-gray-900">MyChama</h3>
          {snapshot?.lastSyncedAt ? <span className="text-xs text-gray-500">Updated {timeAgo(snapshot.lastSyncedAt)}</span> : null}
        </div>
        <div className="flex items-center gap-2">
          {note && <span className="text-xs text-gray-500">{note}</span>}
          <button onClick={onRefresh} disabled={syncing} className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60">
            {syncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Refresh
          </button>
        </div>
      </div>

      {loading && (
        <div className="rounded-xl bg-white p-6 text-center text-sm text-gray-500 shadow">
          <Loader2 className="mx-auto mb-2 w-5 h-5 animate-spin" /> Loading your chamas…
        </div>
      )}

      {!loading && (syncError || stale || snapshot?.status === 'unavailable') && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-800">
          <AlertTriangle className="mt-0.5 w-4 h-4 shrink-0" />
          <span>
            {snapshot?.lastSyncedAt
              ? `MyChama could not be refreshed, so you are seeing data from ${timeAgo(snapshot.lastSyncedAt)}.`
              : syncError ? chamaErrorMessage(syncError) : 'MyChama is not reachable right now.'}{' '}
            Your rent and billing are not affected.
          </span>
        </div>
      )}

      {pending.length > 0 && <div className="mb-3 space-y-3">{pending.map((p) => <PendingLinkCard key={p.pendingId} pending={p} />)}</div>}

      {!loading && chamas.length === 0 && pending.length === 0 && (
        <div className="rounded-xl bg-white p-5 text-sm text-gray-600 shadow">
          {snapshot?.status === 'unavailable' || (!snapshot && syncError)
            ? 'We could not load your chama details yet. Please try Refresh in a moment.'
            : 'No MyChama groups are linked to your account. If you are a chama member, we link you automatically when your ID number and phone number match your MyChama record.'}
        </div>
      )}

      {chamas.length > 0 && (
        <div className="space-y-4">
          {props.role === 'landlord'
            ? <LandlordSummary rentPayments={props.rentPayments} chamas={chamas} />
            : <TenantSummary rentDue={props.rentDue} billsDue={props.billsDue} chamas={chamas} />}
          {chamas.map((c) => <ChamaCard key={c.chamaId} chama={c} onPay={(chama, target) => setPaying({ chama, target })} />)}
        </div>
      )}

      {paying && <MyChamaPayModal chama={paying.chama} target={paying.target} onClose={() => setPaying(null)} />}
    </section>
  );
};

export default ChamaSection;
