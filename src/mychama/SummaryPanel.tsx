// The numbers: landlord = rent collected over a period minus MyChama deductions; tenant = what is needed this
// month across rent, bills and chama. All maths lives in calc.ts (pure); rent figures are PASSED IN.
import React, { useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { ChamaSnapshotChama } from './contract';
import {
  isoDateEat, landlordPeriodSummary, lastDaysRange, monthRange, previousMonthRange, sumRentCollected,
  tenantMonthSummary, type RentPaymentLike,
} from './calc';
import { formatDate, formatKES } from './format';

const Row: React.FC<{ label: string; value: string; strong?: boolean; tone?: 'neg' | 'pos' }> = ({ label, value, strong, tone }) => (
  <div className="flex items-center justify-between py-1 text-sm">
    <span className={strong ? 'font-semibold text-gray-900' : 'text-gray-600'}>{label}</span>
    <span className={`${strong ? 'font-bold' : 'font-medium'} ${tone === 'neg' ? 'text-red-700' : tone === 'pos' ? 'text-green-700' : 'text-gray-900'}`}>{value}</span>
  </div>
);

const Incomplete: React.FC<{ names: string[] }> = ({ names }) => (
  <div className="mt-3 flex items-start gap-2 rounded-lg bg-yellow-50 p-2 text-xs text-yellow-800">
    <AlertTriangle className="mt-0.5 w-4 h-4 shrink-0" />
    <span>Some MyChama details were unavailable{names.length ? ` (${names.join(', ')})` : ''}, so these figures may be incomplete.</span>
  </div>
);

type Preset = 'this' | 'last' | '90';

export const LandlordSummary: React.FC<{ rentPayments: RentPaymentLike[]; chamas: ChamaSnapshotChama[] }> = ({ rentPayments, chamas }) => {
  const [preset, setPreset] = useState<Preset>('this');
  const today = isoDateEat(new Date());
  const s = useMemo(() => {
    const period = preset === 'this' ? monthRange(today) : preset === 'last' ? previousMonthRange(today) : lastDaysRange(today, 90);
    return landlordPeriodSummary({ rentCollected: sumRentCollected(rentPayments, period), period }, chamas);
  }, [preset, today, rentPayments, chamas]);

  return (
    <div className="rounded-xl border border-indigo-200 bg-white p-4 sm:p-5">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-base font-bold text-gray-900">Rent vs MyChama</h4>
        <select value={preset} onChange={(e) => setPreset(e.target.value as Preset)} className="rounded-lg border border-gray-300 px-2 py-1 text-sm">
          <option value="this">This month</option>
          <option value="last">Last month</option>
          <option value="90">Last 90 days</option>
        </select>
      </div>
      <p className="mb-2 text-xs text-gray-500">{formatDate(s.period.from)} – {formatDate(s.period.to)}</p>
      <Row label="Rent collected" value={formatKES(s.rentCollected)} />
      <Row label="Contributions" value={`− ${formatKES(s.totals.contributions)}`} />
      <Row label="Loan repayments" value={`− ${formatKES(s.totals.loans)}`} />
      <Row label="MGR contributions" value={`− ${formatKES(s.totals.mgr)}`} />
      {s.winsReceived > 0 && <Row label="MGR won in this period" value={`+ ${formatKES(s.winsReceived)}`} tone="pos" />}
      <div className="mt-1 border-t border-gray-200 pt-1">
        <Row label="After MyChama" value={formatKES(s.net)} strong tone={s.net < 0 ? 'neg' : undefined} />
      </div>
      {s.scheduledWins.length > 0 && (
        <p className="mt-2 text-xs text-green-800">
          Upcoming MGR: {s.scheduledWins.map((w) => `${w.potName} (position ${w.queuePosition ?? '—'}${w.amount !== null ? `, about ${formatKES(w.amount)}` : ''})`).join('; ')}
        </p>
      )}
      <p className="mt-2 text-xs text-gray-500">Shown for your information — your rent collections are not changed. Loans count the next instalment only.</p>
      {s.incomplete && <Incomplete names={s.unavailableChamas} />}
    </div>
  );
};

export const TenantSummary: React.FC<{ rentDue: number; billsDue: number; chamas: ChamaSnapshotChama[] }> = ({ rentDue, billsDue, chamas }) => {
  const s = useMemo(() => tenantMonthSummary({ rentDue, billsDue }, chamas), [rentDue, billsDue, chamas]);
  return (
    <div className="rounded-xl border border-indigo-200 bg-white p-4 sm:p-5">
      <h4 className="mb-2 text-base font-bold text-gray-900">What you need this month</h4>
      <Row label="Rent" value={formatKES(s.rentDue)} />
      <Row label="Bills (water, power, other)" value={formatKES(s.billsDue)} />
      {s.perChama.map((c) => (
        <Row key={c.chamaId} label={`${c.chamaName || 'Chama'}`} value={c.available ? formatKES(c.overdue + c.dueThisMonth) : 'Unavailable'} />
      ))}
      <div className="mt-1 border-t border-gray-200 pt-1">
        <Row label="Total needed" value={formatKES(s.totalNeed)} strong />
        {s.expectedWinsThisMonth > 0 && <Row label="Expected MGR payout this month" value={`− ${formatKES(s.expectedWinsThisMonth)}`} tone="pos" />}
        {s.expectedWinsThisMonth > 0 && <Row label="You still need" value={formatKES(s.netNeed)} strong />}
      </div>
      {s.scheduledWins.length > 0 && (
        <p className="mt-2 text-xs text-green-800">
          Upcoming MGR: {s.scheduledWins.map((w) => `${w.potName} (position ${w.queuePosition ?? '—'}${w.amount !== null ? `, about ${formatKES(w.amount)}` : ''})`).join('; ')}
        </p>
      )}
      {s.incomplete && <Incomplete names={chamas.filter((c) => c.dataStatus !== 'ok').map((c) => c.chamaName)} />}
    </div>
  );
};
