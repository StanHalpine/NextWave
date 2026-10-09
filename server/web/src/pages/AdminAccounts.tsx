import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, type Role } from '../api';
import { useAuth } from '../auth';
import { ROLE_LABEL } from '../modules';

interface Account {
  id: string; email: string; displayName: string; roles: Role[]; staffId: string | null; active: boolean;
  mfaEnabled: boolean; locked: boolean; lastLoginAt: string | null; pendingSetup: boolean;
}
interface LinkableStaff { id: string; name: string; role: string }

const ALL_ROLES: Role[] = ['FRONT_DESK', 'ADMIN', 'PROVIDER_CHIRO', 'PROVIDER_NP', 'PROVIDER_NURSE'];
const STAFF_ROLE_FOR: Partial<Record<Role, string>> = {
  PROVIDER_CHIRO: 'CHIROPRACTOR', PROVIDER_NP: 'NURSE_PRACTITIONER', PROVIDER_NURSE: 'REGISTERED_NURSE',
};
const isProvider = (r: Role) => r in STAFF_ROLE_FOR;

function LinkBox({ link, onClose }: { link: string; onClose: () => void }) {
  return (
    <div className="linkbox" role="status">
      <strong>One-time setup link</strong> — shown only now. Send it to the person directly; it works once and expires in 24 hours.
      <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} className="mono" />
      <div>
        <button className="btn" onClick={() => void navigator.clipboard?.writeText(link)}>Copy link</button>{' '}
        <button className="btn ghost" onClick={onClose}>Done</button>
      </div>
    </div>
  );
}

function RoleEditor(props: {
  roles: Role[]; staffId: string | null; linkable: LinkableStaff[];
  onRoles: (r: Role[]) => void; onStaff: (id: string | null) => void;
}) {
  const provider = props.roles.find(isProvider);
  const options = provider ? props.linkable.filter((s) => s.role === STAFF_ROLE_FOR[provider]) : [];
  const toggle = (r: Role) => props.onRoles(props.roles.includes(r) ? props.roles.filter((x) => x !== r) : [...props.roles, r]);
  return (
    <>
      <fieldset>
        <legend>Roles</legend>
        {ALL_ROLES.map((r) => (
          <label key={r} className="check">
            <input type="checkbox" checked={props.roles.includes(r)} onChange={() => toggle(r)} /> {ROLE_LABEL[r]}
          </label>
        ))}
        <p className="hint">Any mix of Front desk and Admin, plus at most one provider role.</p>
      </fieldset>
      {provider && (
        <label>Linked provider record
          <select value={props.staffId ?? ''} onChange={(e) => props.onStaff(e.target.value || null)} required>
            <option value="">— choose —</option>
            {options.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <span className="hint">A provider login must be tied to the bookable provider it writes notes as.</span>
        </label>
      )}
    </>
  );
}

export default function AdminAccounts() {
  const { me } = useAuth();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [linkable, setLinkable] = useState<LinkableStaff[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [roles, setRoles] = useState<Role[]>(['FRONT_DESK']);
  const [staffId, setStaffId] = useState<string | null>(null);
  const [eRoles, setERoles] = useState<Role[]>([]);
  const [eStaff, setEStaff] = useState<string | null>(null);

  const load = useCallback(() => api<{ accounts: Account[]; linkableStaff: LinkableStaff[] }>('/api/admin/accounts')
    .then((r) => { setAccounts(r.accounts); setLinkable(r.linkableStaff); })
    .catch((e) => setError(e.message)), []);
  useEffect(() => { void load(); }, [load]);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try { await fn(); await load(); } catch (e) { setError(e instanceof ApiError ? e.message : 'Something went wrong.'); }
  };

  async function create(e: FormEvent) {
    e.preventDefault();
    await run(async () => {
      const r = await api<{ setupLink: string }>('/api/admin/accounts', { method: 'POST', body: { email, displayName: name, roles, staffId } });
      setLink(r.setupLink); setEmail(''); setName(''); setRoles(['FRONT_DESK']); setStaffId(null);
    });
  }

  return (
    <>
      <p><Link to="/admin">← Admin</Link></p>
      <h1>Accounts</h1>
      <p className="lede">Each person signs in as themselves. You never see or set anyone's password — new and reset accounts get a one-time link.</p>
      {error && <p className="error" role="alert">{error}</p>}
      {link && <LinkBox link={link} onClose={() => setLink(null)} />}

      <table className="table">
        <thead><tr><th>Person</th><th>Roles</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {accounts.map((a) => (
            <tr key={a.id} className={a.active ? '' : 'off'}>
              <td><strong>{a.displayName}</strong><br /><span className="mono small">{a.email}</span></td>
              <td>{a.roles.map((r) => ROLE_LABEL[r]).join(', ')}</td>
              <td>
                {!a.active && <span className="pill off">Deactivated</span>}
                {a.active && a.pendingSetup && <span className="pill warn">Awaiting setup</span>}
                {a.locked && <span className="pill bad">Locked</span>}
                {a.active && !a.pendingSetup && !a.locked && <span className="pill ok">Active</span>}{' '}
                {a.mfaEnabled && <span className="pill">MFA</span>}
              </td>
              <td className="actions">
                {editing === a.id ? (
                  <form className="inline-edit" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api(`/api/admin/accounts/${a.id}`, { method: 'PATCH', body: { roles: eRoles, staffId: eStaff } }); setEditing(null); }); }}>
                    <RoleEditor roles={eRoles} staffId={eStaff} linkable={linkable.concat(a.staffId ? [{ id: a.staffId, name: '(current)', role: STAFF_ROLE_FOR[a.roles.find(isProvider) as Role] ?? '' }] : [])} onRoles={setERoles} onStaff={setEStaff} />
                    <button className="btn primary">Save</button> <button type="button" className="btn ghost" onClick={() => setEditing(null)}>Cancel</button>
                  </form>
                ) : (
                  <>
                    <button className="btn small" onClick={() => { setEditing(a.id); setERoles(a.roles); setEStaff(a.staffId); }}>Roles</button>{' '}
                    <button className="btn small" onClick={() => void run(async () => { const r = await api<{ setupLink: string }>(`/api/admin/accounts/${a.id}/reset-password`, { method: 'POST', body: {} }); setLink(r.setupLink); })}>Reset password</button>{' '}
                    {a.locked && <><button className="btn small" onClick={() => void run(() => api(`/api/admin/accounts/${a.id}/unlock`, { method: 'POST', body: {} }))}>Unlock</button>{' '}</>}
                    {a.mfaEnabled && <><button className="btn small" onClick={() => { if (confirm(`Reset the authenticator for ${a.displayName}? They will have to set it up again at next sign-in.`)) void run(() => api(`/api/admin/accounts/${a.id}/reset-mfa`, { method: 'POST', body: {} })); }}>Reset MFA</button>{' '}</>}
                    {a.id !== me?.account.id && (
                      <button className="btn small ghost" onClick={() => { if (!a.active || confirm(`Deactivate ${a.displayName}? Their sessions end immediately.`)) void run(() => api(`/api/admin/accounts/${a.id}`, { method: 'PATCH', body: { active: !a.active } })); }}>
                        {a.active ? 'Deactivate' : 'Reactivate'}
                      </button>
                    )}
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 className="section">Add a person</h2>
      <form className="card" onSubmit={create}>
        <label>Name<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} /></label>
        <label>Email (their login)<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <RoleEditor roles={roles} staffId={staffId} linkable={linkable} onRoles={(r) => { setRoles(r); setStaffId(null); }} onStaff={setStaffId} />
        <button className="btn primary" disabled={roles.length === 0}>Create and get setup link</button>
      </form>
    </>
  );
}
