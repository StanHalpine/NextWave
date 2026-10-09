import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { errorText, Notice, sourceLabel } from '../ui';
import { ageOn, fmtDayLong, fmtInstantTime, fmtPhone } from '../lib';
import type { Patient, Visit } from '../types';
import { todayIn, useClinicTz } from '../clinic';
import { PatientFields, changedFields, draftFrom } from '../patients/PatientForm';
import { NewAppointmentDialog } from '../schedule/dialogs';
import CreditTracker from '../patients/CreditTracker';
import FrontDeskNav from './FrontDeskNav';

type Tab = 'details' | 'visits' | 'credits';

export default function PatientProfile() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const { hasRole } = useAuth();
  const [patient, setPatient] = useState<Patient | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('details');
  const [booking, setBooking] = useState(false);
  const tz = useClinicTz();
  const today = todayIn(tz);

  const load = useCallback(() => api<{ patient: Patient }>(`/api/fd/patients/${id}`).then((r) => { setPatient(r.patient); setError(null); }).catch((e) => setError(errorText(e))), [id]);
  useEffect(() => { void load(); }, [load]);

  if (error) {
    return (<><FrontDeskNav /><Notice kind="error">{error}</Notice><p><Link to="/front-desk/patients">← Back to patients</Link></p></>);
  }
  if (!patient) return <><FrontDeskNav /><p className="muted">Loading…</p></>;

  return (
    <>
      <FrontDeskNav />
      <p className="crumb"><Link to="/front-desk/patients">← Patients</Link></p>
      <div className="page-head">
        <div>
          <h1>{patient.firstName} {patient.lastName}{patient.preferredName && <span className="muted"> “{patient.preferredName}”</span>}</h1>
          <p className="lede">
            {patient.dateOfBirth ? `Born ${patient.dateOfBirth} (age ${ageOn(patient.dateOfBirth, today)}) · ` : ''}
            {fmtPhone(patient.phone)}{patient.email ? ` · ${patient.email}` : ''}
          </p>
        </div>
        <button className="btn primary" onClick={() => setBooking(true)}>+ Book appointment</button>
      </div>

      <div className="tabs" role="tablist">
        {([['details', 'Details'], ['visits', 'Visits'], ['credits', 'Credit tracker']] as const).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>

      {tab === 'details' && <Details patient={patient} onSaved={setPatient} isAdmin={hasRole('ADMIN')} onDeleted={() => nav('/front-desk/patients')} tz={tz} />}
      {tab === 'visits' && <Visits patientId={patient.id} tz={tz} />}
      {tab === 'credits' && <CreditTracker patientId={patient.id} />}

      {booking && (
        <NewAppointmentDialog
          initial={{ patient: { id: patient.id, name: `${patient.firstName} ${patient.lastName}` } }}
          onClose={() => setBooking(false)}
          onCreated={() => { setBooking(false); setTab('visits'); }}
        />
      )}
    </>
  );
}

// ---- details + consent ---------------------------------------------------------

function Details({ patient, onSaved, isAdmin, onDeleted, tz }: { patient: Patient; onSaved: (p: Patient) => void; isAdmin: boolean; onDeleted: () => void; tz: string }) {
  const saved = useMemo(() => draftFrom(patient), [patient]);
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);

  const changes = changedFields(saved, draft);
  const dirty = Object.keys(changes).length > 0;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!dirty) return;
    setBusy(true); setMsg(null);
    try {
      const r = await api<{ patient: Patient }>(`/api/fd/patients/${patient.id}`, { method: 'PATCH', body: changes });
      onSaved(r.patient);
      setMsg({ kind: 'info', text: 'Saved.' });
    } catch (err) { setMsg({ kind: 'error', text: errorText(err) }); }
    finally { setBusy(false); }
  }

  async function remove() {
    if (!window.confirm(`Remove ${patient.firstName} ${patient.lastName} from the directory? Their history and audit trail are kept.`)) return;
    try { await api(`/api/fd/patients/${patient.id}`, { method: 'DELETE', body: {} }); onDeleted(); }
    catch (err) { setMsg({ kind: 'error', text: errorText(err) }); }
  }

  return (
    <div className="stack">
      <form className="card wide-card" onSubmit={(e) => void save(e)}>
        <h2>Contact and demographics</h2>
        <PatientFields draft={draft} set={setDraft} />
        {msg && <p className={msg.kind === 'error' ? 'error' : 'ok-text'} role={msg.kind === 'error' ? 'alert' : 'status'}>{msg.text}</p>}
        <div className="sheet-actions">
          <button className="btn primary" disabled={!dirty || busy}>{busy ? 'Saving…' : 'Save changes'}</button>
          <button type="button" className="btn ghost" disabled={!dirty} onClick={() => setDraft(saved)}>Discard</button>
        </div>
      </form>

      <TextConsent patient={patient} onChanged={onSaved} tz={tz} />

      {isAdmin && (
        <div className="card wide-card danger-zone">
          <h2>Remove patient</h2>
          <p className="hint">Hides the record from the directory. Visit history and the audit trail are kept. Not possible while upcoming appointments exist.</p>
          <button className="btn" onClick={() => void remove()}>Remove from directory</button>
        </div>
      )}
    </div>
  );
}

function TextConsent({ patient, onChanged, tz }: { patient: Patient; onChanged: (p: Patient) => void; tz: string }) {
  const [source, setSource] = useState<'verbal' | 'written' | 'online' | 'other'>('verbal');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function record(optIn: boolean) {
    setBusy(true); setError(null);
    try {
      const r = await api<{ patient: Patient }>(`/api/fd/patients/${patient.id}/sms-consent`, { method: 'POST', body: { optIn, source } });
      onChanged(r.patient);
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }

  return (
    <div className="card wide-card">
      <h2>Appointment texts</h2>
      <p>
        {patient.smsOptIn
          ? <><span className="pill ok">consented</span> {patient.smsOptInAt && <span className="muted small">recorded {fmtInstantTime(patient.smsOptInAt, tz)} on {new Date(patient.smsOptInAt).toLocaleDateString('en-US', { timeZone: tz })}</span>}</>
          : <><span className="pill off">no consent on file</span> <span className="muted small">No texts are sent to this patient.</span></>}
      </p>
      <p className="hint">
        A confirmation when an appointment is booked and a reminder the day before. Each text contains only the patient’s first
        name, the date and the time, and ends “Reply STOP to opt out.” Record consent only after the patient has agreed.
      </p>
      <div className="inline-row">
        <label>How was it given?
          <select value={source} onChange={(e) => setSource(e.target.value as typeof source)}>
            <option value="verbal">Verbally</option><option value="written">On a signed form</option>
            <option value="online">Online</option><option value="other">Other</option>
          </select>
        </label>
        {patient.smsOptIn
          ? <button className="btn" disabled={busy} onClick={() => void record(false)}>Record opt-out</button>
          : <button className="btn primary" disabled={busy} onClick={() => void record(true)}>Record consent to texts</button>}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

// ---- visits ------------------------------------------------------------------

const VISIT_STATUS: Record<string, string> = { CONFIRMED: 'Confirmed', PENDING_REVIEW: 'Awaiting approval', CANCELLED: 'Cancelled' };
const ENC_LABEL: Record<string, string> = { CHECKED_IN: 'Checked in', IN_PROGRESS: 'In progress', SEEN: 'Seen', CHECKED_OUT: 'Checked out', NO_SHOW: 'No-show' };

function Visits({ patientId, tz }: { patientId: string; tz: string }) {
  const [visits, setVisits] = useState<Visit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ visits: Visit[] }>(`/api/fd/patients/${patientId}/visits`).then((r) => setVisits(r.visits)).catch((e) => setError(errorText(e)));
  }, [patientId]);

  if (error) return <Notice kind="error">{error}</Notice>;
  if (!visits) return <p className="muted">Loading…</p>;
  const dayOf = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(iso)); // YYYY-MM-DD in clinic time
  return (
    <table className="table">
      <thead><tr><th>When</th><th>Service</th><th>Provider</th><th>Status</th><th>Booked</th></tr></thead>
      <tbody>
        {visits.map((v) => (
          <tr key={v.id} className={v.status === 'CANCELLED' ? 'off' : ''}>
            <td>{fmtDayLong(dayOf(v.start))}<br /><span className="muted small">{fmtInstantTime(v.start, tz)}</span></td>
            <td>{v.service}{v.subOption && <span className="muted small"><br />{v.subOption}</span>}</td>
            <td>{v.provider ?? <span className="muted">—</span>}</td>
            <td>
              {v.encounterStatus && ENC_LABEL[v.encounterStatus]
                ? <span className={`pill ${v.encounterStatus === 'NO_SHOW' ? 'bad' : 'ok'}`}>{ENC_LABEL[v.encounterStatus]}</span>
                : <span className={`pill ${v.status === 'CANCELLED' ? 'off' : v.status === 'PENDING_REVIEW' ? 'warn' : ''}`}>{VISIT_STATUS[v.status] ?? v.status}</span>}
            </td>
            <td className="muted small">{sourceLabel(v.source)}</td>
          </tr>
        ))}
        {visits.length === 0 && <tr><td colSpan={5} className="muted">No appointments yet.</td></tr>}
      </tbody>
    </table>
  );
}
