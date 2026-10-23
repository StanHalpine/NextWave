import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { errorText, NotePill, Notice, useInterval } from '../ui';
import { credits as creditsLabel, fmtDay, fmtDayLong, fmtInstantTime, fmtMoney, fmtTime12 } from '../lib';
import { CheckoutBatchDialog } from './CheckoutBatchDialog';
import { RefundAccountCreditDialog, ReversePaymentDialog } from './MoneyDialogs';
import { ACCOUNT_CREDIT_LABEL, canReverse, MEMBERSHIP_CREDITS_LABEL, postedLabel, reasonLabel, type PostedEntry } from '../money';
import { canCheckOut, LEDGER_REFRESH_MS, notesPendingNote, paidWithLabel, pendingNote, stateLabel, type LedgerVisit, type PatientLedger } from '../ledger';

const STATE_PILL: Record<LedgerVisit['state'], string> = {
  ready_to_check_out: 'warn', checked_out: 'ok', not_arrived: 'off', no_show: 'bad',
};

/**
 * A patient's ledger: today's visits and what they come to, earlier visits, what has been POSTED (charges, payments, reversals, account
 * credit applied) with a running balance whose last line is the balance carried forward, account credit ($), membership credits, and
 * dues as information.
 *
 * The same wherever it is opened — the profile's Ledger tab, the Checked-in card's dialog — because it asks the server one thing, "the
 * ledger for this patient". It re-reads every 10 seconds while open (and when the window regains focus), so a payment taken on another
 * desk screen appears here without a reload. Looking charges nothing. The actions — check out, take a payment, reverse a payment, an
 * admin's refund of account credit — each open their own dialog, and each is checked by the server against the Ledger it was opened on.
 *
 * `onDialog`: a parent that shows this inside a dialog takes over the dialogs it opens (so two dialogs never stack); without it they
 * open here.
 */
export function PatientLedger({ patientId, onDialog, onChanged, onOpenCredits }: {
  patientId: string; onDialog?: (dialog: ReactNode | null) => void; onChanged?: () => void; onOpenCredits?: () => void;
}) {
  const { hasRole } = useAuth();
  const isAdmin = hasRole('ADMIN');
  const [data, setData] = useState<PatientLedger | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<ReactNode | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const r = await api<PatientLedger>(`/api/fd/patients/${patientId}/ledger`);
      if (mine === seq.current) { setData(r); setError(null); }       // a slower, older answer never replaces a newer one
    } catch (e) { if (mine === seq.current) setError(errorText(e)); }
  }, [patientId]);

  useEffect(() => { setData(null); void load(); }, [load]);
  useInterval(() => { void load(); }, LEDGER_REFRESH_MS);
  useEffect(() => {
    const again = () => { if (document.visibilityState === 'visible') void load(); };
    window.addEventListener('focus', again); document.addEventListener('visibilitychange', again);
    return () => { window.removeEventListener('focus', again); document.removeEventListener('visibilitychange', again); };
  }, [load]);

  const show = (d: ReactNode | null) => (onDialog ? onDialog(d) : setDialog(d));
  const close = () => show(null);
  const changed = () => { void load(); onChanged?.(); };
  const checkOut = (preselect: string[]) => show(<CheckoutBatchDialog patientId={patientId} preselect={preselect} onClose={close} onDone={changed} />);
  const start = (v: LedgerVisit) => checkOut([v.id]);

  if (!data) return error ? <Notice kind="error">{error}</Notice> : <p className="muted">Loading…</p>;
  const t = data.todayTotals;
  // A patient with no membership and no credits is not told a visit "needs 2 credits": credits are not something they pay with.
  const creditsInPlay = !!data.credits.membership || data.credits.balance > 0;
  const note = pendingNote(t.pending);
  const notes = notesPendingNote(t.notesPending);

  return (
    <div className="stack ledger">
      {error && <Notice kind="warn">Could not refresh just now ({error}). Showing what was last loaded; it will try again.</Notice>}
      <p className="hint">
        {data.patient.name}’s visits, what they come to, and what has been paid. <strong>Nothing is charged or recorded by looking.</strong> A
        visit is charged when it is checked out; a payment is recorded when the front desk takes it.
        <span className="muted"> · Updated {fmtInstantTime(data.asOf, data.timezone)}, refreshes every 10 seconds</span>
      </p>

      <h3>Today · {fmtDayLong(data.today)}</h3>
      {data.todayVisits.length === 0 ? <p className="muted">No visits today.</p> : (
        <>
          <VisitTable visits={data.todayVisits} onCheckout={start} creditsInPlay={creditsInPlay} />
          {t.recorded.visits > 0 && (
            <p><strong>Recorded at check-out today:</strong> {fmtMoney(t.recorded.netCents)} in money
              {t.recorded.creditsApplied > 0 && <> and {creditsLabel(t.recorded.creditsApplied)}</>}
              {t.recorded.discountCents > 0 && <> (tier discount {fmtMoney(t.recorded.discountCents)} included)</>}
              <span className="muted"> · {t.recorded.visits} {t.recorded.visits === 1 ? 'visit' : 'visits'}</span></p>
          )}
          {note && (
            <p><strong>Still to check out today:</strong> {fmtMoney(t.pending.cashNetCents)} if paid at the desk
              <span className="muted"> · {t.pending.visits} {t.pending.visits === 1 ? 'visit' : 'visits'}
                {t.pending.readyToCheckOut > 0 && ` · ${t.pending.readyToCheckOut} ready`}
                {t.pending.notArrived > 0 && ` · ${t.pending.notArrived} not arrived`}</span>
              <br /><span className="hint">{note}</span></p>
          )}
          {notes && <p className="hint">{notes}</p>}
        </>
      )}

      <h3>Earlier visits</h3>
      {data.priorVisits.length === 0 ? <p className="muted">No earlier visits.</p> : <VisitTable visits={data.priorVisits} onCheckout={start} creditsInPlay={creditsInPlay} showDate />}
      {data.priorVisitsMore && <p className="hint">Showing the latest {data.priorVisits.length}.</p>}

      <MoneySection data={data} isAdmin={isAdmin}
        onCheckOut={() => checkOut(data.todayVisits.filter((v) => v.state === 'ready_to_check_out').map((v) => v.id))}
        onPay={() => show(<CheckoutBatchDialog patientId={patientId} mode="payment" onClose={close} onDone={changed} />)}
        onReverse={(e) => show(<ReversePaymentDialog patientId={patientId} payment={e} version={data.money.version} onClose={close} onDone={changed} />)}
        onRefund={() => show(<RefundAccountCreditDialog patientId={patientId} ledger={data} onClose={close} onDone={changed} />)} />

      <h3>{MEMBERSHIP_CREDITS_LABEL}</h3>
      <p>
        {data.credits.membership ? <>{data.credits.membership.planName} membership ({data.credits.membership.status.toLowerCase()}) · </> : 'No membership · '}
        <strong>{creditsLabel(data.credits.balance)}</strong> available
        {data.credits.expiringSoon && <span className="muted"> · {creditsLabel(data.credits.expiringSoon.credits)} expire by {fmtDay(data.credits.expiringSoon.on)}</span>}
        <span className="muted"> · {creditsLabel(data.credits.redeemedToDate)} used to date</span>
        {onOpenCredits && <> · <button className="linklike" onClick={onOpenCredits}>Credit tracker</button></>}
      </p>

      {data.dues.length > 0 && (
        <>
          <h3>Membership dues</h3>
          <p className="hint">For information. Dues are billed with each month’s credits and collected outside this app, so they are not part of any total above.</p>
          <table className="table">
            <thead><tr><th>Month</th><th>Billed</th><th /></tr></thead>
            <tbody>
              {data.dues.map((d) => (
                <tr key={d.id}><td>{d.periodStart ? fmtDay(d.periodStart) : '—'}</td><td className="num">{fmtMoney(d.listPriceCents)}</td><td className="muted">{d.description}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {!onDialog && dialog}
    </div>
  );
}

/**
 * The money: the posted list with its running balance — charges, payments on the day they were collected, reversals on theirs, account
 * credit applied — and, as its last line, the balance carried forward. Account credit ($) beneath, apart from it.
 */
function MoneySection({ data, isAdmin, onCheckOut, onPay, onReverse, onRefund }: {
  data: PatientLedger; isAdmin: boolean; onCheckOut: () => void; onPay: () => void;
  onReverse: (e: { id: string; tender: string; totalCents: number; date: string }) => void; onRefund: () => void;
}) {
  const m = data.money;
  const waiting = data.todayVisits.some((v) => v.state === 'ready_to_check_out');
  return (
    <>
      <h3>Charges and payments</h3>
      {m.posted.length === 0 ? <p className="muted">Nothing has been charged yet.</p> : (
        <table className="table ledger-table posted">
          <thead><tr><th>Date</th><th>Entry</th><th className="num">Charge</th><th className="num">Paid</th><th className="num">Balance</th><th /></tr></thead>
          <tbody>
            {m.posted.map((e) => (
              <tr key={`${e.kind}:${e.id}`} className={e.kind === 'payment' && e.reversed ? 'reversed' : ''}>
                <td>{fmtDay(e.date)}</td>
                <td>{postedLabel(e)}<PostedDetail e={e} /></td>
                <td className="num">{e.amountCents > 0 ? fmtMoney(e.amountCents) : ''}</td>
                <td className="num">{e.amountCents < 0 ? `−${fmtMoney(-e.amountCents)}` : e.kind === 'payment' ? fmtMoney(0) : ''}</td>
                <td className="num">{fmtMoney(e.balanceAfterCents)}</td>
                <td>{e.kind === 'payment' && canReverse(e, isAdmin) && <button className="btn small ghost" onClick={() => onReverse({ id: e.id, tender: e.tender, totalCents: e.totalCents, date: e.date })}>Reverse…</button>}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="carried"><td colSpan={4}><strong>Balance carried forward</strong></td>
              <td className="num"><strong>{fmtMoney(m.balanceCents)}</strong></td><td className="muted small">{m.balanceCents > 0 ? 'owed by the patient' : 'nothing owed'}</td></tr>
          </tfoot>
        </table>
      )}
      <div className="sheet-actions">
        {waiting && <button className="btn primary" onClick={onCheckOut}>Check out today’s visits…</button>}
        <button className="btn" onClick={onPay}>Take a payment…</button>
        {isAdmin && m.accountCreditCents > 0 && <button className="btn ghost" onClick={onRefund}>Refund account credit…</button>}
      </div>
      <p>
        <strong>{ACCOUNT_CREDIT_LABEL}:</strong> {fmtMoney(m.accountCreditCents)}
        <span className="muted"> — money held for the patient from an overpayment; applied at check-out when the desk chooses. Not membership credits.</span>
      </p>
      {m.accountCredit.length > 0 && (
        <details className="note-history"><summary>{ACCOUNT_CREDIT_LABEL} history</summary>
          <ul className="plain">{m.accountCredit.map((c) => (
            <li key={c.id}>{fmtDay(c.date)} · {c.kind === 'OVERPAYMENT' ? 'kept from an overpayment' : c.kind === 'APPLIED' ? 'applied to a visit' : c.kind === 'REFUNDED' ? `refunded${c.refundTender ? ` (${c.refundTender.toLowerCase()})` : ''}` : 'taken back — its payment was reversed'}
              {' '}{c.deltaCents > 0 ? '+' : '−'}{fmtMoney(Math.abs(c.deltaCents))} → {fmtMoney(c.balanceAfterCents)}</li>
          ))}</ul>
        </details>
      )}
    </>
  );
}

function PostedDetail({ e }: { e: PostedEntry }) {
  if (e.kind === 'charge') {
    const parts = [
      e.listPriceCents != null && (e.discountCents || e.promotionCents || e.adjustmentCents) ? `list ${fmtMoney(e.listPriceCents)}` : '',
      e.discountCents ? `tier −${fmtMoney(e.discountCents)}` : '',
      e.promotionCents ? `${e.promotionName ?? 'promotion'} −${fmtMoney(e.promotionCents)}` : '',
      e.adjustmentCents ? `adjustment (${reasonLabel(e.adjustmentReason).toLowerCase()}) −${fmtMoney(e.adjustmentCents)}` : '',
    ].filter(Boolean);
    return parts.length ? <div className="muted small">{parts.join(' · ')}</div> : null;
  }
  if (e.kind === 'payment' && (e.toAccountCreditCents || e.refundedCents || e.totalCents !== -e.amountCents)) {
    return <div className="muted small">{fmtMoney(e.totalCents)} received{e.toAccountCreditCents ? ` · ${fmtMoney(e.toAccountCreditCents)} kept as account credit` : ''}{e.refundedCents ? ` · ${fmtMoney(e.refundedCents)} refunded` : ''}</div>;
  }
  return null;
}

function VisitTable({ visits, onCheckout, showDate, creditsInPlay }: { visits: LedgerVisit[]; onCheckout: (v: LedgerVisit) => void; showDate?: boolean; creditsInPlay: boolean }) {
  return (
    <table className="table ledger-table">
      <thead>
        <tr><th>{showDate ? 'When' : 'Time'}</th><th>Service</th><th>Where it is</th><th className="num">List</th><th className="num">Off</th><th className="num">Credits</th><th className="num">Net</th><th /></tr>
      </thead>
      <tbody>
        {visits.map((v) => {
          const c = v.charge;
          const projected = c.basis === 'projected';
          return (
            <tr key={v.id}>
              <td>{showDate ? <>{fmtDay(v.localDate)}<br /></> : null}{fmtTime12(v.localStart)}</td>
              <td>{v.service}{v.subOption ? <span className="muted"> · {v.subOption}</span> : null}{v.provider && <div className="muted small">{v.provider}</div>}</td>
              <td><span className={`pill ${STATE_PILL[v.state]}`}>{stateLabel(v)}</span>
                {v.note && <div className="ledger-note"><NotePill note={v.note} doc={v.appointment.documentation.status} /></div>}</td>
              {c.basis === 'none' ? (
                <td className="num muted" colSpan={4}>{v.state === 'ready_to_check_out' ? 'Not checked out — no amount recorded' : v.state === 'no_show' ? 'No charge' : 'No amount recorded'}</td>
              ) : (
                <>
                  <td className="num">{c.priceKnown ? fmtMoney(c.listPriceCents) : <span className="muted">set at check-out</span>}</td>
                  <td className="num">
                    {c.discountCents > 0 && <div>−{fmtMoney(c.discountCents)} <span className="muted small">tier {c.discountPercent}%</span></div>}
                    {c.promotionCents > 0 && <div>−{fmtMoney(c.promotionCents)} <span className="muted small">{c.promotionName ?? 'promotion'}</span></div>}
                    {c.adjustmentCents > 0 && <div>−{fmtMoney(c.adjustmentCents)} <span className="muted small">adjustment</span></div>}
                    {!c.discountCents && !c.promotionCents && !c.adjustmentCents && <span className="muted">—</span>}
                  </td>
                  <td className="num">
                    {c.creditsApplied ? creditsLabel(c.creditsApplied) : <span className="muted">—</span>}
                    {projected && creditsInPlay && c.creditCost != null && <div className="muted small">{c.creditsAvailable ? `or ${creditsLabel(c.creditCost)}` : `${creditsLabel(c.creditCost)} (not enough)`}</div>}
                  </td>
                  <td className="num">
                    {c.netCents != null ? (projected ? <span title="If paid at the desk — not recorded until check-out">{fmtMoney(c.netCents)}<div className="muted small">if paid at the desk</div></span> : <>{fmtMoney(c.netCents)}{c.paidWith && <div className="muted small">{paidWithLabel(c.paidWith)}</div>}</>) : <span className="muted">—</span>}
                  </td>
                </>
              )}
              <td>{canCheckOut(v) && <button className="btn small primary" onClick={() => onCheckout(v)}>Check out…</button>}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
