import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { errorText, Notice } from '../ui';
import { fmtMoney, parseDollars } from '../lib';
import { DiscountCategories } from './DiscountCategories';

interface Perk { id: string; key: string; label: string; period: 'MONTHLY' | 'QUARTERLY' | 'ANNUAL'; quantity: number; active: boolean; serviceIds: string[] }
interface Plan { id: string; code: string; name: string; priceCents: number; creditsPerMonth: number; rolloverDays: number; active: boolean; members: number; perks: Perk[] }
interface Svc { id: string; name: string; durationMin: number; creditCost: number | null; priceCents: number | null }

const PERIOD = { MONTHLY: 'per month', QUARTERLY: 'per quarter', ANNUAL: 'per year' } as const;

/** The membership tiers as data: dues, credits a month, rollover — and the perk counters, which start switched off. */
export default function AdminMemberships() {
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [services, setServices] = useState<Svc[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api<{ plans: Plan[]; services: Svc[] }>('/api/admin/membership-plans').then((r) => { setPlans(r.plans); setServices(r.services); setError(null); }).catch((e) => setError(errorText(e))), []);
  useEffect(() => { void load(); }, [load]);

  return (
    <>
      <p><Link to="/admin">← Admin</Link></p>
      <h1>Memberships</h1>
      <p className="lede">The tiers are data: change a price or a monthly credit count here without a deploy. A change applies from the <strong>next grant</strong> — credits already granted are never touched, and nothing is prorated. Member discounts are set by service category, further down.</p>
      <Notice kind="warn">
        <strong>Nothing is discounted yet.</strong> Member discounts are set per tier per <em>service category</em> at the bottom of this page; until you set some, members pay list price in cash.<br />
        <strong>Perks start switched off.</strong> They are pre-filled from your tier copy (a monthly shot or IV, a quarterly body-composition analysis, guest passes) but nothing offers them at check-out until you confirm the quantities and switch them on.
        Each service’s price and credit cost are edited on <a href="/admin.html">Catalogue &amp; staff</a>.
      </Notice>
      {error && <Notice kind="error">{error}</Notice>}
      {!plans && !error && <p className="muted">Loading…</p>}
      {plans?.map((p) => <PlanCard key={p.id} plan={p} services={services} onSaved={load} />)}
      {plans && <DiscountCategories />}
    </>
  );
}

function PlanCard({ plan, services, onSaved }: { plan: Plan; services: Svc[]; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(plan.name);
  const [dues, setDues] = useState((plan.priceCents / 100).toFixed(2));
  const [credits, setCredits] = useState(String(plan.creditsPerMonth));
  const [rollover, setRollover] = useState(String(plan.rolloverDays));
  const [active, setActive] = useState(plan.active);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null);

  const cents = parseDollars(dues) ?? (dues.trim() === '0' || dues.trim() === '0.00' ? 0 : null);
  const dirty = name !== plan.name || cents !== plan.priceCents || Number(credits) !== plan.creditsPerMonth || Number(rollover) !== plan.rolloverDays || active !== plan.active;
  const valid = name.trim() !== '' && cents !== null && Number.isInteger(Number(credits)) && Number(credits) >= 0 && Number.isInteger(Number(rollover)) && Number(rollover) >= 1;

  async function save() {
    setBusy(true); setMsg(null);
    try {
      await api(`/api/admin/membership-plans/${plan.id}`, { method: 'PATCH', body: { name: name.trim(), priceCents: cents, creditsPerMonth: Number(credits), rolloverDays: Number(rollover), active } });
      setMsg({ kind: 'ok', text: 'Saved. Applies from the next grant.' }); await onSaved();
    } catch (e) { setMsg({ kind: 'error', text: errorText(e) }); }
    finally { setBusy(false); }
  }

  return (
    <section className="card wide-card plan-card">
      <header className="plan-card-head">
        <h2>{plan.name} <span className="mono small muted">{plan.code}</span></h2>
        <span className="muted small">{plan.members} current {plan.members === 1 ? 'member' : 'members'}</span>
      </header>
      <div className="form-grid">
        <label>Name<input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} /></label>
        <label>Dues ($ / month)<input inputMode="decimal" value={dues} onChange={(e) => setDues(e.target.value)} /><span className="hint">Collected outside this system. Currently {fmtMoney(plan.priceCents, { whole: true })}.</span></label>
        <label>Credits each month<input type="number" min={0} max={100} value={credits} onChange={(e) => setCredits(e.target.value)} /></label>
        <label>Rollover (days)<input type="number" min={1} max={730} value={rollover} onChange={(e) => setRollover(e.target.value)} /><span className="hint">A grant is usable this many days.</span></label>
        <label className="check span2"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Offered for new enrolments</label>
      </div>
      {msg && <p className={msg.kind === 'error' ? 'error' : 'ok-text'} role={msg.kind === 'error' ? 'alert' : 'status'}>{msg.text}</p>}
      <div className="sheet-actions"><button className="btn primary" disabled={!dirty || !valid || busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save tier'}</button></div>

      <h3>Included perks</h3>
      <table className="table dense">
        <thead><tr><th>Perk</th><th>How many</th><th>Counted</th><th>Redeemed by checking out</th><th>On</th><th /></tr></thead>
        <tbody>{plan.perks.map((k) => <PerkRow key={k.id} planId={plan.id} perk={k} services={services} onSaved={onSaved} />)}</tbody>
      </table>
    </section>
  );
}

function PerkRow({ planId, perk, services, onSaved }: { planId: string; perk: Perk; services: Svc[]; onSaved: () => Promise<void> }) {
  const [qty, setQty] = useState(String(perk.quantity));
  const [active, setActive] = useState(perk.active);
  const [ids, setIds] = useState<string[]>(perk.serviceIds);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const same = ids.length === perk.serviceIds.length && ids.every((i) => perk.serviceIds.includes(i));
  const dirty = Number(qty) !== perk.quantity || active !== perk.active || !same;

  async function save() {
    setBusy(true); setErr(null);
    try { await api(`/api/admin/membership-plans/${planId}/perks/${perk.id}`, { method: 'PATCH', body: { quantity: Number(qty), active, serviceIds: ids } }); await onSaved(); }
    catch (e) { setErr(errorText(e)); }
    finally { setBusy(false); }
  }

  return (
    <tr className={active ? '' : 'off'}>
      <td>{perk.label}</td>
      <td><input type="number" min={0} max={100} value={qty} onChange={(e) => setQty(e.target.value)} style={{ width: 80 }} /></td>
      <td>{PERIOD[perk.period]}</td>
      <td>
        <details>
          <summary>{ids.length === 0 ? 'None — used by hand (e.g. guest passes)' : `${ids.length} service${ids.length === 1 ? '' : 's'}`}</summary>
          <div className="check-list">
            {services.map((s) => (
              <label key={s.id} className="check small"><input type="checkbox" checked={ids.includes(s.id)} onChange={(e) => setIds(e.target.checked ? [...ids, s.id] : ids.filter((x) => x !== s.id))} /> {s.name}</label>
            ))}
          </div>
        </details>
      </td>
      <td><label className="check"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} aria-label={`${perk.label} on`} /> {active ? 'on' : 'off'}</label></td>
      <td>{dirty && <button className="btn small primary" disabled={busy} onClick={() => void save()}>Save</button>}{err && <div className="error small">{err}</div>}</td>
    </tr>
  );
}
