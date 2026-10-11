import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { errorText, Notice } from '../ui';

interface Category { id: string; code: string; name: string; active: boolean; sortOrder: number; serviceIds: string[]; percents: Record<string, number> }
interface Plan { id: string; code: string; name: string }
interface Svc { id: string; name: string; category: string; durationMin: number; discountCategoryId: string | null; priceCents: number | null }
interface View { categories: Category[]; plans: Plan[]; services: Svc[] }

/**
 * Member discounts: a percentage per tier per SERVICE CATEGORY. A member who pays CASH for a service gets the percent
 * their tier has for that service's category, off the list price. Credits and perks are never discounted. A service
 * is in at most one category; one in no category is not discounted; a category switched off discounts nothing.
 */
export function DiscountCategories() {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api<View>('/api/admin/discount-categories').then((v) => { setView(v); setError(null); }).catch((e) => setError(errorText(e))), []);
  useEffect(() => { void load(); }, [load]);

  return (
    <section className="card wide-card stack discount-section">
      <h2>Member discounts by service category</h2>
      <p className="hint">
        An <strong>active</strong> member who pays <strong>cash</strong> gets their tier’s percentage for the service’s category, off the <strong>list</strong> price.
        Credits and perks are never discounted. A service belongs to one category at most; a service in none is never discounted.
      </p>
      {error && <Notice kind="error">{error}</Notice>}
      {!view && !error && <p className="muted">Loading…</p>}
      {view && view.categories.length === 0 && <Notice kind="warn"><strong>No categories yet, so nothing is discounted.</strong> Add one below, choose its services, and set each tier’s percentage.</Notice>}
      {view?.categories.map((c) => <CategoryRow key={c.id} cat={c} view={view} onChanged={load} />)}
      {view && <NewCategory onCreated={load} />}
    </section>
  );
}

function CategoryRow({ cat, view, onChanged }: { cat: Category; view: View; onChanged: () => Promise<unknown> }) {
  const [name, setName] = useState(cat.name);
  const [active, setActive] = useState(cat.active);
  const [ids, setIds] = useState<string[]>(cat.serviceIds);
  const [pct, setPct] = useState<Record<string, string>>(Object.fromEntries(view.plans.map((p) => [p.id, String(cat.percents[p.id] ?? 0)])));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null);

  const sameIds = ids.length === cat.serviceIds.length && ids.every((i) => cat.serviceIds.includes(i));
  const pctOk = view.plans.every((p) => /^\d{1,3}$/.test(pct[p.id] ?? '') && Number(pct[p.id]) <= 100);
  const pctChanged = view.plans.some((p) => Number(pct[p.id]) !== (cat.percents[p.id] ?? 0));
  const dirty = name.trim() !== cat.name || active !== cat.active || !sameIds || pctChanged;

  async function save() {
    setBusy(true); setMsg(null);
    try {
      if (name.trim() !== cat.name || active !== cat.active || !sameIds) {
        await api(`/api/admin/discount-categories/${cat.id}`, { method: 'PATCH', body: { name: name.trim(), active, serviceIds: ids } });
      }
      if (pctChanged) {
        await api(`/api/admin/discount-categories/${cat.id}/discounts`, { method: 'PUT', body: { percents: Object.fromEntries(view.plans.map((p) => [p.id, Number(pct[p.id])])) } });
      }
      setMsg({ kind: 'ok', text: 'Saved. Applies from the next check-out.' });
      await onChanged();
    } catch (e) { setMsg({ kind: 'error', text: errorText(e) }); } finally { setBusy(false); }
  }
  async function remove() {
    if (!window.confirm(`Delete “${cat.name}”? Its services go back to having no discount, and its percentages are removed. Past check-outs keep what was applied.`)) return;
    setBusy(true); setMsg(null);
    try { await api(`/api/admin/discount-categories/${cat.id}`, { method: 'DELETE', body: {} }); await onChanged(); }
    catch (e) { setMsg({ kind: 'error', text: errorText(e) }); setBusy(false); }
  }
  // A service that is in ANOTHER category is moved here when ticked: say so.
  const elsewhere = (s: Svc) => (s.discountCategoryId && s.discountCategoryId !== cat.id ? view.categories.find((c) => c.id === s.discountCategoryId)?.name : null);

  return (
    <div className={`category-row${active ? '' : ' off'}`}>
      <div className="form-grid two">
        <label>Category<input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></label>
        <label className="check"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Switched on <span className="muted small mono">{cat.code}</span></label>
      </div>
      <div className="percent-grid" role="group" aria-label={`Percent off for ${cat.name}`}>
        {view.plans.map((p) => (
          <label key={p.id}>{p.name} (%)
            <input type="number" min={0} max={100} step={1} inputMode="numeric" value={pct[p.id]} onChange={(e) => setPct({ ...pct, [p.id]: e.target.value })} />
          </label>
        ))}
      </div>
      <details>
        <summary>{ids.length === 0 ? 'No services yet' : `${ids.length} service${ids.length === 1 ? '' : 's'}`}</summary>
        <div className="check-list">
          {view.services.map((s) => (
            <label key={s.id} className="check small">
              <input type="checkbox" checked={ids.includes(s.id)} onChange={(e) => setIds(e.target.checked ? [...ids, s.id] : ids.filter((x) => x !== s.id))} /> {s.name}
              {elsewhere(s) && <span className="muted"> (now in {elsewhere(s)} — ticking moves it here)</span>}
            </label>
          ))}
        </div>
      </details>
      {msg && <p className={msg.kind === 'error' ? 'error' : 'ok-text'} role={msg.kind === 'error' ? 'alert' : 'status'}>{msg.text}</p>}
      <div className="sheet-actions">
        <button className="btn primary" disabled={!dirty || !pctOk || name.trim() === '' || busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save category'}</button>
        <button className="btn danger" disabled={busy} onClick={() => void remove()}>Delete</button>
      </div>
    </div>
  );
}

function NewCategory({ onCreated }: { onCreated: () => Promise<unknown> }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await api('/api/admin/discount-categories', { method: 'POST', body: { name: name.trim() } }); setName(''); await onCreated(); }
    catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  }
  return (
    <form className="new-category" onSubmit={(e) => void submit(e)}>
      <label>New category<input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="e.g. Spinal X-rays" /></label>
      <button className="btn" disabled={busy || name.trim() === ''}>Add category</button>
      {error && <p className="error" role="alert">{error}</p>}
    </form>
  );
}
