import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { errorText, Notice } from '../ui';
import { ROLE_NAME } from '../provider/docs';
import { MacroEditor, type MacroOps } from '../provider/MacroEditor';
import type { MacroSetAdmin, ProviderRole } from '../types';

const ROLES: ProviderRole[] = ['PROVIDER_CHIRO', 'PROVIDER_NP', 'PROVIDER_NURSE'];

/** Shared macro sets: text blocks every provider (or only the roles you choose) can insert into a note. */
export default function AdminMacros() {
  const [sets, setSets] = useState<MacroSetAdmin[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api<{ sets: MacroSetAdmin[] }>('/api/admin/macro-sets').then((r) => { setSets(r.sets); setError(null); }).catch((e) => setError(errorText(e))), []);
  useEffect(() => { void load(); }, [load]);

  return (
    <>
      <p><Link to="/admin">← Admin</Link></p>
      <h1>Macro sets</h1>
      <p className="lede">Shared text blocks that providers insert into a note section with one click. Each provider also keeps personal macros of their own, which only they can see.</p>
      {error && <Notice kind="error">{error}</Notice>}
      <NewSet onCreated={load} />
      {!sets && !error && <p className="muted">Loading…</p>}
      {sets?.length === 0 && <p className="empty">No shared sets yet.</p>}
      {sets?.map((s) => <SetCard key={s.id} set={s} onChanged={load} />)}
    </>
  );
}

function RolePicker({ value, onChange }: { value: ProviderRole[]; onChange: (v: ProviderRole[]) => void }) {
  return (
    <fieldset className="role-picker">
      <legend className="label-like">Offered to</legend>
      {ROLES.map((r) => (
        <label key={r} className="check small">
          <input type="checkbox" checked={value.includes(r)} onChange={(e) => onChange(e.target.checked ? [...value, r] : value.filter((x) => x !== r))} /> {ROLE_NAME[r]}
        </label>
      ))}
      <span className="hint">{value.length === 0 ? 'Nothing ticked means every provider role.' : ''}</span>
    </fieldset>
  );
}

function NewSet({ onCreated }: { onCreated: () => Promise<unknown> }) {
  const [name, setName] = useState('');
  const [roles, setRoles] = useState<ProviderRole[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await api('/api/admin/macro-sets', { method: 'POST', body: { name: name.trim(), roles } }); setName(''); setRoles([]); await onCreated(); }
    catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  }
  return (
    <form className="card wide-card stack" onSubmit={(e) => void submit(e)}>
      <h2>New shared set</h2>
      <div className="form-grid two">
        <label>Name<input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="e.g. Chiropractic follow-ups" /></label>
        <RolePicker value={roles} onChange={setRoles} />
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <div><button className="btn primary" disabled={busy || name.trim() === ''}>Create set</button></div>
    </form>
  );
}

function SetCard({ set, onChanged }: { set: MacroSetAdmin; onChanged: () => Promise<unknown> }) {
  const [name, setName] = useState(set.name);
  const [roles, setRoles] = useState<ProviderRole[]>(set.roles);
  const [active, setActive] = useState(set.active);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = name.trim() !== set.name || active !== set.active || [...roles].sort().join() !== [...set.roles].sort().join();

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await fn(); await onChanged(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  const ops: MacroOps = {
    add: async (m) => { await api(`/api/admin/macro-sets/${set.id}/macros`, { method: 'POST', body: m }); await onChanged(); },
    update: async (id, patch) => { await api(`/api/admin/macros/${id}`, { method: 'PATCH', body: patch }); await onChanged(); },
    remove: async (id) => { await api(`/api/admin/macros/${id}`, { method: 'DELETE', body: {} }); await onChanged(); },
  };

  return (
    <section className={`card wide-card stack${set.active ? '' : ' off-card'}`}>
      <header className="plan-card-head">
        <h2>{set.name} {!set.active && <span className="pill off">switched off</span>}</h2>
        <span className="muted small">{set.macros.length} {set.macros.length === 1 ? 'macro' : 'macros'} · {set.roles.length === 0 ? 'all providers' : set.roles.map((r) => ROLE_NAME[r]).join(', ')}</span>
      </header>
      <div className="form-grid two">
        <label>Name<input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></label>
        <RolePicker value={roles} onChange={setRoles} />
        <label className="check span2"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Offered to providers</label>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="sheet-actions">
        <button className="btn primary" disabled={!dirty || busy || name.trim() === ''} onClick={() => void run(() => api(`/api/admin/macro-sets/${set.id}`, { method: 'PATCH', body: { name: name.trim(), roles, active } }))}>Save set</button>
        <button className="btn danger" disabled={busy} onClick={() => { if (window.confirm(`Delete “${set.name}” and its ${set.macros.length} macros?`)) void run(() => api(`/api/admin/macro-sets/${set.id}`, { method: 'DELETE', body: {} })); }}>Delete set</button>
      </div>
      <h3>Macros</h3>
      <MacroEditor macros={set.macros} ops={ops} />
    </section>
  );
}
