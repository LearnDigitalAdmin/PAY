// Home tab: rent, dates, progress, who the landlord is paid to, and the states that need attention (setup, frozen, a pending change).
import { channelLabel, kes, otpText, shortDate, cancelText, type TenantSummaryOut } from './contract';
import { lmmx } from './api';
import CodeBox from './CodeBox';
import { S } from './strings';
import { Alert, Card, Row, Title, when } from './ui';

interface Props { s: TenantSummaryOut; onChanged: () => void }

export default function Dashboard({ s, onChanged }: Props) {
  const c = s.cycle;
  const pc = s.pendingChange;
  const actionable = pc && (pc.status === 'awaiting_tenant_otp' || pc.status === 'cooling_off' || pc.status === 'deferred');

  return (
    <div className="grid gap-4">
      {s.frozen && (
        <Card><Alert kind="warn"><strong>{S.frozenTitle}</strong><br />{S.frozenBody(s.supportPhone)}</Alert></Card>
      )}

      {s.awaitingSetup && !s.frozen && (
        <Card>
          <Title>{S.awaitingTitle}</Title>
          <p className="mt-1 text-sm text-gray-700">{S.awaitingBody}</p>
          <p className="mt-2 text-sm text-gray-900">{s.awaitingSetup.summary}</p>
          <p className="mt-1 text-xs text-gray-500">{S.awaitingExpires(when(s.awaitingSetup.otpExpiresAt))}</p>
          <CodeBox title={S.codeSetupTitle} kind="otp" placeholder={S.codePlaceholder} button={S.codeConfirm}
            submit={async (code) => { await lmmx('lmmx_tenant_confirmSetup', { otp: otpText(code) }); return S.codeSetupDone; }} onDone={onChanged} />
        </Card>
      )}

      {!s.awaitingSetup && (
        <Card>
          <Title>{S.hello(s.firstName)}</Title>
          <dl className="mt-2 divide-y divide-gray-100">
            <Row label={S.rentLabel}>{kes(s.rentMinor)}</Row>
            {c ? (
              <>
                <Row label={S.balanceLabel}>{c.remainingMinor > 0 ? kes(c.remainingMinor) : S.paidAll}</Row>
                <Row label={S.dueLabel}>{shortDate(c.dueDate)}</Row>
                <Row label={S.payByLabel}>{shortDate(c.payByDate)}</Row>
              </>
            ) : <Row label={S.dueLabel}>{S.dueDayLine(s.dueDay)}</Row>}
            <Row label={S.frequencyLabel}>{S.frequencies[s.frequency]}</Row>
          </dl>
          {c ? (
            <div className="mt-3">
              <div className="h-3 w-full rounded-full bg-gray-200 overflow-hidden" role="progressbar" aria-label={S.progressAria} aria-valuenow={c.pct} aria-valuemin={0} aria-valuemax={100}>
                <div className="h-full bg-green-600 transition-all" style={{ width: `${c.pct}%` }} />
              </div>
              <p className="mt-1 text-xs text-gray-600">{S.progress(kes(c.creditedMinor), kes(c.rentMinor), c.pct)}</p>
              <p className="mt-2 text-xs text-gray-600">{S.payByHelp}</p>
            </div>
          ) : <p className="mt-3 text-sm text-gray-600">{S.noCycle}</p>}
        </Card>
      )}

      <Card>
        <Title>{S.recipientTitle}</Title>
        <dl className="mt-2 divide-y divide-gray-100">
          <Row label={channelLabel(s.recipient.channel)}>{s.recipient.accountNumber}</Row>
          <Row label={S.recipientNameLabel}>{s.recipient.resolvedNameMasked}</Row>
        </dl>
        {(s.recipient.status === 'needs_review' || s.recipient.nameMatch === 'mismatch') && <div className="mt-3"><Alert kind="info">{S.recipientReview}</Alert></div>}
      </Card>

      {pc && (
        <Card>
          <Title>{S.pendingTitle}</Title>
          <p className="mt-1 text-sm text-gray-900">{pc.summary}</p>
          <p className="mt-1 text-sm text-gray-700">{S.pendingStatus[pc.status] ?? pc.status}</p>
          {pc.coolingOffUntil && pc.status === 'cooling_off' && <p className="mt-1 text-xs text-gray-600">{S.pendingCooling(when(pc.coolingOffUntil))}</p>}
          {pc.applyAfter && (pc.status === 'cooling_off' || pc.status === 'deferred') && <p className="mt-1 text-xs text-gray-600">{S.pendingStarts(when(pc.applyAfter))}</p>}
          {pc.status === 'awaiting_tenant_otp' && (
            <CodeBox title={S.codeChangeTitle} kind="otp" placeholder={S.codePlaceholder} button={S.codeConfirm}
              submit={async (code) => { const r = await lmmx('lmmx_tenant_confirmChange', { changeId: pc.changeId, otp: otpText(code) }); return r.applyAfter ? `${S.codeChangeDone} ${S.codeChangeStarts(when(r.applyAfter))}` : S.codeChangeDone; }} onDone={onChanged} />
          )}
          {actionable && (
            <CodeBox title={S.codeCancelTitle} kind="cancel" placeholder={S.codeCancelPlaceholder} button={S.codeCancel} tone="danger"
              submit={async (code) => { await lmmx('lmmx_tenant_cancelChange', { changeId: pc.changeId, cancelCode: cancelText(code) }); return S.codeCancelDone; }} onDone={onChanged} />
          )}
        </Card>
      )}
    </div>
  );
}
