import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { fmtDay, fmtTime12 } from '../lib';
import { errorText, Notice, ServiceDot, useInterval } from '../ui';
import { visitLabel, waitedFor, worklistSummary, type UnsignedNotes as Worklist } from '../notes';
import { roleName } from '../provider/docs';

/**
 * The provider's Unsigned notes worklist (rev 2.0): every visit booked with them whose note is required and not yet signed — checked out
 * or not, from any day — oldest first, each one click from its note. Check-out never waits for a note, so this is where the notes written
 * on a break or at the end of the day are found. A note pending longer than the clinic's threshold (24 hours unless changed) is marked.
 *
 * An administrator chooses whose list to read (`?staffId=`), and reads only: the workspace it opens is read-only for them.
 */
export default function UnsignedNotes() {
  const [params, setParams] = useSearchParams();
  const staffId = params.get('staffId') ?? '';
  const [data, setData] = useState<Worklist | null>(null);
  const [error, setError] = useState<{ text: string; code?: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<Worklist>(`/api/provider/unsigned-notes${staffId ? `?staffId=${encodeURIComponent(staffId)}` : ''}`));
      setError(null);
    } catch (e) {
      setError({ text: errorText(e), code: e instanceof ApiError ? e.code : undefined });
    }
  }, [staffId]);
  useEffect(() => { void load(); }, [load]);
  useInterval(() => { void load(); }, 30_000);

  const choose = (id: string) => setParams(id ? { staffId: id } : {});

  if (error && !data) {
    const mfa = error.code?.startsWith('mfa_');
    return (
      <>
        <p className="crumb"><Link to="/provider">← Provider queue</Link></p>
        <h1>Unsigned notes</h1>
        <Notice kind="error">{error.text}</Notice>
        {mfa && <p><Link className="btn primary" to="/mfa/enroll">Set up your authenticator</Link></p>}
      </>
    );
  }
  if (!data) return <p className="muted">Loading…</p>;

  const p = data.provider;
  return (
    <>
      <p className="crumb"><Link to="/provider">← Provider queue</Link></p>
      <div className="page-head">
        <div>
          <h1>Unsigned notes{p && !p.own ? ` — ${p.name}` : ''}</h1>
          {p && <p className="lede">{worklistSummary(data.rows.length, data.overdue, data.thresholdHours)}</p>}
        </div>
        {data.providers && (
          <div className="head-actions">
            <label className="worklist-pick">Provider{' '}
              <select value={p?.id ?? ''} onChange={(e) => choose(e.target.value)}>
                <option value="">— choose —</option>
                {data.providers.map((x) => <option key={x.id} value={x.id}>{x.name} · {roleName(x.role)}{x.active ? '' : ' (inactive)'}</option>)}
              </select>
            </label>
          </div>
        )}
      </div>

      {error && <Notice kind="warn">Could not refresh just now ({error.text}). Showing what was last loaded.</Notice>}
      {data.reason && <Notice>{data.reason}</Notice>}
      {p && !p.own && <Notice kind="warn">You are reading {p.name}’s list. Only they can write and sign these notes.</Notice>}

      {p && (data.rows.length === 0 ? <p className="empty">No unsigned notes. Every visit that needs a note has one.</p> : (
        <div className="table-scroll">
          <table className="table worklist">
            <thead>
              <tr><th>Date</th><th>Patient</th><th>Service</th><th>Visit</th><th>Waiting</th><th /></tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.bookingId} className={r.overdue ? 'overdue' : undefined}>
                  <td className="nowrap">{fmtDay(r.localDate)} · {fmtTime12(r.localStart)}</td>
                  <td><strong>{r.patient.name}</strong></td>
                  <td><ServiceDot color={r.service.color} /> {r.service.name}{r.subOption ? ` · ${r.subOption}` : ''}
                    <div className="muted small">{r.service.documentationType === 'SOAP' ? 'SOAP note' : 'Session log'}{r.documentation.status === 'DRAFT' ? ' · draft started' : ''}</div></td>
                  <td>{visitLabel(r.visit.status)}</td>
                  <td className="nowrap">
                    {r.overdue
                      ? <span className="pill bad" title={`Pending more than ${data.thresholdHours} hours since check-in`}>Overdue · {waitedFor(r.hoursPending)}</span>
                      : <span className="muted">{waitedFor(r.hoursPending)}</span>}
                  </td>
                  <td className="actions">
                    <Link className={`btn small${p.own ? ' primary' : ''}`} to={`/provider/visits/${r.bookingId}`}>
                      {p.own ? (r.documentation.status === 'DRAFT' ? 'Continue' : 'Open note') : 'View'}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {data.more && <p className="hint">Showing the oldest {data.rows.length}; there are more.</p>}
      <p className="hint">
        Every visit booked with {p?.own ? 'you' : 'this provider'} whose service needs a note and has none signed, oldest first, whether the patient
        has been checked out or not. Check-out does not wait for notes. A note signed after check-out is recorded as such. “Overdue” means pending
        more than {data.thresholdHours} hours since check-in. Services that need no note (red light, hyperbaric and similar) are never listed.
      </p>
    </>
  );
}
