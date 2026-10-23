import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { errorText, Notice } from '../ui';
import { fmtDay, fmtMoney, parseDollars } from '../lib';

interface Promotion {
  id: string; name: string; kind: 'PERCENT' | 'FIXED_CENTS'; value: number; startsOn: string; endsOn: string; active: boolean;
  services: Array<{ id: string; name: string }>; used: boolean;
}
interface ServiceLite { id: string; name: string }

const describe = (p: Pick<Promotion, 'kind' | 'value'>) => (p.kind === 'PERCENT' ? `${p.value}% off` : `${fmtMoney(p.value)} off`);

/**
 * Admin → Promotions (Phase 2b, rev 2.2). A promotion takes a percent or a fixed amount off chosen services for visits on chosen days
 * (the VISIT's clinic date). Check-out applies it automatically when it is better for the patient than their membership's tier discount —
 * never both, and never two promotions together. Once a check-out has used one, its type, amount, dates and services are fixed: switch it
 * off and create another.
 */
export default function AdminPromotions() {
  const [rows, setRows] = useState<Promotion[] | null>(null);
  const [services, setServices] = useState<ServiceLite[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Promotion | null>(null);

  const load = useCallback(() => api<{ promotions: Promotion[]; services: ServiceLite[] }>('/api/admin/promotions')
    .then((r) => { setRows(r.promotions); setServices(r.services); setError(null); }).catch((e) => setError(errorText(e))), []);
  useEffect(() => { void load(); }, [load]);

  async function toggle(p: Promotion) {
    try { await api(`/api/admin/promotions/${p.id}`, { method: 'PATCH', body: { active: !p.active } }); await load(); } catch (e) { setError(errorText(e)); }
  }

  return (
    <>
      <p className="crumb"><Link to="/admin">← Admin</Link></p>
      <h1>Promotions</h1>
      <p className="lede">A promotion takes a percent or an amount off chosen services, for visits on the days you choose. At check-out it applies by itself
        when it is better for the patient than their membership discount — never both, and only the best one. Once used, it can be switched off but not changed.</p>
      {error && <Notice kind="error">{error}</Notice>}
      <table className="table">
        <thead><tr><th>Promotion</th><th>Off</th><th>Visits on</th><th>Services</th><th>Status</th><th /></tr></thead>
        <tbody>
          {(rows ?? []).map((p) => (
            <tr key={p.id} className={p.active ? '' : 'off'}>
              <td><strong>{p.name}</strong></td>
              <td>{describe(p)}</td>
              <td className="nowrap">{fmtDay(p.startsOn)} – {fmtDay(p.endsOn)}</td>
              <td>{p.services.map((s) => s.name).join(', ')}</td>
              <td>{p.active ? <span className="pill ok">On</span> : <span className="pill off">Off</span>}{p.used && <> <span className="pill">Used</span></>}</td>
              <td className="actions">
                <button className="btn small" onClick={() => setEditing(p)}>{p.used ? 'Rename' : 'Edit'}</button>{' '}
                <button className="btn small ghost" onClick={() => void toggle(p)}>{p.active ? 'Switch off' : 'Switch on'}</button>
              </td>
            </tr>
          ))}
          {rows && rows.length === 0 && <tr><td colSpan={6} className="muted">No promotions yet.</td></tr>}
          {rows === null && <tr><td colSpan={6}>Loading…</td></tr>}
        </tbody>
      </table>

      <h2 className="section">{editing ? `Change “${editing.name}”` : 'New promotion'}</h2>
      <PromotionForm key={editing?.id ?? 'new'} services={services} existing={editing} onSaved={() => { setEditing(null); void load(); }} onCancel={editing ? () => setEditing(null) : undefined} />
    </>
  );
}

function PromotionForm({ services, existing, onSaved, onCancel }: { services: ServiceLite[]; existing: Promotion | null; onSaved: () => void; onCancel?: () => void }) {
  const frozen = !!existing?.used;
  const [name, setName] = useState(existing?.name ?? '');
  const [kind, setKind] = useState<'PERCENT' | 'FIXED_CENTS'>(existing?.kind ?? 'PERCENT');
  const [value, setValue] = useState(existing ? (existing.kind === 'PERCENT' ? String(existing.value) : (existing.value / 100).toFixed(2)) : '');
  const [startsOn, setStartsOn] = useState(existing?.startsOn ?? '');
  const [endsOn, setEndsOn] = useState(existing?.endsOn ?? '');
  const [picked, setPicked] = useState<string[]>(existing?.services.map((s) => s.id) ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const amount = kind === 'PERCENT' ? (/^\d{1,3}$/.test(value.trim()) ? Number(value) : null) : parseDollars(value);
  const ok = name.trim() !== '' && (frozen || (amount != null && amount > 0 && (kind !== 'PERCENT' || amount <= 100) && startsOn !== '' && endsOn !== '' && endsOn >= startsOn && picked.length > 0));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ok) return;
    setBusy(true); setError(null);
    const body = frozen ? { name: name.trim() } : { name: name.trim(), kind, value: amount, startsOn, endsOn, serviceIds: picked };
    try {
      await api(existing ? `/api/admin/promotions/${existing.id}` : '/api/admin/promotions', { method: existing ? 'PATCH' : 'POST', body });
      onSaved();
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  }

  return (
    <form className="card stack" onSubmit={(e) => void submit(e)}>
      {frozen && <Notice>This promotion has been used at check-out, so only its name can change. To change what it gives, switch it off and create a new one.</Notice>}
      <label>Name<input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="e.g. Red light week" required /></label>
      <div className="form-grid two">
        <label>Type<select value={kind} disabled={frozen} onChange={(e) => { setKind(e.target.value as 'PERCENT' | 'FIXED_CENTS'); setValue(''); }}>
          <option value="PERCENT">Percent off</option><option value="FIXED_CENTS">Amount off ($)</option></select></label>
        <label>{kind === 'PERCENT' ? 'Percent (1–100)' : 'Amount $'}<input inputMode="decimal" value={value} disabled={frozen} onChange={(e) => setValue(e.target.value)} /></label>
        <label>For visits from<input type="date" value={startsOn} disabled={frozen} onChange={(e) => setStartsOn(e.target.value)} /></label>
        <label>to (inclusive)<input type="date" value={endsOn} disabled={frozen} onChange={(e) => setEndsOn(e.target.value)} /></label>
      </div>
      <fieldset disabled={frozen}>
        <legend>Services</legend>
        <div className="check-grid">
          {services.map((s) => (
            <label key={s.id} className="check"><input type="checkbox" checked={picked.includes(s.id)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, s.id] : p.filter((x) => x !== s.id)))} /> {s.name}</label>
          ))}
        </div>
      </fieldset>
      <p className="hint">Dates are the clinic’s calendar days and go by the day of the VISIT: a visit on the last day keeps the price even if it is checked out the next morning.</p>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="sheet-actions">
        <button className="btn primary" disabled={!ok || busy}>{busy ? 'Saving…' : existing ? 'Save' : 'Create promotion'}</button>
        {onCancel && <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}
