import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { errorText, Modal, Notice, useInterval } from '../ui';
import { fmtInstantTime, fmtMoney } from '../lib';
import { newKey, ratePercent, type ChargeCatalog, type OpenLines } from '../money';

/** Where the lines are added from: the desk, by patient; or a provider's visit workspace, through that visit. */
export type ChargesTarget =
  | { kind: 'desk'; patientId: string }
  | { kind: 'provider'; bookingId: string; role?: string | null };

const REFRESH_MS = 10_000;

function urls(t: ChargesTarget) {
  if (t.kind === 'desk') {
    const base = `/api/fd/patients/${t.patientId}/charges`;
    return { list: base, add: base, remove: (id: string) => `${base}/${id}/remove`, quantity: (id: string) => `${base}/${id}/quantity` };
  }
  const base = `/api/provider/visits/${t.bookingId}/charges`;
  const q = t.role ? `?role=${encodeURIComponent(t.role)}` : '';
  return { list: `${base}${q}`, add: base, remove: (id: string) => `${base}/${id}/remove`, quantity: (id: string) => `${base}/${id}/quantity` };
}

/**
 * The Charges window (Phase 2c-A, SPEC rev 2.3): quick-add buttons by group — service add-ons such as InBody, then the products — and
 * the patient's open charges for the day, each removable until check-out, with the running subtotal, discounts, tax and total. A click
 * adds one: a new line, or one more on the item's line already open today (same price, same performer). Each line has a quantity, 1 to
 * 99. The server snapshots the name, price and tax rate, so a catalog edit later never changes a line. Nothing is paid
 * here: the lines are checked out with the visits at the desk. Re-reads every 10 seconds, so a line someone else adds appears.
 */
export function ChargesPanel({ target, onChanged }: { target: ChargesTarget; onChanged?: () => void }) {
  const { me } = useAuth();
  const [data, setData] = useState<(OpenLines & { catalog: ChargeCatalog; timezone: string }) | null>(null);
  const [group, setGroup] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const u = urls(target);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const r = await api<OpenLines & { catalog: ChargeCatalog; timezone: string }>(u.list);
      if (mine === seq.current) { setData(r); setError(null); }
    } catch (e) { if (mine === seq.current) setError(errorText(e)); }
  }, [u.list]);
  useEffect(() => { void load(); }, [load]);
  useInterval(() => { void load(); }, REFRESH_MS);

  const groups = data?.catalog.groups ?? [];
  const shown = groups.find((g) => g.name === group) ?? groups[0];

  async function addItem(item: { kind: 'SERVICE' | 'PRODUCT'; id: string }) {
    setBusy(item.id); setError(null);
    // A provider who adds a service add-on from their visit is recorded as the one who performed it (optional at the desk).
    const performer = target.kind === 'provider' && item.kind === 'SERVICE' && me?.account.staffId ? { performedByStaffId: me.account.staffId } : {};
    try {
      await api(u.add, { method: 'POST', body: { idempotencyKey: newKey(), ...(item.kind === 'SERVICE' ? { serviceId: item.id } : { productId: item.id }), ...performer, ...(target.kind === 'provider' && target.role ? { role: target.role } : {}) } });
      await load(); onChanged?.();
    } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
  }
  async function setQuantity(id: string, quantity: number) {
    setBusy(id); setError(null);
    try {
      await api(u.quantity(id), { method: 'POST', body: { idempotencyKey: newKey(), quantity, ...(target.kind === 'provider' && target.role ? { role: target.role } : {}) } });
      await load(); onChanged?.();
    } catch (e) { setError(errorText(e)); await load(); } finally { setBusy(null); }
  }
  async function removeLine(id: string) {
    setBusy(id); setError(null);
    try {
      await api(u.remove(id), { method: 'POST', body: { idempotencyKey: newKey(), ...(target.kind === 'provider' && target.role ? { role: target.role } : {}) } });
      await load(); onChanged?.();
    } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
  }

  if (!data) return error ? <Notice kind="error">{error}</Notice> : <p className="muted">Loading…</p>;
  const t = data.totals;
  return (
    <div className="stack charges">
      {error && <Notice kind="error">{error}</Notice>}
      {groups.length === 0 ? <p className="muted">Nothing is on the Charges menu yet. An administrator adds products on Admin → Catalog.</p> : (
        <>
          <div className="tabs" role="tablist" aria-label="Charge groups">
            {groups.map((g) => (
              <button key={g.name} type="button" role="tab" aria-selected={shown?.name === g.name} className={shown?.name === g.name ? 'on' : ''} onClick={() => setGroup(g.name)}>{g.name}</button>
            ))}
          </div>
          <div className="charge-grid">
            {shown?.items.map((i) => (
              <button key={i.id} type="button" className="charge-button" disabled={busy !== null} onClick={() => void addItem(i)}>
                <span className="charge-name">{i.name}</span>
                <span className="charge-price">{fmtMoney(i.priceCents)}{i.taxable && <span className="muted small"> + tax</span>}</span>
              </button>
            ))}
          </div>
        </>
      )}

      <h3>Today’s charges, not yet checked out</h3>
      {data.lines.length === 0 ? <p className="muted">None yet. Click an item above to add it.</p> : (
        <table className="table ledger-table">
          <thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Price</th><th className="num">Off</th><th className="num">Net</th><th className="num">Tax</th><th /></tr></thead>
          <tbody>
            {data.lines.map((l) => (
              <tr key={l.id}>
                <td>{l.name}{l.kind === 'SERVICE' && <span className="muted small"> · service</span>}
                  <div className="muted small">added {fmtInstantTime(l.addedAt, data.timezone)}{l.addedBy ? ` by ${l.addedBy}` : ''}{l.performedBy ? ` · performed by ${l.performedBy.name}` : ''}</div></td>
                <td className="num"><QuantityInput value={l.quantity} disabled={busy !== null} label={`Quantity of ${l.name}`} onCommit={(q) => void setQuantity(l.id, q)} /></td>
                <td className="num">{fmtMoney(l.listCents)}{l.quantity > 1 && <div className="muted small">{l.quantity} × {fmtMoney(l.unitPriceCents)}</div>}</td>
                <td className="num">
                  {l.discountCents > 0 && <div>−{fmtMoney(l.discountCents)} <span className="muted small">tier {l.discountPercent}%</span></div>}
                  {l.promotion && <div>−{fmtMoney(l.promotion.cents)} <span className="muted small">{l.promotion.name}</span></div>}
                  {!l.discountCents && !l.promotion && <span className="muted">—</span>}
                </td>
                <td className="num">{fmtMoney(l.netCents)}</td>
                <td className="num">{l.taxRateMilli > 0 ? <>{fmtMoney(l.taxCents)}<div className="muted small">{ratePercent(l.taxRateMilli)}</div></> : <span className="muted">—</span>}</td>
                <td><button type="button" className="btn small ghost" disabled={busy !== null} onClick={() => void removeLine(l.id)} aria-label={`Remove ${l.name}`}>Remove</button></td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr><td>Subtotal</td><td /><td className="num">{fmtMoney(t.listCents)}</td><td className="num">{t.discountCents + t.promotionCents > 0 ? `−${fmtMoney(t.discountCents + t.promotionCents)}` : '—'}</td><td className="num">{fmtMoney(t.netCents)}</td><td className="num">{fmtMoney(t.taxCents)}</td><td /></tr>
            <tr className="carried"><td colSpan={5}><strong>Total</strong> <span className="muted small">if paid in money — credits or a perk for a service are chosen at check-out</span></td><td className="num"><strong>{fmtMoney(t.totalCents)}</strong></td><td /></tr>
          </tfoot>
        </table>
      )}
      <p className="hint">Each click adds one — to the item’s line if it is already here. Nothing is paid here: these are checked out with today’s visits at the front desk, where a fee can be adjusted.</p>
    </div>
  );
}

/** A line's quantity, 1 to 99: saved when the box is left or Enter is pressed; anything else snaps back. */
function QuantityInput({ value, disabled, label, onCommit }: { value: number; disabled: boolean; label: string; onCommit: (q: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => { setText(String(value)); }, [value]);
  const commit = () => {
    const q = Number(text);
    if (/^\d{1,2}$/.test(text.trim()) && q >= 1 && q <= 99 && q !== value) onCommit(q);
    else setText(String(value));
  };
  return <input className="qty" inputMode="numeric" aria-label={label} value={text} disabled={disabled} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }} />;
}

/** The Charges window as its own dialog (the Front Desk card, a visit's dialog, the patient's Ledger, a provider's workspace). */
export function ChargesDialog({ target, title, onClose, onChanged }: { target: ChargesTarget; title?: string; onClose: () => void; onChanged?: () => void }) {
  return (
    <Modal title={title ?? 'Charges'} wide onClose={onClose}>
      <ChargesPanel target={target} onChanged={onChanged} />
      <div className="sheet-actions"><button type="button" className="btn primary" onClick={onClose}>Done</button></div>
    </Modal>
  );
}
