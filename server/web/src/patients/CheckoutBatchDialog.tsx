import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { errorText, Modal, Notice, useInterval } from '../ui';
import { credits as creditsLabel, fmtDay, fmtMoney, fmtTime12, parseDollars } from '../lib';
import {
  ACCOUNT_CREDIT_LABEL, ADJUSTMENT_REASONS, betterOf, deskAdjustmentCap, INCREASE_REASONS, lineFigure, newKey, paymentShape, ratePercent, TENDERS, tenderLabel,
  withQuantity, type AdjustmentReason, type OpenLine, type Tender,
} from '../money';
import type { PatientLedger, LedgerVisit } from '../ledger';
import type { CheckoutPreview } from '../types';
import { ChargesPanel } from './Charges';
import { PatientLedger as LedgerView } from './Ledger';

/** A one-off change to a line's price: take money off (the desk, within its cap), or — an administrator only — raise it above list. */
interface Adjust { adjusting: boolean; dir: 'off' | 'raise'; adjCents: string; adjReason: AdjustmentReason; adjNote: string }
interface Line extends Adjust { include: boolean; pay: 'MONEY' | 'CREDITS' | 'PERK'; perkId: string; typedPrice: string }

const NO_ADJUST: Adjust = { adjusting: false, dir: 'off', adjCents: '', adjReason: 'SERVICE_RECOVERY', adjNote: '' };
const newLine = (include: boolean): Line => ({ include, pay: 'MONEY', perkId: '', typedPrice: '', ...NO_ADJUST });
/** The signed adjustment a line carries: positive takes money off, negative raises the price. */
const signed = (l: Adjust): number => (l.adjusting ? (parseDollars(l.adjCents) ?? 0) * (l.dir === 'raise' ? -1 : 1) : 0);
const adjustOk = (l: Adjust): boolean => !l.adjusting || ((parseDollars(l.adjCents) ?? 0) > 0 && (l.adjReason !== 'OTHER' || l.adjNote.trim() !== ''));
const adjustBody = (l: Adjust) => (signed(l) !== 0 ? { adjustment: { cents: signed(l), reason: l.adjReason, ...(l.adjNote.trim() ? { note: l.adjNote.trim() } : {}) } } : {});

interface ChargeResult { openChargeId: string; kind: 'SERVICE' | 'PRODUCT'; name: string; quantity: number; netPriceCents: number; taxRateMilli: number; taxCents: number; paymentType: string; memberBenefit: string | null; creditsRedeemed: number }
interface SettleResult {
  batchId: string | null;
  visits: Array<{ bookingId: string; netPriceCents: number; paymentType: string; memberBenefit: string | null; creditsRedeemed: number; promotion: { name: string; cents: number } | null; adjustmentCents: number }>;
  charges: ChargeResult[];
  accountCreditApplied: Array<{ revenueEventId: string; cents: number }>;
  payment: null | { id: string; tender: string; amountCents: number; collectedOn: string; refund: { tender: string; amountCents: number } | null; toAccountCreditCents: number };
  balanceCents: number;
  accountCreditCents: number;
}

const REFRESH_MS = 10_000;

/**
 * Check out one or more of a patient's visits and their add-on charges (services such as InBody, and products), and take a payment, in
 * ONE step (Phase 2b, rev 2.2; charges rev 2.3) — or, with nothing chosen, take a payment against what the patient owes. The server
 * prices everything and checks the Ledger version this screen was opened on: if anything changed meanwhile, it refuses and this screen
 * shows what is true now. It also re-reads every 10 seconds, so a charge added by a provider or another desk appears here at once.
 *
 * The bottom row, in order: Charges (add items), Ledger (the patient's Ledger, read only), Checkout, Card on File (not yet — it
 * activates once a card processor is chosen), Cancel. Charges and Ledger open inside this window and come back to it as it was.
 */
export function CheckoutBatchDialog({ patientId, preselect = [], mode = 'checkout', onClose, onDone }: {
  patientId: string; preselect?: string[]; mode?: 'checkout' | 'payment'; onClose: () => void; onDone: () => void;
}) {
  const { hasRole } = useAuth();
  const isAdmin = hasRole('ADMIN');
  const [ledger, setLedger] = useState<PatientLedger | null>(null);
  const [previews, setPreviews] = useState<Record<string, CheckoutPreview>>({});
  const [lines, setLines] = useState<Record<string, Line>>({});
  const [charges, setCharges] = useState<Record<string, Line>>({});
  const [view, setView] = useState<'form' | 'charges' | 'ledger'>('form');
  const [applyCredit, setApplyCredit] = useState('');
  const [tender, setTender] = useState<Tender>('CASH');
  const [amount, setAmount] = useState<string | null>(null);         // null: follow what is due
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [confirmPartial, setConfirmPartial] = useState(false);
  const [overAs, setOverAs] = useState<'REFUND' | 'ACCOUNT_CREDIT' | ''>('');
  const [refundTender, setRefundTender] = useState<Tender>('CASH');
  const [refundNote, setRefundNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SettleResult | null>(null);
  const key = useRef(newKey());
  const seq = useRef(0);

  const candidates: LedgerVisit[] = useMemo(() => (ledger && mode === 'checkout'
    ? [...ledger.todayVisits, ...ledger.priorVisits].filter((v) => v.state === 'ready_to_check_out')
      .sort((a, b) => (a.appointment.start < b.appointment.start ? -1 : 1))
    : []), [ledger, mode]);
  const openLines: OpenLine[] = mode === 'checkout' ? (ledger?.openCharges.lines ?? []) : [];

  /** Take a (re)read of the Ledger: new visits and new charges join with their defaults; what the desk already chose is kept. */
  const adopt = useCallback((l: PatientLedger, first: boolean) => {
    setLedger(l);
    setLines((cur) => {
      const next: Record<string, Line> = {};
      for (const v of [...l.todayVisits, ...l.priorVisits].filter((x) => x.state === 'ready_to_check_out')) {
        next[v.id] = cur[v.id] ?? newLine(first && preselect.length ? preselect.includes(v.id) : l.todayVisits.includes(v));
      }
      return next;
    });
    setCharges((cur) => Object.fromEntries(l.openCharges.lines.map((c) => [c.id, cur[c.id] ?? newLine(true)])));
  }, [preselect]);

  const reload = useCallback(async (first = false) => {
    const mine = ++seq.current;
    try {
      const l = await api<PatientLedger>(`/api/fd/patients/${patientId}/ledger`);
      if (mine === seq.current) adopt(l, first);
    } catch (e) { if (mine === seq.current && first) setError(errorText(e)); }
  }, [patientId, adopt]);

  useEffect(() => { void reload(true); }, [patientId]); // eslint-disable-line react-hooks/exhaustive-deps
  useInterval(() => { if (!busy && !result && view === 'form') void reload(); }, REFRESH_MS);
  useEffect(() => {
    const again = () => { if (document.visibilityState === 'visible' && !busy && !result) void reload(); };
    window.addEventListener('focus', again);
    return () => window.removeEventListener('focus', again);
  }, [reload, busy, result]);

  // Each visit's own check-out preview: its price, promotions, credit cost and perks — the same figures the server will use.
  useEffect(() => {
    for (const v of candidates) {
      if (previews[v.id]) continue;
      api<{ preview: CheckoutPreview }>(`/api/fd/appointments/${v.id}/checkout-preview`)
        .then((r) => setPreviews((p) => ({ ...p, [v.id]: r.preview }))).catch(() => undefined);
    }
  }, [candidates]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (id: string, patch: Partial<Line>) => setLines((l) => ({ ...l, [id]: { ...l[id]!, ...patch } }));
  const setCharge = (id: string, patch: Partial<Line>) => setCharges((l) => ({ ...l, [id]: { ...l[id]!, ...patch } }));

  /** What a visit comes to, as the server will price it — or null while a price still has to be typed. */
  function figure(v: LedgerVisit): { list: number | null; discount: number; promotion: { name: string; cents: number } | null; adjustment: number; net: number | null; cap: number | null } {
    const line = lines[v.id]; const pv = previews[v.id];
    if (!line || line.pay !== 'MONEY') return { list: null, discount: 0, promotion: null, adjustment: 0, net: 0, cap: null };
    if (!pv) return { list: null, discount: 0, promotion: null, adjustment: 0, net: null, cap: null };
    const list = pv.cash.priceKnown ? pv.cash.priceCents : parseDollars(line.typedPrice);
    if (list == null) return { list: null, discount: 0, promotion: null, adjustment: 0, net: null, cap: null };
    const red = betterOf(list, pv.cash.tierPercent, pv.cash.promotions);
    const adjustment = signed(line);
    return { list, discount: red.discountCents, promotion: red.promotion, adjustment, net: list - red.discountCents - (red.promotion?.cents ?? 0) - adjustment, cap: deskAdjustmentCap(list) };
  }
  /** What an add-on line comes to: its net and tax when paid in money; nothing in money when credits or a perk pay for it. */
  function chargeFigure(c: OpenLine) {
    const line = charges[c.id];
    if (!line || line.pay !== 'MONEY') return { discountCents: 0, promotion: null, adjustmentCents: 0, netCents: 0, taxCents: 0 };
    return lineFigure(c, signed(line));
  }

  const chosen = candidates.filter((v) => lines[v.id]?.include);
  const chosenCharges = openLines.filter((c) => charges[c.id]?.include);
  const figures = Object.fromEntries(chosen.map((v) => [v.id, figure(v)]));
  const chargeFigures = Object.fromEntries(chosenCharges.map((c) => [c.id, chargeFigure(c)]));
  const unpriced = chosen.some((v) => figures[v.id]!.net == null);
  const visitsTotal = chosen.reduce((n, v) => n + (figures[v.id]!.net ?? 0), 0);
  const chargesNet = chosenCharges.reduce((n, c) => n + chargeFigures[c.id]!.netCents, 0);
  const chargesTax = chosenCharges.reduce((n, c) => n + chargeFigures[c.id]!.taxCents, 0);
  const newCharges = visitsTotal + chargesNet + chargesTax;
  const carried = ledger?.money.balanceCents ?? 0;
  const due = carried + newCharges;
  const credit = Math.min(parseDollars(applyCredit) ?? 0, ledger?.money.accountCreditCents ?? 0, due);
  const dueAfterCredit = due - credit;
  const paying = amount === null ? dueAfterCredit : (parseDollars(amount) ?? 0);
  const shape = paymentShape(paying, dueAfterCredit);
  const ready = !!ledger && !unpriced && (mode === 'payment' || chosen.length + chosenCharges.length > 0)
    && (shape.kind !== 'partial' || confirmPartial) && (shape.kind !== 'over' || !!overAs)
    && (shape.kind !== 'over' || overAs !== 'REFUND' || refundTender !== 'OTHER' || refundNote.trim() !== '')
    && (tender !== 'OTHER' || shape.kind === 'none' || note.trim() !== '')
    && chosen.every((v) => adjustOk(lines[v.id]!)) && chosenCharges.every((c) => adjustOk(charges[c.id]!))
    && chosenCharges.every((c) => chargeFigures[c.id]!.netCents >= 0)
    && (mode === 'checkout' || paying > 0 || credit > 0);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready || !ledger) return;
    setBusy(true); setError(null);
    const body: Record<string, unknown> = {
      idempotencyKey: key.current, expectedVersion: ledger.money.version,
      ...(credit > 0 ? { applyAccountCreditCents: credit } : {}),
      ...(shape.kind !== 'none' ? { payment: { tender, amountCents: paying, ...(reference.trim() ? { reference: reference.trim() } : {}), ...(note.trim() ? { note: note.trim() } : {}) } } : {}),
      ...(shape.kind === 'partial' ? { confirmPartial: true } : {}),
      ...(shape.kind === 'over' ? { overpayment: overAs === 'REFUND' ? { as: 'REFUND', tender: refundTender, ...(refundNote.trim() ? { note: refundNote.trim() } : {}) } : { as: 'ACCOUNT_CREDIT' } } : {}),
    };
    if (mode === 'checkout') {
      body.visits = chosen.map((v) => {
        const line = lines[v.id]!; const f = figures[v.id]!; const pv = previews[v.id];
        return line.pay === 'CREDITS' ? { bookingId: v.id, pay: 'CREDITS' }
          : line.pay === 'PERK' ? { bookingId: v.id, pay: 'PERK', perkId: line.perkId }
          : { bookingId: v.id, pay: 'MONEY', ...(pv && !pv.cash.priceKnown && f.list ? { priceCents: f.list } : {}), ...(f.net != null ? { expectedNetCents: f.net } : {}), ...adjustBody(line) };
      });
      body.charges = chosenCharges.map((c) => {
        const line = charges[c.id]!;
        return line.pay === 'CREDITS' ? { openChargeId: c.id, pay: 'CREDITS' }
          : line.pay === 'PERK' ? { openChargeId: c.id, pay: 'PERK', perkId: line.perkId }
          : { openChargeId: c.id, pay: 'MONEY', expectedNetCents: chargeFigures[c.id]!.netCents, ...adjustBody(line) };
      });
    }
    try {
      setResult(await api<SettleResult>(`/api/fd/patients/${patientId}/${mode === 'checkout' ? 'checkout' : 'payments'}`, { method: 'POST', body }));
    } catch (err) {
      // 409: something changed — show it as it is now, and confirm again against that.
      if (err instanceof ApiError && err.status === 409 && (err.body as { ledger?: PatientLedger }).ledger) {
        adopt((err.body as { ledger: PatientLedger }).ledger, false);
        setPreviews({});
        key.current = newKey();
      }
      setError(errorText(err));
    } finally { setBusy(false); }
  }

  const title = mode === 'checkout' ? 'Check out' : 'Take a payment';
  if (result) return <Receipt result={result} mode={mode} visitNames={Object.fromEntries(candidates.map((v) => [v.id, v.service]))} onClose={() => { onDone(); onClose(); }} />;

  if (view === 'charges' && ledger) {
    return (
      <Modal title={`Charges — ${ledger.patient.name}`} wide onClose={() => { setView('form'); void reload(); }}>
        <ChargesPanel target={{ kind: 'desk', patientId }} />
        <div className="sheet-actions"><button type="button" className="btn primary" onClick={() => { setView('form'); void reload(); }}>Back to check-out</button></div>
      </Modal>
    );
  }
  if (view === 'ledger' && ledger) {
    return (
      <Modal title={`Ledger — ${ledger.patient.name}`} wide onClose={() => { setView('form'); void reload(); }}>
        <LedgerView patientId={patientId} readOnly />
        <div className="sheet-actions"><button type="button" className="btn primary" onClick={() => { setView('form'); void reload(); }}>Back to check-out</button></div>
      </Modal>
    );
  }

  return (
    <Modal title={`${title}${ledger ? ` — ${ledger.patient.name}` : ''}`} wide onClose={onClose}>
      {!ledger && !error && <p className="muted">Loading…</p>}
      {error && <Notice kind="error">{error}</Notice>}
      {ledger && (
        <form className="stack" onSubmit={(e) => void submit(e)}>
          {mode === 'checkout' && (candidates.length === 0 && openLines.length === 0 ? <p className="muted">No visit or item is waiting to be checked out. Add items with Charges.</p> : (
            <table className="table ledger-table">
              <thead><tr><th /><th>Visit or item</th><th>Pay with</th><th className="num">List</th><th className="num">Off</th><th className="num">Net</th><th className="num">Tax</th></tr></thead>
              <tbody>
                {candidates.map((v) => {
                  const line = lines[v.id]; const pv = previews[v.id]; const f = figure(v);
                  if (!line) return null;
                  return (
                    <tr key={v.id}>
                      <td><input type="checkbox" aria-label={`Include ${v.service}`} checked={line.include} onChange={(e) => set(v.id, { include: e.target.checked })} /></td>
                      <td>{v.localDate !== ledger.today && <>{fmtDay(v.localDate)} · </>}{fmtTime12(v.localStart)} · {v.service}{v.subOption ? ` · ${v.subOption}` : ''}
                        {v.provider && <div className="muted small">{v.provider}</div>}
                        {line.include && line.pay === 'MONEY' && <AdjustEditor line={line} cap={f.cap} isAdmin={isAdmin} onChange={(p) => set(v.id, p)} />}
                      </td>
                      <td>
                        <select value={line.pay} disabled={!line.include} onChange={(e) => set(v.id, { pay: e.target.value as Line['pay'], perkId: e.target.value === 'PERK' ? (pv?.perks[0]?.perkId ?? '') : '', ...NO_ADJUST })} aria-label="Pay with">
                          <option value="MONEY">Money</option>
                          {pv?.credits.cost != null && <option value="CREDITS" disabled={!pv.credits.available}>Membership credits ({creditsLabel(pv.credits.cost)})</option>}
                          {(pv?.perks.length ?? 0) > 0 && <option value="PERK">Member perk</option>}
                        </select>
                        {line.pay === 'PERK' && pv && (
                          <select value={line.perkId} onChange={(e) => set(v.id, { perkId: e.target.value })} aria-label="Perk">{pv.perks.map((p) => <option key={p.perkId} value={p.perkId}>{p.label}</option>)}</select>
                        )}
                      </td>
                      <td className="num">{line.pay !== 'MONEY' ? '—' : pv && !pv.cash.priceKnown
                        ? <label className="small">$<input inputMode="decimal" value={line.typedPrice} onChange={(e) => set(v.id, { typedPrice: e.target.value })} style={{ width: 80 }} aria-label="List price" /></label>
                        : fmtMoney(f.list)}</td>
                      <td className="num">{line.pay !== 'MONEY' ? '—' : <Off discount={f.discount} promotion={f.promotion} adjustment={f.adjustment} />}</td>
                      <td className="num">{line.include ? (f.net == null ? <span className="muted">price?</span> : fmtMoney(f.net)) : <span className="muted">—</span>}</td>
                      <td className="num muted">—</td>
                    </tr>
                  );
                })}
                {openLines.map((c) => {
                  const line = charges[c.id]; if (!line) return null;
                  const f = chargeFigure(c);
                  const product = c.kind === 'PRODUCT';
                  return (
                    <tr key={c.id}>
                      <td><input type="checkbox" aria-label={`Include ${c.name}`} checked={line.include} onChange={(e) => setCharge(c.id, { include: e.target.checked })} /></td>
                      <td>{withQuantity(c.name, c.quantity)} <span className="muted small">· {product ? 'product' : 'service add-on'}</span>
                        <div className="muted small">added{c.addedBy ? ` by ${c.addedBy}` : ''}{c.performedBy ? ` · performed by ${c.performedBy.name}` : ''}</div>
                        {line.include && line.pay === 'MONEY' && <AdjustEditor line={line} cap={c.adjustmentCapCents} isAdmin={isAdmin} onChange={(p) => setCharge(c.id, p)} />}
                      </td>
                      <td>
                        {product ? <span className="muted small">Money</span> : (<>
                          <select value={line.pay} disabled={!line.include} onChange={(e) => setCharge(c.id, { pay: e.target.value as Line['pay'], perkId: e.target.value === 'PERK' ? (c.perks?.[0]?.perkId ?? '') : '', ...NO_ADJUST })} aria-label="Pay with">
                            <option value="MONEY">Money</option>
                            {c.credits?.cost != null && <option value="CREDITS" disabled={!c.credits.available}>Membership credits ({creditsLabel(c.credits.cost)})</option>}
                            {(c.perks?.length ?? 0) > 0 && <option value="PERK">Member perk</option>}
                          </select>
                          {line.pay === 'PERK' && <select value={line.perkId} onChange={(e) => setCharge(c.id, { perkId: e.target.value })} aria-label="Perk">{c.perks!.map((p) => <option key={p.perkId} value={p.perkId}>{p.label}</option>)}</select>}
                        </>)}
                      </td>
                      <td className="num">{line.pay !== 'MONEY' ? '—' : <>{fmtMoney(c.listCents)}{c.quantity > 1 && <div className="muted small">{c.quantity} × {fmtMoney(c.unitPriceCents)}</div>}</>}</td>
                      <td className="num">{line.pay !== 'MONEY' ? '—' : <Off discount={f.discountCents} promotion={f.promotion} adjustment={f.adjustmentCents} tierPercent={c.tierPercent} />}</td>
                      <td className="num">{line.include ? (f.netCents < 0 ? <span className="error small">below zero</span> : fmtMoney(f.netCents)) : <span className="muted">—</span>}</td>
                      <td className="num">{line.include && c.taxRateMilli > 0 ? <>{fmtMoney(f.taxCents)}<div className="muted small">{ratePercent(c.taxRateMilli)}</div></> : <span className="muted">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ))}

          <dl className="facts money-due">
            {carried > 0 && (<><dt>Carried forward</dt><dd>{fmtMoney(carried)} owed from earlier — paid first</dd></>)}
            {mode === 'checkout' && (<><dt>Today</dt><dd>{unpriced ? 'enter the price above' : <>{fmtMoney(newCharges)}{chargesTax > 0 && <span className="muted"> · sales tax {fmtMoney(chargesTax)} included</span>}</>}</dd></>)}
            <dt>Due now</dt><dd><strong>{fmtMoney(due)}</strong></dd>
            {(ledger.money.accountCreditCents > 0) && (<>
              <dt>{ACCOUNT_CREDIT_LABEL}</dt>
              <dd>{fmtMoney(ledger.money.accountCreditCents)} held · apply $<input inputMode="decimal" value={applyCredit} onChange={(e) => setApplyCredit(e.target.value)} style={{ width: 80 }} aria-label="Account credit to apply" />
                {' '}<button type="button" className="linklike small" onClick={() => setApplyCredit((Math.min(ledger.money.accountCreditCents, due) / 100).toFixed(2))}>use what covers it</button></dd>
            </>)}
          </dl>

          <fieldset className="pay-box">
            <legend>Payment</legend>
            <div className="form-grid two">
              <label>Amount $<input inputMode="decimal" value={amount ?? (dueAfterCredit / 100).toFixed(2)} onChange={(e) => setAmount(e.target.value)} /></label>
              <label>Tender<select value={tender} onChange={(e) => setTender(e.target.value as Tender)}>{TENDERS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select></label>
              <label>Reference <span className="muted small">(check or terminal receipt number — never a card number)</span><input value={reference} maxLength={60} onChange={(e) => setReference(e.target.value)} /></label>
              <label>Note{tender === 'OTHER' && <span className="error small"> required for Other</span>}<input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} /></label>
            </div>
            <p className="hint">Recorded by hand: nothing is charged from here, and no card details are kept.</p>
            {shape.kind === 'partial' && (
              <label className="check"><input type="checkbox" checked={confirmPartial} onChange={(e) => setConfirmPartial(e.target.checked)} />
                The patient is paying part now. {fmtMoney(shape.restCents)} carries forward and shows on their Ledger.</label>
            )}
            {shape.kind === 'over' && (
              <div className="stack">
                <p><strong>{fmtMoney(shape.restCents)} more than is due.</strong> Ask the patient:</p>
                <label className="check"><input type="radio" name="over" checked={overAs === 'REFUND'} onChange={() => setOverAs('REFUND')} /> Refund it now, in
                  <select value={refundTender} onChange={(e) => setRefundTender(e.target.value as Tender)} aria-label="Refund tender">{TENDERS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select></label>
                {overAs === 'REFUND' && (
                  <label>Refund note{refundTender === 'OTHER' && <span className="error small"> required for Other</span>}
                    <input value={refundNote} maxLength={200} onChange={(e) => setRefundNote(e.target.value)} placeholder={refundTender === 'OTHER' ? 'How the difference was handed back' : 'Optional'} /></label>
                )}
                <label className="check"><input type="radio" name="over" checked={overAs === 'ACCOUNT_CREDIT'} onChange={() => setOverAs('ACCOUNT_CREDIT')} /> Keep it as {ACCOUNT_CREDIT_LABEL.toLowerCase()} for a future visit</label>
              </div>
            )}
            {shape.kind === 'none' && mode === 'checkout' && <p className="hint">No payment: the whole amount carries forward on the Ledger.</p>}
          </fieldset>

          {/* Rev 2.3: Charges, Ledger, Checkout, Card on File, Cancel — in that order. */}
          <div className="sheet-actions checkout-actions">
            {mode === 'checkout' && <button type="button" className="btn" disabled={busy} onClick={() => setView('charges')}>Charges</button>}
            <button type="button" className="btn" disabled={busy} onClick={() => setView('ledger')}>Ledger</button>
            <button className="btn primary" disabled={!ready || busy}>{busy ? 'Saving…' : mode === 'checkout' ? 'Checkout' : 'Record payment'}</button>
            <button type="button" className="btn" disabled title="Card on File activates once a card processor is chosen.">Card on File</button>
            <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          </div>
          <p className="hint small">Card on File activates once a card processor is chosen.</p>
        </form>
      )}
    </Modal>
  );
}

function Off({ discount, promotion, adjustment, tierPercent }: { discount: number; promotion: { name: string; cents: number } | null; adjustment: number; tierPercent?: number }) {
  return (<>
    {discount > 0 && <div>−{fmtMoney(discount)} <span className="muted small">tier{tierPercent ? ` ${tierPercent}%` : ''}</span></div>}
    {promotion && <div>−{fmtMoney(promotion.cents)} <span className="muted small">{promotion.name}</span></div>}
    {adjustment > 0 && <div>−{fmtMoney(adjustment)} <span className="muted small">adjustment</span></div>}
    {adjustment < 0 && <div>+{fmtMoney(-adjustment)} <span className="muted small">price raised</span></div>}
    {!discount && !promotion && !adjustment && <span className="muted">—</span>}
  </>);
}

/**
 * The fee edit (rev 2.2 decision 3; rev 2.3 decision 5): take money off — the front desk up to its cap, an administrator beyond it — or,
 * for an administrator only, raise the price above list. A reason always; a note for Other. The list price itself is never edited.
 */
function AdjustEditor({ line, cap, isAdmin, onChange }: { line: Adjust; cap: number | null; isAdmin: boolean; onChange: (p: Partial<Adjust>) => void }) {
  if (!line.adjusting) return <div className="small"><button type="button" className="linklike small" onClick={() => onChange({ adjusting: true })}>Edit fee…</button></div>;
  const cents = parseDollars(line.adjCents) ?? 0;
  const over = line.dir === 'off' && cap != null && cents > cap;
  const reasons = line.dir === 'raise' ? INCREASE_REASONS : ADJUSTMENT_REASONS;
  return (
    <div className="small adjust-row">
      {isAdmin ? (
        <select value={line.dir} onChange={(e) => onChange({ dir: e.target.value as Adjust['dir'], adjReason: e.target.value === 'raise' ? 'EXTENDED_SERVICE' : 'SERVICE_RECOVERY' })} aria-label="Take off or raise">
          <option value="off">Take off</option><option value="raise">Raise by</option>
        </select>
      ) : <span>Take off</span>}
      <label>$<input inputMode="decimal" value={line.adjCents} onChange={(e) => onChange({ adjCents: e.target.value })} style={{ width: 80 }} aria-label="Amount" /></label>
      <select value={line.adjReason} onChange={(e) => onChange({ adjReason: e.target.value as AdjustmentReason })} aria-label="Reason">
        {reasons.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
      </select>
      <input placeholder={line.adjReason === 'OTHER' ? 'Why (required)' : 'Note (optional)'} value={line.adjNote} maxLength={200} onChange={(e) => onChange({ adjNote: e.target.value })} />
      <button type="button" className="linklike small" onClick={() => onChange(NO_ADJUST)}>remove</button>
      {line.dir === 'raise'
        ? <div className="hint">Raises the price above list for this line only — administrators only. The list price is not changed.</div>
        : cap != null && <div className={over ? 'error small' : 'hint'}>{over ? (isAdmin ? `Above the front desk's limit of ${fmtMoney(cap)} — allowed for an administrator.` : `The front desk may take off at most ${fmtMoney(cap)} here (20% of the list price or $25.00, whichever is less). An administrator must make a larger adjustment.`) : `Up to ${fmtMoney(cap)} at the front desk.`}</div>}
    </div>
  );
}

/** The receipt: every visit and every item by name, each product's tax on its own line (decision 6), then what was paid. */
function Receipt({ result, mode, visitNames, onClose }: { result: SettleResult; mode: 'checkout' | 'payment'; visitNames: Record<string, string>; onClose: () => void }) {
  const tax = result.charges.reduce((n, c) => n + c.taxCents, 0);
  const inMoney = result.visits.reduce((n, v) => n + v.netPriceCents, 0) + result.charges.reduce((n, c) => n + c.netPriceCents, 0);
  const covered = (x: { paymentType: string; memberBenefit: string | null; creditsRedeemed: number }) => (x.paymentType === 'MEMBER' ? (x.memberBenefit === 'PERK' ? 'member perk' : creditsLabel(x.creditsRedeemed)) : null);
  return (
    <Modal title={mode === 'checkout' ? 'Checked out — receipt' : 'Payment recorded'} wide onClose={onClose}>
      {(result.visits.length > 0 || result.charges.length > 0) && (
        <table className="table ledger-table receipt">
          <thead><tr><th>Item</th><th className="num">Amount</th></tr></thead>
          <tbody>
            {result.visits.map((v) => <tr key={v.bookingId}><td>{visitNames[v.bookingId] ?? 'Visit'}</td><td className="num">{covered(v) ?? fmtMoney(v.netPriceCents)}</td></tr>)}
            {result.charges.flatMap((c) => [
              <tr key={c.openChargeId}><td>{withQuantity(c.name, c.quantity)}</td><td className="num">{covered(c) ?? fmtMoney(c.netPriceCents)}</td></tr>,
              ...(c.taxCents > 0 ? [<tr key={`${c.openChargeId}:tax`} className="muted"><td>Sales tax {ratePercent(c.taxRateMilli)} — {withQuantity(c.name, c.quantity)}</td><td className="num">{fmtMoney(c.taxCents)}</td></tr>] : []),
            ])}
          </tbody>
          <tfoot><tr className="carried"><td><strong>Total</strong>{tax > 0 && <span className="muted small"> · sales tax {fmtMoney(tax)}</span>}</td><td className="num"><strong>{fmtMoney(inMoney + tax)}</strong></td></tr></tfoot>
        </table>
      )}
      <dl className="facts">
        {result.accountCreditApplied.length > 0 && (<><dt>{ACCOUNT_CREDIT_LABEL}</dt><dd>{fmtMoney(result.accountCreditApplied.reduce((n, x) => n + x.cents, 0))} applied</dd></>)}
        {result.payment && (<><dt>Paid</dt><dd>{fmtMoney(result.payment.amountCents)} — {tenderLabel(result.payment.tender).toLowerCase()}</dd></>)}
        {result.payment?.refund && (<><dt>Refunded</dt><dd>{fmtMoney(result.payment.refund.amountCents)} — {tenderLabel(result.payment.refund.tender).toLowerCase()}. Hand it back now.</dd></>)}
        {result.payment && result.payment.toAccountCreditCents > 0 && (<><dt>Kept on account</dt><dd>{fmtMoney(result.payment.toAccountCreditCents)} as {ACCOUNT_CREDIT_LABEL.toLowerCase()}</dd></>)}
        <dt>Balance</dt><dd><strong>{result.balanceCents > 0 ? `${fmtMoney(result.balanceCents)} still owed — it carries forward` : 'Nothing owed'}</strong></dd>
        {result.accountCreditCents > 0 && (<><dt>{ACCOUNT_CREDIT_LABEL}</dt><dd>{fmtMoney(result.accountCreditCents)} held for the patient</dd></>)}
      </dl>
      <div className="sheet-actions"><button className="btn primary" onClick={onClose}>Done</button></div>
    </Modal>
  );
}
