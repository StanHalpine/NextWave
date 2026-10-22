import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { errorText, Modal, Notice } from '../ui';
import { fmtTime12 } from '../lib';
import { roleName } from '../provider/docs';
import type { Appt } from '../types';
import { overlapWarning, type ProviderOptions } from '../coveringProvider';

/**
 * "Change provider…" (rev 2.1): who is seeing a checked-in patient instead of the provider they were booked with — a covering doctor.
 * That person becomes the visit's provider: only they can write and sign its note, and check-out records them. The booking itself (its
 * slot, the calendar column) is not changed, so the desk is shown the covering provider's other appointments at that time as a
 * warning — nothing stops it. Before check-in the provider is changed with Move instead, which checks they are free.
 */
export function ChangeProviderDialog({ appt, onClose, onChanged, onMove }: { appt: Appt; onClose: () => void; onChanged: () => void; onMove: () => void }) {
  const checkedIn = !!appt.encounter && appt.encounter.status !== 'SCHEDULED' && appt.encounter.status !== 'NO_SHOW';
  const [opts, setOpts] = useState<ProviderOptions | null>(null);
  const [staffId, setStaffId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftBy, setDraftBy] = useState<{ message: string } | null>(null);
  const [confirmDraft, setConfirmDraft] = useState(false);

  useEffect(() => {
    if (!checkedIn) return;
    api<ProviderOptions>(`/api/fd/appointments/${appt.id}/provider-options`)
      .then((r) => { setOpts(r); setStaffId(r.currentId ?? ''); })
      .catch((e) => setError(errorText(e)));
  }, [appt.id, checkedIn]);

  if (!checkedIn) {
    return (
      <Modal title="Change provider" onClose={onClose}>
        <div className="stack">
          <p>{appt.patient.name} has not been checked in yet. Change the provider with <strong>Move…</strong>: it checks that they are free at that time.</p>
          <div className="sheet-actions">
            <button className="btn primary" onClick={onMove}>Move…</button>
            <button className="btn ghost" onClick={onClose}>Close</button>
          </div>
        </div>
      </Modal>
    );
  }

  const chosen = opts?.options.find((o) => o.id === staffId);
  const warning = chosen ? overlapWarning(chosen) : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!staffId) return;
    setBusy(true); setError(null);
    try {
      await api(`/api/fd/appointments/${appt.id}/provider`, { method: 'POST', body: { staffId, ...(confirmDraft ? { confirmDraft: true } : {}) } });
      onChanged();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'draft_open') setDraftBy({ message: err.message });
      else setError(errorText(err));
    } finally { setBusy(false); }
  }

  return (
    <Modal title="Change provider" onClose={onClose}>
      <form className="stack" onSubmit={(e) => void submit(e)}>
        <p className="lede"><strong>{appt.patient.name}</strong> · {appt.service.name} · {fmtTime12(appt.localStart)}–{fmtTime12(appt.localEnd)}</p>
        <p className="hint">Who is seeing this patient. They become the visit’s provider: only they can write and sign its note, and check-out records them.
          The appointment stays where it is on the Schedule{appt.staff ? ` (${appt.staff.name}’s column)` : ''}.</p>
        {!opts && !error && <p className="muted">Loading…</p>}
        {opts && opts.signed && <Notice kind="warn">The note is already signed, so the provider can no longer be changed.</Notice>}
        {opts && !opts.signed && (
          <label>Provider
            <select value={staffId} onChange={(e) => { setStaffId(e.target.value); setDraftBy(null); setConfirmDraft(false); }} required>
              {opts.options.map((o) => (
                <option key={o.id} value={o.id}>{o.name} · {roleName(o.role)}{o.isScheduled ? ' (booked)' : ''}{o.isCurrent && !o.isScheduled ? ' (covering now)' : ''}</option>
              ))}
            </select>
          </label>
        )}
        {warning && <Notice kind="warn">{warning}</Notice>}
        {draftBy && (
          <Notice kind="warn">
            {draftBy.message}
            <label className="check small"><input type="checkbox" checked={confirmDraft} onChange={(e) => setConfirmDraft(e.target.checked)} /> Change the provider anyway</label>
          </Notice>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="sheet-actions">
          <button className="btn primary" disabled={busy || !opts || opts.signed || !staffId || staffId === opts.currentId || (!!draftBy && !confirmDraft)}>
            {busy ? 'Saving…' : 'Change provider'}
          </button>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
