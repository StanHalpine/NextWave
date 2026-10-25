import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { errorText, Notice } from '../ui';
import { fmtMoney, parseDollars } from '../lib';
import { ratePercent } from '../money';

interface Product { id: string; name: string; category: string; priceCents: number; taxable: boolean; tierDiscount: boolean; active: boolean; sortOrder: number; used: boolean }
interface Catalog {
  products: Product[];
  taxRate: { rateMilli: number };
  productDiscounts: Array<{ planId: string; code: string; name: string; active: boolean; percent: number }>;
  addOnServices: Array<{ id: string; name: string; category: string; priceCents: number | null; requiresNote: boolean; offerAsAddOn: boolean }>;
}

/** "5.5" → 5500 thousandths of a percent; null when it is not a percent from 0 to 100 with at most three decimals. */
function parseRate(s: string): number | null {
  const t = s.trim().replace(/%$/, '');
  if (!/^\d{1,3}(\.\d{1,3})?$/.test(t)) return null;
  const milli = Math.round(Number(t) * 1000);
  return milli <= 100_000 ? milli : null;
}

/**
 * Admin → Product catalog (Phase 2c-A, SPEC rev 2.3): the products the Charges window offers, the sales-tax rate, the member discount on products
 * per tier, and which services are offered as quick-add add-ons (InBody = body composition). Editing a name or price changes only what
 * is added from now on — every line already added, and every charge, keeps the name and price it had (decision 1).
 */
export default function AdminCatalog() {
  const [data, setData] = useState<Catalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Product | null>(null);
  const [rate, setRate] = useState('');
  const [percents, setPercents] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(() => api<Catalog>('/api/admin/catalog').then((r) => {
    setData(r); setError(null);
    setRate(ratePercent(r.taxRate.rateMilli).replace('%', ''));
    setPercents(Object.fromEntries(r.productDiscounts.map((d) => [d.planId, String(d.percent)])));
  }).catch((e) => setError(errorText(e))), []);
  useEffect(() => { void load(); }, [load]);

  async function run(label: string, f: () => Promise<unknown>) {
    setError(null); setSaved(null);
    try { await f(); await load(); setSaved(label); } catch (e) { setError(errorText(e)); }
  }

  const rateMilli = parseRate(rate);
  const percentOk = Object.values(percents).every((p) => /^\d{1,3}$/.test(p.trim()) && Number(p) <= 100);

  return (
    <>
      <p className="crumb"><Link to="/admin">← Admin</Link></p>
      <h1>Product catalog</h1>
      <p className="lede">What the Charges window offers: retail products and service add-ons, the sales tax on products, and the member discount on products.
        A change applies to what is added from now on — anything already added or checked out keeps the name, price and tax it had.</p>
      {error && <Notice kind="error">{error}</Notice>}
      {saved && <Notice>{saved} saved.</Notice>}

      <h2 className="section">Products</h2>
      <table className="table">
        <thead><tr><th>Product</th><th>Group</th><th className="num">Price</th><th>Sales tax</th><th>Member discount</th><th>Status</th><th /></tr></thead>
        <tbody>
          {(data?.products ?? []).map((p) => (
            <tr key={p.id} className={p.active ? '' : 'off'}>
              <td><strong>{p.name}</strong></td>
              <td>{p.category}</td>
              <td className="num">{fmtMoney(p.priceCents)}</td>
              <td>{p.taxable ? 'Taxed' : <span className="muted">Not taxed</span>}</td>
              <td>{p.tierDiscount ? 'Eligible' : <span className="muted">No</span>}</td>
              <td>{p.active ? <span className="pill ok">On the menu</span> : <span className="pill off">Off</span>}{p.used && <> <span className="pill">Sold</span></>}</td>
              <td className="actions"><button className="btn small" onClick={() => setEditing(p)}>Edit</button></td>
            </tr>
          ))}
          {data && data.products.length === 0 && <tr><td colSpan={7} className="muted">No products yet.</td></tr>}
          {!data && <tr><td colSpan={7}>Loading…</td></tr>}
        </tbody>
      </table>
      <h3>{editing ? `Change “${editing.name}”` : 'New product'}</h3>
      <ProductForm key={editing?.id ?? 'new'} existing={editing} onSaved={(label) => { setEditing(null); setSaved(label); void load(); }} onCancel={editing ? () => setEditing(null) : undefined} />

      <h2 className="section">Sales tax</h2>
      <form className="card stack" onSubmit={(e: FormEvent) => { e.preventDefault(); if (rateMilli != null) void run('Sales tax', () => api('/api/admin/catalog/tax-rate', { method: 'PUT', body: { rateMilli } })); }}>
        <label>Rate on taxable products (%)<input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} style={{ maxWidth: 120 }} /></label>
        <p className="hint">Services are never taxed. Tax is worked out per line on what the patient pays after any discount, to the cent with halves rounded up, and is shown apart from revenue.</p>
        <div className="sheet-actions"><button className="btn primary" disabled={rateMilli == null}>Save rate</button></div>
      </form>

      <h2 className="section">Member discount on products</h2>
      <form className="card stack" onSubmit={(e: FormEvent) => { e.preventDefault(); if (percentOk && data) void run('Member discount', () => api('/api/admin/catalog/product-discounts', { method: 'PUT', body: { discounts: data.productDiscounts.map((d) => ({ planId: d.planId, percent: Number(percents[d.planId]) })) } })); }}>
        <div className="form-grid two">
          {(data?.productDiscounts ?? []).map((d) => (
            <label key={d.planId}>{d.name}{!d.active && <span className="muted small"> (inactive tier)</span>} — % off<input inputMode="numeric" value={percents[d.planId] ?? ''} onChange={(e) => setPercents((p) => ({ ...p, [d.planId]: e.target.value }))} style={{ maxWidth: 100 }} /></label>
          ))}
        </div>
        <p className="hint">For an active member, on products marked eligible, when they pay in money. A promotion on the product applies instead when it is better for the patient — never both. Membership credits never pay for a product.</p>
        <div className="sheet-actions"><button className="btn primary" disabled={!percentOk}>Save discounts</button></div>
      </form>

      <h2 className="section">Service add-ons</h2>
      <p className="hint">A service offered here is a quick-add button, charged with no booking — priced exactly as a booked visit of it (its perks, credits and discount), and never taxed. Only a service that needs no signed note can be offered.</p>
      <table className="table">
        <thead><tr><th>Service</th><th className="num">Price</th><th>Offered</th><th /></tr></thead>
        <tbody>
          {(data?.addOnServices ?? []).map((s) => (
            <tr key={s.id}>
              <td>{s.name} <span className="muted small">· {s.category}</span></td>
              <td className="num">{fmtMoney(s.priceCents)}</td>
              <td>{s.offerAsAddOn ? <span className="pill ok">Quick-add</span> : <span className="muted">No</span>}</td>
              <td className="actions"><button className="btn small ghost" onClick={() => void run('Add-ons', () => api(`/api/admin/catalog/add-ons/${s.id}`, { method: 'PATCH', body: { offerAsAddOn: !s.offerAsAddOn } }))}>{s.offerAsAddOn ? 'Stop offering' : 'Offer as add-on'}</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function ProductForm({ existing, onSaved, onCancel }: { existing: Product | null; onSaved: (label: string) => void; onCancel?: () => void }) {
  const [name, setName] = useState(existing?.name ?? '');
  const [category, setCategory] = useState(existing?.category ?? 'Supplements');
  const [price, setPrice] = useState(existing ? (existing.priceCents / 100).toFixed(2) : '');
  const [taxable, setTaxable] = useState(existing?.taxable ?? true);
  const [tierDiscount, setTierDiscount] = useState(existing?.tierDiscount ?? true);
  const [active, setActive] = useState(existing?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cents = parseDollars(price);
  const ok = name.trim() !== '' && category.trim() !== '' && cents != null && cents >= 0;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ok) return;
    setBusy(true); setError(null);
    const body = { name: name.trim(), category: category.trim(), priceCents: cents, taxable, tierDiscount, active };
    try {
      await api(existing ? `/api/admin/catalog/products/${existing.id}` : '/api/admin/catalog/products', { method: existing ? 'PATCH' : 'POST', body });
      onSaved(existing ? 'Product' : 'New product');
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  }

  return (
    <form className="card stack" onSubmit={(e) => void submit(e)}>
      {existing?.used && <Notice>This product has been sold. A new name or price applies from now on; what was sold keeps its own.</Notice>}
      <div className="form-grid two">
        <label>Name<input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="e.g. Magnesium glycinate" required /></label>
        <label>Group (the Charges window tab)<input value={category} maxLength={40} onChange={(e) => setCategory(e.target.value)} /></label>
        <label>Price $<input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} /></label>
      </div>
      <label className="check"><input type="checkbox" checked={taxable} onChange={(e) => setTaxable(e.target.checked)} /> Taxed (sales tax on products)</label>
      <label className="check"><input type="checkbox" checked={tierDiscount} onChange={(e) => setTierDiscount(e.target.checked)} /> Eligible for the member discount on products</label>
      <label className="check"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> On the Charges menu</label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="sheet-actions">
        <button className="btn primary" disabled={!ok || busy}>{busy ? 'Saving…' : existing ? 'Save' : 'Add product'}</button>
        {onCancel && <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}
