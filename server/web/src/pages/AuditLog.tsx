import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';

interface Entry {
  id: string; occurredAt: string; actor: { id: string; name: string } | null; actorRoles: string | null;
  action: string; resourceType: string; resourceId: string | null; success: boolean; requestId: string | null; meta: unknown;
}

const TYPES = ['appointment', 'patient', 'booking_contact', 'message', 'service', 'membership', 'membership_plan', 'credit_ledger', 'perk_usage', 'revenue_event', 'sms_consent', 'visit_note', 'encounter', 'account', 'route', 'audit_log'];
const ACTIONS = ['CREATE', 'READ', 'UPDATE', 'DELETE', 'LOGIN', 'LOGIN_FAILED', 'LOGOUT', 'LOCKOUT', 'MFA_ENROLL', 'MFA_VERIFY', 'MFA_FAILED', 'PASSWORD_CHANGE', 'PASSWORD_RESET', 'ACCESS_DENIED'];

export default function AuditLog() {
  const [rows, setRows] = useState<Entry[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [type, setType] = useState('');
  const [action, setAction] = useState('');
  const [outcome, setOutcome] = useState('');
  const [actor, setActor] = useState('');
  const [error, setError] = useState<string | null>(null);

  const query = useCallback((before?: string) => {
    const p = new URLSearchParams();
    if (type) p.set('resourceType', type);
    if (action) p.set('action', action);
    if (outcome) p.set('success', outcome);
    if (actor) p.set('actor', actor);
    if (before) p.set('before', before);
    return api<{ entries: Entry[]; nextBefore: string | null }>(`/api/admin/audit?${p}`);
  }, [type, action, outcome, actor]);

  useEffect(() => {
    query().then((r) => { setRows(r.entries); setNext(r.nextBefore); setError(null); }).catch((e) => setError(e.message));
  }, [query]);

  return (
    <>
      <p><Link to="/admin">← Admin</Link></p>
      <h1>Audit log</h1>
      <p className="lede">Append-only record of access to patient and account data. It holds opaque ids and counts — never a name, number or note.</p>
      <div className="filters">
        <label>Resource<select value={type} onChange={(e) => setType(e.target.value)}><option value="">All</option>{TYPES.map((t) => <option key={t}>{t}</option>)}</select></label>
        <label>Action<select value={action} onChange={(e) => setAction(e.target.value)}><option value="">All</option>{ACTIONS.map((t) => <option key={t}>{t}</option>)}</select></label>
        <label>Outcome<select value={outcome} onChange={(e) => setOutcome(e.target.value)}><option value="">All</option><option value="true">Succeeded</option><option value="false">Refused / failed</option></select></label>
        {actor && <button className="btn small" onClick={() => setActor('')}>Clear person filter ✕</button>}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <table className="table dense">
        <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Record</th><th>Outcome</th><th>Request</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={r.success ? '' : 'bad-row'}>
              <td className="mono small">{new Date(r.occurredAt).toLocaleString()}</td>
              <td>
                {r.actor ? <button className="linklike" onClick={() => setActor(r.actor!.id)}>{r.actor.name}</button> : <span className="muted">{r.actorRoles ?? 'anonymous'}</span>}
                {r.actor && r.actorRoles && <span className="small muted"> · {r.actorRoles}</span>}
              </td>
              <td className="mono small">{r.action}</td>
              <td className="mono small">{r.resourceType}{r.resourceId && <><br /><span className="muted">{r.resourceId.slice(0, 8)}…</span></>}</td>
              <td>{r.success ? <span className="pill ok">ok</span> : <span className="pill bad">refused</span>}</td>
              <td className="mono small muted">{r.requestId?.slice(0, 8)}</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={6} className="muted">No entries match.</td></tr>}
        </tbody>
      </table>
      {next && <button className="btn" onClick={() => void query(next).then((r) => { setRows((x) => [...x, ...r.entries]); setNext(r.nextBefore); })}>Load more</button>}
    </>
  );
}
