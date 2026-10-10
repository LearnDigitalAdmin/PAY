// One chama: what is owed (contributions, loans, MGR), MGR wins, and pay buttons. A section the server could
// not read (null) is shown as "unavailable" — never as zero.
import React from 'react';
import { AlertTriangle, Trophy } from 'lucide-react';
import type { ChamaSnapshotChama } from './contract';
import { formatDate, formatKES } from './format';
import type { PayTarget } from './MyChamaPayModal';

interface Props { chama: ChamaSnapshotChama; onPay: (chama: ChamaSnapshotChama, target: PayTarget) => void }

const Unavailable: React.FC = () => <p className="text-sm italic text-gray-500">Unavailable right now</p>;

const PayButton: React.FC<{ enabled: boolean; onClick: () => void }> = ({ enabled, onClick }) => (
  <button
    onClick={onClick} disabled={!enabled}
    title={enabled ? undefined : 'Online payments are not enabled for this chama'}
    className="rounded-md bg-indigo-600 px-3 py-1 text-xs font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-gray-300"
  >
    Pay
  </button>
);

const ChamaCard: React.FC<Props> = ({ chama, onPay }) => {
  const on = chama.onlineCollectionEnabled;
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 sm:p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-base font-bold text-gray-900">{chama.chamaName || 'Chama'}</h4>
        {chama.totals ? (
          <p className="text-xs text-gray-600">
            Overdue <span className="font-semibold text-red-700">{formatKES(chama.totals.overdue)}</span> · Due this month{' '}
            <span className="font-semibold text-gray-900">{formatKES(chama.totals.dueThisMonth)}</span>
          </p>
        ) : <p className="text-xs italic text-gray-500">Totals unavailable</p>}
      </div>

      {chama.dataStatus !== 'ok' && (
        <div className="mb-3 flex items-start gap-2 rounded-lg bg-yellow-50 p-2 text-xs text-yellow-800">
          <AlertTriangle className="mt-0.5 w-4 h-4 shrink-0" />
          {chama.dataStatus === 'unavailable' ? 'This chama could not be reached on the last refresh.' : 'Some details could not be loaded on the last refresh.'}
        </div>
      )}
      {!on && <p className="mb-3 text-xs text-gray-500">Online payments are not enabled for this chama.</p>}

      <div className="space-y-4">
        <section>
          <h5 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">Contributions</h5>
          {chama.contributions === null ? <Unavailable /> : chama.contributions.items.length === 0 ? <p className="text-sm text-gray-600">Nothing due.</p> : (
            <ul className="divide-y divide-gray-100">
              {chama.contributions.items.map((c) => (
                <li key={c.contributionId} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span className="text-gray-800">{c.periodKey} <span className="text-xs text-gray-500">due {formatDate(c.dueDate)}</span></span>
                  <span className="flex items-center gap-3">
                    <span className="font-semibold">{formatKES(c.outstanding)}</span>
                    <PayButton enabled={on} onClick={() => onPay(chama, { purpose: 'contribution', label: `Contribution ${c.periodKey}`, amount: c.outstanding, contributionId: c.contributionId })} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h5 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">Loans</h5>
          {chama.loans === null ? <Unavailable /> : chama.loans.items.length === 0 ? <p className="text-sm text-gray-600">No active loans.</p> : (
            <ul className="divide-y divide-gray-100">
              {chama.loans.items.map((l) => (
                <li key={l.loanId} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span className="text-gray-800">
                    Balance {formatKES(l.outstanding)}
                    {l.nextInstallment && <span className="block text-xs text-gray-500">Next: {formatKES(l.nextInstallment.due)} on {formatDate(l.nextInstallment.dueDate)}</span>}
                  </span>
                  {l.nextInstallment && (
                    <PayButton enabled={on} onClick={() => onPay(chama, { purpose: 'loan_repayment', label: `Loan instalment ${l.nextInstallment!.installmentNo}`, amount: l.nextInstallment!.due, loanId: l.loanId, installmentNo: l.nextInstallment!.installmentNo })} />
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h5 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">MGR (merry-go-round)</h5>
          {chama.mgr === null ? <Unavailable /> : chama.mgr.pots.length === 0 ? <p className="text-sm text-gray-600">Not in any MGR.</p> : (
            <div className="space-y-3">
              {chama.mgr.pots.map((pot) => (
                <div key={pot.potId} className="rounded-lg bg-gray-50 p-3 text-sm">
                  <p className="font-semibold text-gray-900">{pot.name}</p>
                  <div className="mt-1 flex items-center justify-between gap-3">
                    <span className="text-gray-700">{pot.currentPeriodPaid ? 'This period: paid' : `This period due: ${formatKES(pot.dueNow)}`}</span>
                    {!pot.currentPeriodPaid && pot.dueNow > 0 && (
                      <PayButton enabled={on} onClick={() => onPay(chama, { purpose: 'mgr_contribution', label: `MGR ${pot.name}`, amount: pot.dueNow, potId: pot.potId, potPeriod: pot.period })} />
                    )}
                  </div>
                  {pot.arrearsOpen > 0 && pot.arrearId && (
                    <div className="mt-1 flex items-center justify-between gap-3">
                      <span className="text-red-700">Arrears: {formatKES(pot.arrearsOpen)}</span>
                      <PayButton enabled={on} onClick={() => onPay(chama, { purpose: 'mgr_contribution', label: `MGR arrears ${pot.name}`, amount: pot.arrearsOpen, potId: pot.potId, potPeriod: pot.period, arrearId: pot.arrearId! })} />
                    </div>
                  )}
                  {pot.wins.map((w, i) => (
                    <p key={i} className="mt-2 flex items-center gap-1.5 text-xs text-green-800">
                      <Trophy className="w-3.5 h-3.5" />
                      {w.kind === 'won'
                        ? `Won round ${w.round}${w.amount !== null ? ` — ${formatKES(w.amount)}` : ''}${w.expectedDate ? ` on ${formatDate(w.expectedDate)}` : ''}`
                        : `Scheduled to win (queue position ${w.queuePosition ?? '—'})${w.amount !== null ? ` — about ${formatKES(w.amount)}` : ''}`}
                    </p>
                  ))}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
};

export default ChamaCard;
