import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { errorText, Modal, Notice } from '../ui';
import { credits as creditsLabel, fmtDay, fmtMoney, fmtTime12, parseDollars } from '../lib';
import {
  ACCOUNT_CREDIT_LABEL, ADJUSTMENT_REASONS, betterOf, deskAdjustmentCap, newKey, paymentShape, TENDERS, tenderLabel, type AdjustmentReason, type Tender,
} from '../money';
import type { PatientLedger, LedgerVisit } from '../ledger';
import type { CheckoutPreview } from '../types';

interface Line {
  include: boolean;
  pay: 'MONEY' | 'CREDITS' | 'PERK';
  perkId: string;
  typedPrice: string;
  adjusting: boolean;
  adjCents: string;
  adjReason: AdjustmentReason;
  adjNote: string;
}

interface SettleResult {
  batchId: string | null;
  visits: Array<{ bookingId: string; netPriceCents: number; paymentType: string; memberBenefit: string | null; creditsRedeemed: number; promotion: { name: string; cents: number } | null; adjustmentCents: number }>;
  accountCreditApplied: Array<{ revenueEventId: string; cents: number }>;
  payment: null | { id: string; tender: string; amountCents: number; collectedOn: string; refund: { tender: string; amountCents: number } | null; toAccountCreditCents: number };
  balanceCents: number;
  accountCreditCents: number;
}

/**
 * Check out one or more of a patient's visits, and take a payment, in ONE step (Phase 2b, rev 2.2) — or, with no visit chosen, take a
 * payment against what the patient owes. The server prices everything and checks the Ledger version this screen was opened on: if
 * anything changed meanwhile (another desk, an admin), it refuses and this screen shows what is true now.
 *
 * Partial payments need the patient's agreement; more than is due needs their choice — a refund, or account credit in dollars (never
 * to be confused with membership credits). One idempotency key per opening of this screen, so a double click records one payment.
 */
export function CheckoutBatchDialog({ patientId, preselect = [], mode = 'checkout', onClose, onDone }: {
  patientId: string; preselect?: string[]; mode?: 'checkout' | 'payment'; onClose: () => void; onDone: () => void;
}) {
  const { hasRole } = useAuth();
  const isAdmin = hasRole('ADMIN');
  const [ledger, setLedger] = useState<PatientLedger | null>(null);
  const [previews, setPreviews] = useState<Record<string, CheckoutPreview>>({});
  const [lines, setLines] = useState<Record<string, Line>>({});
  const [applyCredit, setApplyCredit] = useState('');
  const [tender, setTender] = useState<Tender>('CASH');
  const [amount, setAmount] = useState<string | null>(null);         // null: follow what is due
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [confirmPartial, setConfirmPartial] = useState(false);
  const [overAs, setOverAs] = useState<'REFUND' | 'ACCOUNT_CREDIT' | ''>('');
  const [refundTender, setRefundTender] = useState<Tender>('CASH');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SettleResult | null>(null);
  const key = useRef(newKey());

  const candidates: LedgerVisit[] = useMemo(() => (ledger && mode === 'checkout'
    ? [...ledger.todayVisits, ...ledger.priorVisits].filter((v) => v.state === 'ready_to_check_out')
      .sort((a, b) => (a.appointment.start < b.appointment.start ? -1 : 1))
    : []), [ledger, mode]);

  useEffect(() => {
    api<PatientLedger>(`/api/fd/patients/${patientId}/ledger`).then((l) => {
      setLedger(l);
      const next: Record<string, Line> = {};
      for (const v of [...l.todayVisits, ...l.priorVisits].filter((x) => x.state === 'ready_to_check_out')) {
        next[v.id] = { include: preselect.length ? preselect.includes(v.id) : l.todayVisits.includes(v), pay: 'MONEY', perkId: '', typedPrice: '', adjusting: false, adjCents: '', adjReason: 'SERVICE_RECOVERY', adjNote: '' };
      }
      setLines(next);
    }).catch((e) => setError(errorText(e)));
  }, [patientId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Each visit's own check-out preview: its price, promotions, credit cost and perks — the same figures the server will use.
  useEffect(() => {
    for (const v of candidates) {
      if (previews[v.id]) continue;
      api<{ preview: CheckoutPreview }>(`/api/fd/appointments/${v.id}/checkout-preview`)
        .then((r) => setPreviews((p) => ({ ...p, [v.id]: r.preview }))).catch(() => undefined);
    }
  }, [candidates]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (id: string, patch: Partial<Line>) => setLines((l) => ({ ...l, [id]: { ...l[id]!, ...patch } }));

  /** What a visit comes to, as the server will price it — or null while a price still has to be typed. */
  function figure(v: LedgerVisit): { list: number | null; discount: number; promotion: { name: string; cents: number } | null; adjustment: number; net: number | null; cap: number | null } {
    const line = lines[v.id]; const pv = previews[v.id];
    if (!line || line.pay !== 'MONEY') return { list: null, discount: 0, promotion: null, adjustment: 0, net: 0, cap: null };
    if (!pv) return { list: null, discount: 0, promotion: null, adjustment: 0, net: null, cap: null };
    const list = pv.cash.priceKnown ? pv.cash.priceCents : parseDollars(line.typedPrice);
    if (list == null) return { list: null, discount: 0, promotion: null, adjustment: 0, net: null, cap: null };
    const red = betterOf(list, pv.cash.tierPercent, pv.cash.promotions);
    const adjustment = line.adjusting ? (parseDollars(line.adjCents) ?? 0) : 0;
    return { list, discount: red.discountCents, promotion: red.promotion, adjustment, net: list - red.discountCents - (red.promotion?.cents ?? 0) - adjustment, cap: deskAdjustmentCap(list) };
  }

  const chosen = candidates.filter((v) => lines[v.id]?.include);
  const figures = Object.fromEntries(chosen.map((v) => [v.id, figure(v)]));
  const unpriced = chosen.some((v) => figures[v.id]!.net == null);
  const newCharges = chosen.reduce((n, v) => n + (figures[v.id]!.net ?? 0), 0);
  const carried = ledger?.money.balanceCents ?? 0;
  const due = carried + newCharges;
  const credit = Math.min(parseDollars(applyCredit) ?? 0, ledger?.money.accountCreditCents ?? 0, due);
  const dueAfterCredit = due - credit;
  const paying = amount === null ? dueAfterCredit : (parseDollars(amount) ?? 0);
  const shape = paymentShape(paying, dueAfterCredit);
  const ready = !!ledger && !unpriced && (mode === 'payment' || chosen.length > 0)
    && (shape.kind !== 'partial' || confirmPartial) && (shape.kind !== 'over' || !!overAs)
    && (tender !== 'OTHER' || shape.kind === 'none' || note.trim() !== '')
    && chosen.every((v) => !lines[v.id]!.adjusting || ((parseDollars(lines[v.id]!.adjCents) ?? 0) > 0 && (lines[v.id]!.adjReason !== 'OTHER' || lines[v.id]!.adjNote.trim() !== '')))
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
      ...(shape.kind === 'over' ? { overpayment: overAs === 'REFUND' ? { as: 'REFUND', tender: refundTender } : { as: 'ACCOUNT_CREDIT' } } : {}),
    };
    if (mode === 'checkout') {
      body.visits = chosen.map((v) => {
        const line = lines[v.id]!; const f = figures[v.id]!; const pv = previews[v.id];
        return line.pay === 'CREDITS' ? { bookingId: v.id, pay: 'CREDITS' }
          : line.pay === 'PERK' ? { bookingId: v.id, pay: 'PERK', perkId: line.perkId }
          : { bookingId: v.id, pay: 'MONEY', ...(pv && !pv.cash.priceKnown && f.list ? { priceCents: f.list } : {}), ...(f.net != null ? { expectedNetCents: f.net } : {}),
              ...(line.adjusting && f.adjustment > 0 ? { adjustment: { cents: f.adjustment, reason: line.adjReason, ...(line.adjNote.trim() ? { note: line.adjNote.trim() } : {}) } } : {}) };
      });
    }
    try {
      setResult(await api<SettleResult>(`/api/fd/patients/${patientId}/${mode === 'checkout' ? 'checkout' : 'payments'}`, { method: 'POST', body }));
    } catch (err) {
      // 409: something changed — show it as it is now, and confirm again against that.
      if (err instanceof ApiError && err.status === 409 && (err.body as { ledger?: PatientLedger }).ledger) {
        setLedger((err.body as { ledger: PatientLedger }).ledger);
        setPreviews({});
        key.current = newKey();
      }
      setError(errorText(err));
    } finally { setBusy(false); }
  }

  const title = mode === 'checkout' ? 'Check out' : 'Take a payment';
  if (result) {
    return (
      <Modal title={mode === 'checkout' ? 'Checked out' : 'Payment recorded'} wide onClose={() => { onDone(); onClose(); }}>
        <dl className="facts">
          {result.visits.length > 0 && (<><dt>Visits</dt><dd>{result.visits.length} checked out — {fmtMoney(result.visits.reduce((n, v) => n + v.netPriceCents, 0))} charged in money{result.visits.some((v) => v.creditsRedeemed) && `, ${creditsLabel(result.visits.reduce((n, v) => n + v.creditsRedeemed, 0))} used`}</dd></>)}
          {result.accountCreditApplied.length > 0 && (<><dt>{ACCOUNT_CREDIT_LABEL}</dt><dd>{fmtMoney(result.accountCreditApplied.reduce((n, x) => n + x.cents, 0))} applied</dd></>)}
          {result.payment && (<><dt>Paid</dt><dd>{fmtMoney(result.payment.amountCents)} — {tenderLabel(result.payment.tender).toLowerCase()}</dd></>)}
          {result.payment?.refund && (<><dt>Refunded</dt><dd>{fmtMoney(result.payment.refund.amountCents)} — {tenderLabel(result.payment.refund.tender).toLowerCase()}. Hand it back now.</dd></>)}
          {result.payment && result.payment.toAccountCreditCents > 0 && (<><dt>Kept on account</dt><dd>{fmtMoney(result.payment.toAccountCreditCents)} as {ACCOUNT_CREDIT_LABEL.toLowerCase()}</dd></>)}
          <dt>Balance</dt><dd><strong>{result.balanceCents > 0 ? `${fmtMoney(result.balanceCents)} still owed — it carries forward` : 'Nothing owed'}</strong></dd>
          {result.accountCreditCents > 0 && (<><dt>{ACCOUNT_CREDIT_LABEL}</dt><dd>{fmtMoney(result.accountCreditCents)} held for the patient</dd></>)}
        </dl>
        <div className="sheet-actions"><button className="btn primary" onClick={() => { onDone(); onClose(); }}>Done</button></div>
      </Modal>
    );
  }

  return (
    <Modal title={`${title}${ledger ? ` — ${ledger.patient.name}` : ''}`} wide onClose={onClose}>
      {!ledger && !error && <p className="muted">Loading…</p>}
      {error && <Notice kind="error">{error}</Notice>}
      {ledger && (
        <form className="stack" onSubmit={(e) => void submit(e)}>
          {mode === 'checkout' && (candidates.length === 0 ? <p className="muted">No visit is waiting to be checked out.</p> : (
            <table className="table ledger-table">
              <thead><tr><th /><th>Visit</th><th>Pay with</th><th className="num">List</th><th className="num">Off</th><th className="num">Net</th></tr></thead>
              <tbody>
                {candidates.map((v) => {
                  const line = lines[v.id]; const pv = previews[v.id]; const f = figure(v);
                  if (!line) return null;
                  const over = line.adjusting && f.cap != null && f.adjustment > f.cap;
                  return (
                    <tr key={v.id}>
                      <td><input type="checkbox" aria-label={`Include ${v.service}`} checked={line.include} onChange={(e) => set(v.id, { include: e.target.checked })} /></td>
                      <td>{v.localDate !== ledger.today && <>{fmtDay(v.localDate)} · </>}{fmtTime12(v.localStart)} · {v.service}{v.subOption ? ` · ${v.subOption}` : ''}
                        {v.provider && <div className="muted small">{v.provider}</div>}
                        {line.include && line.pay === 'MONEY' && (
                          <div className="small">
                            {!line.adjusting ? <button type="button" className="linklike small" onClick={() => set(v.id, { adjusting: true })}>Adjust…</button> : (
                              <div className="adjust-row">
                                <label>Take off $<input inputMode="decimal" value={line.adjCents} onChange={(e) => set(v.id, { adjCents: e.target.value })} style={{ width: 80 }} /></label>
                                <select value={line.adjReason} onChange={(e) => set(v.id, { adjReason: e.target.value as AdjustmentReason })} aria-label="Reason">
                                  {ADJUSTMENT_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                                </select>
                                <input placeholder={line.adjReason === 'OTHER' ? 'Why (required)' : 'Note (optional)'} value={line.adjNote} maxLength={200} onChange={(e) => set(v.id, { adjNote: e.target.value })} />
                                <button type="button" className="linklike small" onClick={() => set(v.id, { adjusting: false, adjCents: '', adjNote: '' })}>remove</button>
                                {f.cap != null && <div className={over ? 'error small' : 'hint'}>{over ? (isAdmin ? `Above the front desk's limit of ${fmtMoney(f.cap)} — allowed for an administrator.` : `The front desk may take off at most ${fmtMoney(f.cap)} here (20% of the list price or $25.00, whichever is less). An administrator must make a larger adjustment.`) : `Up to ${fmtMoney(f.cap)} at the front desk.`}</div>}
                              </div>
                            )}
                          </div>
                        )}
                      </td>
                      <td>
                        <select value={line.pay} disabled={!line.include} onChange={(e) => set(v.id, { pay: e.target.value as Line['pay'], perkId: e.target.value === 'PERK' ? (pv?.perks[0]?.perkId ?? '') : '' })} aria-label="Pay with">
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
                      <td className="num">{line.pay !== 'MONEY' ? '—' : <>
                        {f.discount > 0 && <div>−{fmtMoney(f.discount)} <span className="muted small">tier</span></div>}
                        {f.promotion && <div>−{fmtMoney(f.promotion.cents)} <span className="muted small">{f.promotion.name}</span></div>}
                        {f.adjustment > 0 && <div>−{fmtMoney(f.adjustment)} <span className="muted small">adjustment</span></div>}
                        {!f.discount && !f.promotion && !f.adjustment && <span className="muted">—</span>}
                      </>}</td>
                      <td className="num">{line.include ? (f.net == null ? <span className="muted">price?</span> : fmtMoney(f.net)) : <span className="muted">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ))}

          <dl className="facts money-due">
            {carried > 0 && (<><dt>Carried forward</dt><dd>{fmtMoney(carried)} owed from earlier — paid first</dd></>)}
            {mode === 'checkout' && (<><dt>These visits</dt><dd>{unpriced ? 'enter the price above' : fmtMoney(newCharges)}</dd></>)}
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
                  <select value={refundTender} onChange={(e) => setRefundTender(e.target.value as Tender)} aria-label="Refund tender">{TENDERS.filter((t) => t.value !== 'OTHER').map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select></label>
                <label className="check"><input type="radio" name="over" checked={overAs === 'ACCOUNT_CREDIT'} onChange={() => setOverAs('ACCOUNT_CREDIT')} /> Keep it as {ACCOUNT_CREDIT_LABEL.toLowerCase()} for a future visit</label>
              </div>
            )}
            {shape.kind === 'none' && mode === 'checkout' && <p className="hint">No payment: the whole amount carries forward on the Ledger.</p>}
          </fieldset>

          <div className="sheet-actions">
            <button className="btn primary" disabled={!ready || busy}>{busy ? 'Saving…' : mode === 'checkout' ? `Check out${chosen.length > 1 ? ` ${chosen.length} visits` : ''}` : 'Record payment'}</button>
            <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          </div>
        </form>
      )}
    </Modal>
  );
}
