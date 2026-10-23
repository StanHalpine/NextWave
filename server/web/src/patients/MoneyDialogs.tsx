import { useRef, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { errorText, Modal, Notice } from '../ui';
import { fmtMoney, parseDollars } from '../lib';
import { ACCOUNT_CREDIT_LABEL, newKey, REVERSAL_REASONS, TENDERS, tenderLabel, type ReversalReason, type Tender } from '../money';
import type { PatientLedger } from '../ledger';

/**
 * Reverse a payment (decision 6): the front desk on the clinic day it was taken, an administrator after that. The payment is not
 * deleted — a reversal row is added beside it, and whatever it paid is owed again. The server enforces who may.
 */
export function ReversePaymentDialog({ patientId, payment, version, onClose, onDone }: {
  patientId: string; payment: { id: string; tender: string; totalCents: number; date: string }; version: string; onClose: () => void; onDone: () => void;
}) {
  const [reason, setReason] = useState<ReversalReason>('ENTERED_IN_ERROR');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(newKey());

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api(`/api/fd/patients/${patientId}/payments/${payment.id}/reverse`, { method: 'POST', body: { idempotencyKey: key.current, expectedVersion: version, reason, ...(note.trim() ? { note: note.trim() } : {}) } });
      onDone(); onClose();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) key.current = newKey();
      setError(errorText(err));
    } finally { setBusy(false); }
  }

  return (
    <Modal title="Reverse a payment" onClose={onClose}>
      <form className="stack" onSubmit={(e) => void submit(e)}>
        <p>{fmtMoney(payment.totalCents)} — {tenderLabel(payment.tender).toLowerCase()}, taken {payment.date}.</p>
        <p className="hint">The payment stays on the record, marked reversed; what it paid is owed again. Nothing is refunded from here.</p>
        <label>Why<select value={reason} onChange={(e) => setReason(e.target.value as ReversalReason)}>{REVERSAL_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}</select></label>
        <label>Note{reason === 'OTHER' && <span className="error small"> required for Other</span>}<input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} /></label>
        {error && <Notice kind="error">{error}</Notice>}
        <div className="sheet-actions">
          <button className="btn primary" disabled={busy || (reason === 'OTHER' && !note.trim())}>{busy ? 'Reversing…' : 'Reverse payment'}</button>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

/** An administrator hands a patient's ACCOUNT CREDIT ($) back (decision 4). Membership credits are never refunded here. */
export function RefundAccountCreditDialog({ patientId, ledger, onClose, onDone }: { patientId: string; ledger: PatientLedger; onClose: () => void; onDone: () => void }) {
  const held = ledger.money.accountCreditCents;
  const [amount, setAmount] = useState((held / 100).toFixed(2));
  const [tender, setTender] = useState<Tender>('CASH');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(newKey());
  const cents = parseDollars(amount);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!cents) return;
    setBusy(true); setError(null);
    try {
      await api(`/api/fd/patients/${patientId}/account-credit/refund`, { method: 'POST', body: { idempotencyKey: key.current, expectedVersion: ledger.money.version, amountCents: cents, tender, ...(note.trim() ? { note: note.trim() } : {}) } });
      onDone(); onClose();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) key.current = newKey();
      setError(errorText(err));
    } finally { setBusy(false); }
  }

  return (
    <Modal title={`Refund ${ACCOUNT_CREDIT_LABEL.toLowerCase()}`} onClose={onClose}>
      <form className="stack" onSubmit={(e) => void submit(e)}>
        <p>{fmtMoney(held)} of {ACCOUNT_CREDIT_LABEL.toLowerCase()} is held for {ledger.patient.name}. Membership credits are not affected.</p>
        <div className="form-grid two">
          <label>Amount $<input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
          <label>Paid back in<select value={tender} onChange={(e) => setTender(e.target.value as Tender)}>{TENDERS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select></label>
        </div>
        <label>Note{tender === 'OTHER' && <span className="error small"> required for Other</span>}<input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} /></label>
        {error && <Notice kind="error">{error}</Notice>}
        <div className="sheet-actions">
          <button className="btn primary" disabled={busy || !cents || cents > held || (tender === 'OTHER' && !note.trim())}>{busy ? 'Refunding…' : 'Record refund'}</button>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
