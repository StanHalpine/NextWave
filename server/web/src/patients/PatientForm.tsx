import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { errorText, Notice } from '../ui';
import { fmtPhone } from '../lib';
import type { Patient, PatientSummary } from '../types';

export interface PatientDraft {
  firstName: string; lastName: string; preferredName: string; dateOfBirth: string; sex: string;
  phone: string; email: string;
  addressLine1: string; addressLine2: string; city: string; state: string; postalCode: string;
  emergencyName: string; emergencyPhone: string; emergencyRelation: string;
  preferredContact: 'PHONE' | 'SMS' | 'EMAIL'; frontDeskNote: string;
}

const EMPTY: PatientDraft = {
  firstName: '', lastName: '', preferredName: '', dateOfBirth: '', sex: '', phone: '', email: '',
  addressLine1: '', addressLine2: '', city: '', state: 'MN', postalCode: '',
  emergencyName: '', emergencyPhone: '', emergencyRelation: '', preferredContact: 'PHONE', frontDeskNote: '',
};

export const draftFrom = (p?: Patient): PatientDraft => p ? {
  firstName: p.firstName, lastName: p.lastName, preferredName: p.preferredName ?? '', dateOfBirth: p.dateOfBirth ?? '', sex: p.sex ?? '',
  phone: p.phone, email: p.email ?? '',
  addressLine1: p.addressLine1 ?? '', addressLine2: p.addressLine2 ?? '', city: p.city ?? '', state: p.state ?? '', postalCode: p.postalCode ?? '',
  emergencyName: p.emergencyName ?? '', emergencyPhone: p.emergencyPhone ?? '', emergencyRelation: p.emergencyRelation ?? '',
  preferredContact: p.preferredContact, frontDeskNote: p.frontDeskNote ?? '',
} : EMPTY;

/** The API wants null, not '', for a date that was left blank. */
export const toBody = (d: PatientDraft) => ({ ...d, dateOfBirth: d.dateOfBirth || null });

/** Fields that differ from the saved record — an edit sends only these. */
export function changedFields(saved: PatientDraft, now: PatientDraft): Partial<ReturnType<typeof toBody>> {
  const a = toBody(saved) as Record<string, unknown>;
  const b = toBody(now) as Record<string, unknown>;
  return Object.fromEntries(Object.keys(b).filter((k) => a[k] !== b[k]).map((k) => [k, b[k]]));
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return <label className={className}>{label}{children}</label>;
}

/** The fields, controlled by the parent. Used for both new and existing patients. */
export function PatientFields({ draft, set }: { draft: PatientDraft; set: (d: PatientDraft) => void }) {
  const up = <K extends keyof PatientDraft>(k: K) => (e: { target: { value: string } }) => set({ ...draft, [k]: e.target.value } as PatientDraft);
  return (
    <div className="form-grid">
      <Field label="First name *"><input value={draft.firstName} onChange={up('firstName')} required maxLength={80} autoComplete="off" /></Field>
      <Field label="Last name *"><input value={draft.lastName} onChange={up('lastName')} required maxLength={80} autoComplete="off" /></Field>
      <Field label="Preferred name"><input value={draft.preferredName} onChange={up('preferredName')} maxLength={80} autoComplete="off" /></Field>
      <Field label="Date of birth"><input type="date" value={draft.dateOfBirth} onChange={up('dateOfBirth')} max={new Date().toISOString().slice(0, 10)} /></Field>
      <Field label="Phone *"><input type="tel" value={draft.phone} onChange={up('phone')} required placeholder="(612) 555-0142" autoComplete="off" /></Field>
      <Field label="Email"><input type="email" value={draft.email} onChange={up('email')} maxLength={254} autoComplete="off" /></Field>
      <Field label="Sex">
        <select value={draft.sex} onChange={up('sex')}>
          <option value="">—</option><option>Female</option><option>Male</option><option>Other</option>
        </select>
      </Field>
      <Field label="Prefers contact by">
        <select value={draft.preferredContact} onChange={up('preferredContact')}>
          <option value="PHONE">Phone call</option><option value="SMS">Text message</option><option value="EMAIL">Email</option>
        </select>
      </Field>
      <Field label="Address" className="span2"><input value={draft.addressLine1} onChange={up('addressLine1')} maxLength={120} autoComplete="off" /></Field>
      <Field label="Address line 2" className="span2"><input value={draft.addressLine2} onChange={up('addressLine2')} maxLength={120} autoComplete="off" /></Field>
      <Field label="City"><input value={draft.city} onChange={up('city')} maxLength={80} autoComplete="off" /></Field>
      <Field label="State"><input value={draft.state} onChange={up('state')} maxLength={40} autoComplete="off" /></Field>
      <Field label="ZIP"><input value={draft.postalCode} onChange={up('postalCode')} maxLength={20} autoComplete="off" /></Field>
      <span />
      <Field label="Emergency contact"><input value={draft.emergencyName} onChange={up('emergencyName')} maxLength={120} autoComplete="off" /></Field>
      <Field label="Emergency phone"><input type="tel" value={draft.emergencyPhone} onChange={up('emergencyPhone')} maxLength={40} autoComplete="off" /></Field>
      <Field label="Relationship"><input value={draft.emergencyRelation} onChange={up('emergencyRelation')} maxLength={60} autoComplete="off" /></Field>
      <span />
      <Field label="Front desk note" className="span4">
        <textarea value={draft.frontDeskNote} onChange={up('frontDeskNote')} maxLength={500} rows={2} />
        <span className="hint">Scheduling and courtesy only (“prefers mornings”). Health information belongs in a visit note, not here.</span>
      </Field>
    </div>
  );
}

/**
 * Create a patient, handling the "may already be on file" warning: the desk can open the
 * existing record, or confirm it is a different person and save anyway.
 */
export function NewPatientForm({ onCreated, onCancel, onUseExisting }: {
  onCreated: (p: Patient) => void;
  onCancel: () => void;
  onUseExisting?: (p: PatientSummary) => void;
}) {
  const [draft, setDraft] = useState<PatientDraft>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dupes, setDupes] = useState<PatientSummary[] | null>(null);

  async function submit(e: FormEvent, confirmNotDuplicate = false) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await api<{ patient: Patient }>('/api/fd/patients', { method: 'POST', body: { ...toBody(draft), ...(confirmNotDuplicate ? { confirmNotDuplicate: true } : {}) } });
      onCreated(r.patient);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'possible_duplicate') setDupes((err.body as { matches: PatientSummary[] }).matches);
      else setError(errorText(err));
    } finally { setBusy(false); }
  }

  return (
    <form onSubmit={(e) => void submit(e)}>
      {dupes && (
        <Notice kind="warn">
          <strong>This may be someone who is already on file:</strong>
          <ul className="plain">
            {dupes.map((d) => (
              <li key={d.id}>
                {d.name}{d.dateOfBirth ? ` · born ${d.dateOfBirth}` : ''} · {fmtPhone(d.phone)}
                {onUseExisting && <> <button type="button" className="linklike" onClick={() => onUseExisting(d)}>Use this patient</button></>}
              </li>
            ))}
          </ul>
          <button type="button" className="btn small" disabled={busy} onClick={(e) => void submit(e as unknown as FormEvent, true)}>This is a different person — save as new</button>
        </Notice>
      )}
      <PatientFields draft={draft} set={(d) => { setDraft(d); setDupes(null); }} />
      {error && <p className="error" role="alert">{error}</p>}
      <div className="sheet-actions">
        <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Save patient'}</button>
        <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
