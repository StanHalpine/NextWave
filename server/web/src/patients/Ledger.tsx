import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { errorText, NotePill, Notice, useInterval } from '../ui';
import { credits as creditsLabel, fmtDay, fmtDayLong, fmtInstantTime, fmtMoney, fmtTime12 } from '../lib';
import { CheckoutDialog } from '../schedule/CheckoutDialog';
import { canCheckOut, LEDGER_REFRESH_MS, notesPendingNote, paidWithLabel, pendingNote, stateLabel, type LedgerVisit, type PatientLedger } from '../ledger';
import type { Appt } from '../types';

const STATE_PILL: Record<LedgerVisit['state'], string> = {
  ready_to_check_out: 'warn', checked_out: 'ok', not_arrived: 'off', no_show: 'bad',
};

/**
 * A patient's ledger: today's visits and what they come to, earlier visits with their amounts, credits, and dues as information.
 *
 * READ ONLY and the same wherever it is opened — the profile's Ledger tab, the Checked-in card's dialog — because it asks the server one
 * thing, "the ledger for this patient", and shows the answer. It re-reads every 10 seconds while open (and when the window regains focus),
 * so a check-out made on another desk screen appears here without a reload. Nothing here is charged or recorded by looking, and there is no
 * balance: payments are not tracked yet. The only action is to start the existing Check out flow, for any visit the patient is checked in
 * for — whether or not its note is signed (rev 2.0). Each visit shows its note status beside where it is.
 *
 * `onCheckout`: a parent that shows this inside a dialog takes over the check-out (so two dialogs never stack); without it the
 * check-out opens here.
 */
export function PatientLedger({ patientId, onCheckout, onChanged, onOpenCredits }: {
  patientId: string; onCheckout?: (appt: Appt) => void; onChanged?: () => void; onOpenCredits?: () => void;
}) {
  const [data, setData] = useState<PatientLedger | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checkout, setCheckout] = useState<Appt | null>(null);
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

  const start = (v: LedgerVisit) => (onCheckout ? onCheckout(v.appointment) : setCheckout(v.appointment));

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
        A view of {data.patient.name}’s visits and what they come to. <strong>Nothing is charged or recorded by looking.</strong> A visit is
        recorded when it is checked out, and payments are not tracked here yet.
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

      <h3>Credits</h3>
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

      {checkout && <CheckoutDialog appt={checkout} onClose={() => setCheckout(null)} onDone={() => { void load(); onChanged?.(); }} />}
    </div>
  );
}

function VisitTable({ visits, onCheckout, showDate, creditsInPlay }: { visits: LedgerVisit[]; onCheckout: (v: LedgerVisit) => void; showDate?: boolean; creditsInPlay: boolean }) {
  return (
    <table className="table ledger-table">
      <thead>
        <tr><th>{showDate ? 'When' : 'Time'}</th><th>Service</th><th>Where it is</th><th className="num">List</th><th className="num">Tier discount</th><th className="num">Credits</th><th className="num">Net</th><th /></tr>
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
                  <td className="num">{c.discountCents > 0 ? <>−{fmtMoney(c.discountCents)} <span className="muted">({c.discountPercent}%)</span></> : <span className="muted">—</span>}</td>
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
