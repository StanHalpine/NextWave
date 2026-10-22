import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useClinicTz } from '../clinic';
import { fmtDay, fmtInstantTime, fmtTime12 } from '../lib';
import { errorText, Notice, ServiceDot, useInterval } from '../ui';
import { ROLE_NAME, STATUS_LABEL, STATUS_PILL } from '../provider/docs';
import { unsignedLinkLabel } from '../notes';
import type { ProviderQueue, ProviderRole, QueueRow } from '../types';

const ENCOUNTER_LABEL: Record<string, string> = { CHECKED_IN: 'Waiting', IN_PROGRESS: 'With provider', SEEN: 'Seen', CHECKED_OUT: 'Checked out' };

/**
 * Provider module: the patients who have been checked in for the signed-in provider's role, with what is
 * still to be documented for each. A person who holds more than one role — or an administrator — can
 * switch between roles; a role that is not theirs is shown read-only.
 */
export default function Provider() {
  const tz = useClinicTz();
  const [role, setRole] = useState<ProviderRole | null>(null);
  const [queue, setQueue] = useState<ProviderQueue | null>(null);
  const [error, setError] = useState<{ text: string; code?: string } | null>(null);
  const [onlyMine, setOnlyMine] = useState(false);

  const load = useCallback(async () => {
    try {
      const q = await api<ProviderQueue>(`/api/provider/queue${role ? `?role=${role}` : ''}`);
      setQueue(q);
      setError(null);
    } catch (e) {
      setError({ text: errorText(e), code: e instanceof ApiError ? e.code : undefined });
    }
  }, [role]);
  useEffect(() => { void load(); }, [load]);
  useInterval(() => { void load(); }, 30_000);          // a patient checked in at the desk appears without a click

  if (error) {
    const mfa = error.code?.startsWith('mfa_');
    return (
      <>
        <h1>Provider</h1>
        <Notice kind="error">{error.text}</Notice>
        {mfa && <p><Link className="btn primary" to="/mfa/enroll">Set up your authenticator</Link></p>}
        {!queue && !mfa && error.code === 'role_required' && <ChooseRole onPick={setRole} />}
      </>
    );
  }
  if (!queue) return <p className="muted">Loading…</p>;

  const own = queue.roles.find((r) => r.role === queue.role)?.own ?? false;
  const keep = (r: QueueRow) => !onlyMine || r.isMine || r.unassigned;
  const rows = queue.rows.filter(keep);
  const backlog = queue.backlog.filter(keep);
  const waiting = queue.rows.filter((r) => r.encounter.status === 'CHECKED_IN').length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Provider</h1>
          <p className="lede">{fmtDay(queue.today)} · {waiting} waiting · {queue.pending} {queue.pending === 1 ? 'note' : 'notes'} still to sign</p>
        </div>
        <div className="head-actions">
          <Link className={`btn small${queue.unsignedNotes?.overdue ? ' primary' : ''}`} to="/provider/unsigned">
            {unsignedLinkLabel(queue.unsignedNotes)}
          </Link>
          {queue.roles.length > 1 && (
            <div className="seg" role="group" aria-label="Role">
              {queue.roles.map((r) => (
                <button key={r.role} className={r.role === queue.role ? 'on' : ''} aria-pressed={r.role === queue.role} onClick={() => setRole(r.role)}>
                  {ROLE_NAME[r.role]}{r.own ? '' : ' (view)'}
                </button>
              ))}
            </div>
          )}
          <label className="check small"><input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} /> Only mine</label>
        </div>
      </div>

      {!own && <Notice kind="warn">You are looking at the <strong>{ROLE_NAME[queue.role]}</strong> queue. You can read it, but only a {ROLE_NAME[queue.role].toLowerCase()} can write the notes.</Notice>}

      <h2 className="section">Today</h2>
      <QueueTable rows={rows} tz={tz} showDate={false} canWrite={own} empty={onlyMine ? 'None of your patients are checked in.' : `No ${ROLE_NAME[queue.role].toLowerCase()} patients have been checked in today.`} />

      <h2 className="section">Earlier visits still to sign{backlog.length ? ` (${backlog.length})` : ''}</h2>
      <QueueTable rows={backlog} tz={tz} showDate canWrite={own} empty="Nothing outstanding from earlier days. " />
      <p className="hint">Shows the last 30 days, and only visits that need a note. Check-out does not wait for notes; your <Link to="/provider/unsigned">Unsigned notes</Link> list has every one still to sign, however old. {own ? 'Open a visit to write or sign its note.' : ''}</p>
    </>
  );

}

function ChooseRole({ onPick }: { onPick: (r: ProviderRole) => void }) {
  return (
    <div className="seg" role="group" aria-label="Choose a role">
      {(['PROVIDER_CHIRO', 'PROVIDER_NP', 'PROVIDER_NURSE'] as const).map((r) => <button key={r} onClick={() => onPick(r)}>{ROLE_NAME[r]}</button>)}
    </div>
  );
}

function QueueTable({ rows, tz, showDate, canWrite, empty }: { rows: QueueRow[]; tz: string; showDate: boolean; canWrite: boolean; empty: string }) {
  if (rows.length === 0) return <p className="empty">{empty}</p>;
  return (
    <div className="table-scroll">
      <table className="table">
        <thead>
          <tr><th>{showDate ? 'Date' : 'Time'}</th><th>Patient</th><th>Service</th><th>Provider</th><th>Visit</th><th>Documentation</th><th /></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.bookingId}>
              <td className="nowrap">{showDate ? `${fmtDay(r.localDate)} · ` : ''}{fmtTime12(r.localStart)}</td>
              <td><strong>{r.patient.name}</strong></td>
              <td><ServiceDot color={r.service.color} /> {r.service.name}{r.subOption ? ` · ${r.subOption}` : ''}
                <div className="muted small">{r.service.documentationType === 'SOAP' ? 'SOAP note' : 'Session log'}</div></td>
              <td>{r.covering ? <>{r.covering.name}<div className="muted small">covering for {r.staff?.name ?? 'no one assigned'}</div></> : (r.staff?.name ?? <span className="muted">Not assigned</span>)}{r.isMine && <span className="pill ok mine">you</span>}</td>
              <td>
                {ENCOUNTER_LABEL[r.encounter.status] ?? r.encounter.status}
                {r.waitingMinutes != null && r.encounter.status === 'CHECKED_IN' && <div className="muted small">in at {r.encounter.checkedInAt && fmtInstantTime(r.encounter.checkedInAt, tz)} · {r.waitingMinutes} min</div>}
              </td>
              <td>
                {r.note === 'NOT_REQUIRED'
                  ? <span className="pill off" title="This service needs no note. You can still write one.">No note needed</span>
                  : <span className={`pill ${STATUS_PILL[r.documentation.status]}`}>{STATUS_LABEL[r.documentation.status]}</span>}
                {r.documentation.status === 'SIGNED' && r.documentation.signedAt && <div className="muted small">{r.documentation.signedBy ? `${r.documentation.signedBy} · ` : ''}{fmtInstantTime(r.documentation.signedAt, tz)}</div>}
              </td>
              <td className="actions">
                <Link className={`btn small${r.note === 'PENDING' && r.mayDocument && canWrite ? ' primary' : ''}`} to={`/provider/visits/${r.bookingId}`}>
                  {r.documentation.status === 'SIGNED' || !r.mayDocument || !canWrite ? 'View' : r.documentation.status === 'DRAFT' ? 'Continue' : 'Open'}
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
