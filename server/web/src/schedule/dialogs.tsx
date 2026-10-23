import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useClinicTz, todayIn } from '../clinic';
import { errorText, Modal, NotePill, Notice, ServiceDot, sourceLabel } from '../ui';
import { fmtDayLong, fmtTime12, fmtInstantTime, fmtPhone, nowHHMM, serviceLabel, toMinutes } from '../lib';
import { CANCEL_REASON_LABEL, type Appt, type PatientSummary, type ServiceLite, type SlotLite } from '../types';
import { PatientPicker } from '../patients/PatientPicker';
import { CheckoutDialog } from './CheckoutDialog';
import { CheckoutBatchDialog } from '../patients/CheckoutBatchDialog';
import { DeskActions } from './DeskActions';
import { PatientLedger } from '../patients/Ledger';
import { visitStateLabel, type DeskVerb } from '../frontdesk';
import { ChangeProviderDialog } from './ChangeProviderDialog';
import { providerLine } from '../coveringProvider';

interface SlotsResponse { date: string; durationMin: number; closedReason: string | null; slots: SlotLite[]; staff: Array<{ id: string; name: string }> }

/** Open starts for a service and day, from the server's own booking engine. */
function useSlots(serviceId: string, date: string, forAppointmentId?: string) {
  const [data, setData] = useState<SlotsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!serviceId || !date) { setData(null); return; }
    let live = true;
    setLoading(true);
    const q = new URLSearchParams({ serviceId, date, ...(forAppointmentId ? { forAppointmentId } : {}) });
    api<SlotsResponse>(`/api/schedule/slots?${q}`)
      .then((r) => { if (live) { setData(r); setError(null); } })
      .catch((e) => { if (live) { setData(null); setError(errorText(e)); } })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [serviceId, date, forAppointmentId, nonce]);

  return { data, error, loading, reload: () => setNonce((n) => n + 1) };
}

function SlotGrid({ slots, value, onChange }: { slots: SlotLite[]; value: string; onChange: (start: string) => void }) {
  return (
    <div className="slot-grid" role="radiogroup" aria-label="Available times">
      {slots.map((s) => (
        <button key={s.start} type="button" role="radio" aria-checked={value === s.start} className={`slot${value === s.start ? ' on' : ''}`} onClick={() => onChange(s.start)}>
          {fmtTime12(s.localTime)}
        </button>
      ))}
    </div>
  );
}

function ProviderSelect({ slot, staff, value, onChange, keepLabel }: {
  slot: SlotLite | undefined; staff: Array<{ id: string; name: string }>; value: string; onChange: (v: string) => void; keepLabel: string;
}) {
  const options = slot ? staff.filter((s) => slot.staffIds.includes(s.id)) : [];
  return (
    <label>Provider
      <select value={value} onChange={(e) => onChange(e.target.value)} disabled={!slot}>
        <option value="">{keepLabel}</option>
        {options.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
    </label>
  );
}

// ---- new appointment ------------------------------------------------------------

export function NewAppointmentDialog({ initial, onClose, onCreated }: {
  initial?: { patient?: { id: string; name: string }; date?: string; time?: string; staffId?: string; serviceId?: string };
  onClose: () => void;
  onCreated: (a: Appt) => void;
}) {
  const tz = useClinicTz();
  const [patient, setPatient] = useState(initial?.patient ?? null);
  const [services, setServices] = useState<ServiceLite[]>([]);
  const [serviceId, setServiceId] = useState(initial?.serviceId ?? '');
  const [subOption, setSubOption] = useState('');
  const [date, setDate] = useState(initial?.date ?? '');
  const [start, setStart] = useState('');
  const [staffId, setStaffId] = useState(initial?.staffId ?? '');
  const [source, setSource] = useState<'PHONE' | 'FRONT_DESK'>('PHONE');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { api<{ services: ServiceLite[] }>('/api/services').then((r) => setServices(r.services)).catch((e) => setError(errorText(e))); }, []);
  useEffect(() => { if (!date) setDate(todayIn(tz)); }, [tz, date]);

  const service = services.find((s) => s.id === serviceId);
  const { data, error: slotError, loading, reload } = useSlots(serviceId, date);
  const slot = data?.slots.find((s) => s.start === start);

  // When the list of times changes, keep the chosen time if still offered, else pre-pick the one asked for.
  useEffect(() => {
    if (!data) return;
    if (start && data.slots.some((s) => s.start === start)) return;
    const hinted = initial?.time ? data.slots.find((s) => s.localTime === initial.time) : undefined;
    setStart(hinted?.start ?? '');
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (staffId && slot && !slot.staffIds.includes(staffId)) setStaffId(''); }, [slot, staffId]);

  const grouped = useMemo(() => {
    const m = new Map<string, ServiceLite[]>();
    for (const s of services) m.set(s.category, [...(m.get(s.category) ?? []), s]);
    return [...m.entries()];
  }, [services]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!patient || !serviceId || !start) return;
    setBusy(true); setError(null);
    try {
      const r = await api<{ appointment: Appt }>('/api/schedule/appointments', {
        method: 'POST',
        body: { serviceId, start, patientId: patient.id, source, ...(subOption ? { subOption } : {}), ...(staffId ? { staffId } : {}) },
      });
      onCreated(r.appointment);
    } catch (err) {
      setError(errorText(err));
      if (err instanceof ApiError && err.status === 409) { setStart(''); reload(); }
    } finally { setBusy(false); }
  }

  return (
    <Modal title="New appointment" wide onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} className="stack">
        <div><div className="label-like">Patient</div><PatientPicker value={patient} onPick={setPatient} /></div>
        <div className="form-grid two">
          <label>Service
            <select value={serviceId} onChange={(e) => { setServiceId(e.target.value); setSubOption(''); setStart(''); }} required>
              <option value="">— choose —</option>
              {grouped.map(([cat, list]) => (
                <optgroup key={cat} label={cat}>{list.map((s) => <option key={s.id} value={s.id}>{serviceLabel(s)}</option>)}</optgroup>
              ))}
            </select>
          </label>
          {service && service.options.length > 0 && (
            <label>Option
              <select value={subOption} onChange={(e) => setSubOption(e.target.value)}>
                <option value="">—</option>
                {service.options.map((o) => <option key={o.label} value={o.label}>{o.label}</option>)}
              </select>
            </label>
          )}
          <label>Date
            <input type="date" value={date} min={todayIn(tz)} onChange={(e) => { setDate(e.target.value); setStart(''); }} required />
          </label>
          <label>Booked by
            <select value={source} onChange={(e) => setSource(e.target.value as typeof source)}>
              <option value="PHONE">Phone call</option><option value="FRONT_DESK">In person</option>
            </select>
          </label>
        </div>

        <div>
          <div className="label-like">Time {date && <span className="muted small">· {fmtDayLong(date)}</span>}</div>
          {!serviceId && <p className="hint">Choose a service to see open times.</p>}
          {serviceId && loading && <p className="hint">Looking…</p>}
          {slotError && <p className="error" role="alert">{slotError}</p>}
          {data && data.slots.length === 0 && <p className="hint">{data.closedReason ?? 'Nothing open that day.'} Try another date.</p>}
          {data && data.slots.length > 0 && <SlotGrid slots={data.slots} value={start} onChange={setStart} />}
        </div>

        {data && <ProviderSelect slot={slot} staff={data.staff} value={staffId} onChange={setStaffId} keepLabel="Any available" />}

        {error && <p className="error" role="alert">{error}</p>}
        <div className="sheet-actions">
          <button className="btn primary" disabled={busy || !patient || !serviceId || !start}>{busy ? 'Booking…' : 'Book appointment'}</button>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

// ---- move --------------------------------------------------------------------------

export function MoveDialog({ appt, onClose, onMoved }: { appt: Appt; onClose: () => void; onMoved: (a: Appt) => void }) {
  const tz = useClinicTz();
  const [date, setDate] = useState(appt.localDate);
  const [start, setStart] = useState('');
  const [staffId, setStaffId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { data, error: slotError, loading, reload } = useSlots(appt.service.id, date, appt.id);
  const slot = data?.slots.find((s) => s.start === start);

  useEffect(() => { if (data && start && !data.slots.some((s) => s.start === start)) setStart(''); }, [data, start]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!start) return;
    setBusy(true); setError(null);
    try {
      const r = await api<{ appointment: Appt }>(`/api/schedule/appointments/${appt.id}/move`, { method: 'POST', body: { start, ...(staffId ? { staffId } : {}) } });
      onMoved(r.appointment);
    } catch (err) {
      setError(errorText(err));
      if (err instanceof ApiError && err.status === 409) { setStart(''); reload(); }
    } finally { setBusy(false); }
  }

  return (
    <Modal title="Move appointment" wide onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} className="stack">
        <p className="lede">
          <strong>{appt.patient.name}</strong> · {appt.service.name}<br />
          Now: {fmtDayLong(appt.localDate)}, {fmtTime12(appt.localStart)}{appt.staff ? ` with ${appt.staff.name}` : ''}
        </p>
        <label>Move to
          <input type="date" value={date} min={todayIn(tz)} onChange={(e) => { setDate(e.target.value); setStart(''); }} required />
        </label>
        <div>
          <div className="label-like">Time</div>
          {loading && <p className="hint">Looking…</p>}
          {slotError && <p className="error" role="alert">{slotError}</p>}
          {data && data.slots.length === 0 && <p className="hint">{data.closedReason ?? 'Nothing open that day.'} Try another date.</p>}
          {data && data.slots.length > 0 && <SlotGrid slots={data.slots} value={start} onChange={setStart} />}
        </div>
        {data && <ProviderSelect slot={slot} staff={data.staff} value={staffId} onChange={setStaffId} keepLabel={appt.staff ? `Keep ${appt.staff.name} if free` : 'Any available'} />}
        <p className="hint">Times that overlap the current booking are offered — it won’t conflict with itself. If the new time can’t be confirmed, nothing changes.</p>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="sheet-actions">
          <button className="btn primary" disabled={busy || !start}>{busy ? 'Moving…' : 'Move appointment'}</button>
          <button type="button" className="btn ghost" onClick={onClose}>Keep as is</button>
        </div>
      </form>
    </Modal>
  );
}

// ---- cancel ------------------------------------------------------------------------

export function CancelDialog({ appt, onClose, onCancelled }: { appt: Appt; onClose: () => void; onCancelled: (a: Appt) => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await api<{ appointment: Appt }>(`/api/schedule/appointments/${appt.id}/cancel`, { method: 'POST', body: { reason } });
      onCancelled(r.appointment);
    } catch (err) { setError(errorText(err)); }
    finally { setBusy(false); }
  }

  return (
    <Modal title="Cancel appointment" onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} className="stack">
        <p><strong>{appt.patient.name}</strong> · {appt.service.name}<br /><span className="muted">{fmtDayLong(appt.localDate)}, {fmtTime12(appt.localStart)}</span></p>
        <label>Reason
          <select value={reason} onChange={(e) => setReason(e.target.value)} required>
            <option value="">— choose —</option>
            {Object.entries(CANCEL_REASON_LABEL).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
          <span className="hint">Recorded as a category only. Don’t type health details here.</span>
        </label>
        <p className="hint">The patient is not sent a text about the cancellation — let them know by phone.</p>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="sheet-actions">
          <button className="btn primary" disabled={busy || !reason}>{busy ? 'Cancelling…' : 'Cancel appointment'}</button>
          <button type="button" className="btn ghost" onClick={onClose}>Keep appointment</button>
        </div>
      </form>
    </Modal>
  );
}

// ---- link an online booking to a patient record ----------------------------------------

export function LinkPatientDialog({ appt, onClose, onLinked }: { appt: Appt; onClose: () => void; onLinked: () => void }) {
  const [info, setInfo] = useState<{ contact: { name: string; phone: string; email: string | null }; matches: PatientSummary[] } | null>(null);
  const [chosen, setChosen] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<NonNullable<typeof info>>(`/api/fd/bookings/${appt.id}/patient-matches`).then(setInfo).catch((e) => setError(errorText(e)));
  }, [appt.id]);

  async function link(patientId: string) {
    setBusy(true); setError(null);
    try { await api(`/api/fd/bookings/${appt.id}/link-patient`, { method: 'POST', body: { patientId } }); onLinked(); }
    catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }

  return (
    <Modal title="Link to a patient record" wide onClose={onClose}>
      <div className="stack">
        {info && (
          <p className="lede">
            Booked online as <strong>{info.contact.name}</strong> · {fmtPhone(info.contact.phone)}{info.contact.email ? ` · ${info.contact.email}` : ''}.
            Linking lets the patient be checked in and receive appointment texts (once they have consented).
          </p>
        )}
        {info && info.matches.length > 0 && (
          <div>
            <div className="label-like">Possible matches</div>
            <ul className="results static">
              {info.matches.map((m) => (
                <li key={m.id}>
                  <button type="button" disabled={busy} onClick={() => void link(m.id)}>
                    <strong>{m.name}</strong> <span className="muted small">{m.dateOfBirth ? `born ${m.dateOfBirth} · ` : ''}{fmtPhone(m.phone)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div>
          <div className="label-like">{info && info.matches.length > 0 ? 'Or find someone else' : 'Find or add the patient'}</div>
          <PatientPicker value={chosen} onPick={setChosen} />
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="sheet-actions">
          <button className="btn primary" disabled={!chosen || busy} onClick={() => chosen && void link(chosen.id)}>Link to {chosen ? chosen.name : 'patient'}</button>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </Modal>
  );
}

// ---- one appointment: details and actions ---------------------------------------------------

interface Detail {
  appointment: Appt; contact: { name: string; phone: string; email: string | null }; patientNote: string | null;
  messages: Array<{ kind: string; status: string; forStart: string; sentAt: string | null; failureCode: string | null; deliveryStatus: string | null }>;
}

const MSG_KIND: Record<string, string> = { CONFIRMATION: 'Confirmation text', REMINDER_24H: 'Reminder text' };
function msgSummary(m: Detail['messages'][number], tz: string): string {
  if (m.status === 'SENT') {
    // What the provider has reported since (status callbacks); nothing until it does.
    const delivery = m.deliveryStatus === 'delivered' ? ' · delivered' : m.deliveryStatus === 'undelivered' || m.deliveryStatus === 'failed' ? ' · not delivered' : '';
    return `sent${m.sentAt ? ` ${fmtInstantTime(m.sentAt, tz)}` : ''}${delivery}`;
  }
  if (m.status === 'QUEUED') return 'queued — will retry';
  if (m.status === 'SKIPPED') return `not sent (${(m.failureCode ?? 'skipped').replace(/_/g, ' ')})`;
  return `failed (${(m.failureCode ?? 'error').replace(/_/g, ' ')})`;
}

/**
 * One appointment: its details and what can be done with it.
 *
 * `desk` is set when the dialog is opened FROM the Front Desk page. There the front-desk actions (check in, undo check-in, check
 * out, no-show) are the dialog's own buttons, and nothing links to the page it is already on. From the Schedule it is the calendar's
 * dialog: it can check a patient in, and a visit that has started points to the Front Desk, where it is finished.
 */
export function AppointmentDialog({ id, today, desk = false, onClose, onChanged }: { id: string; today: string; desk?: boolean; onClose: () => void; onChanged: () => void }) {
  const tz = useClinicTz();
  const nav = useNavigate();
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sub, setSub] = useState<null | 'move' | 'cancel' | 'link' | 'checkout' | 'ledger' | 'provider'>(null);
  // A dialog the Ledger opened (check out, take a payment, reverse, refund) — shown INSTEAD of the Ledger, never on top of it.
  const [ledgerDialog, setLedgerDialog] = useState<ReactNode | null>(null);

  const load = useCallback(() => api<Detail>(`/api/schedule/appointments/${id}`).then((r) => { setD(r); setError(null); }).catch((e) => setError(errorText(e))), [id]);
  useEffect(() => { void load(); }, [load]);

  const changed = () => { onChanged(); void load(); };
  async function run(path: string, method = 'POST', body: unknown = {}) {
    setBusy(true); setError(null);
    try { await api(path, { method, body }); changed(); }
    catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }

  const a = d?.appointment;
  const started = a?.encounter && a.encounter.status !== 'SCHEDULED' && a.encounter.status !== 'NO_SHOW';
  const isToday = a?.localDate === today;

  if (sub === 'move' && a) return <MoveDialog appt={a} onClose={() => setSub(null)} onMoved={() => { setSub(null); changed(); }} />;
  if (sub === 'cancel' && a) return <CancelDialog appt={a} onClose={() => setSub(null)} onCancelled={() => { setSub(null); changed(); }} />;
  if (sub === 'link' && a) return <LinkPatientDialog appt={a} onClose={() => setSub(null)} onLinked={() => { setSub(null); changed(); }} />;
  // Phase 2b: a visit with a patient record is checked out with the combined check-out (payment, partial, account credit); a walk-up
  // with no record keeps the single-visit check-out, which records the charge only (there is no patient to take a payment against).
  if (sub === 'checkout' && a) {
    return a.patient.id
      ? <CheckoutBatchDialog patientId={a.patient.id} preselect={[a.id]} onClose={() => setSub(null)} onDone={changed} />
      : <CheckoutDialog appt={a} onClose={() => setSub(null)} onDone={changed} />;
  }
  if (sub === 'provider' && a) return <ChangeProviderDialog appt={a} onClose={() => setSub(null)} onChanged={changed} onMove={() => setSub('move')} />;
  // The patient's ledger, from this visit's dialog: the same view as the profile's Ledger tab. A dialog started from it replaces it (never
  // two dialogs on top of each other) and returns to it when closed, showing what was just recorded.
  if (sub === 'ledger' && a?.patient.id) {
    if (ledgerDialog) return <>{ledgerDialog}</>;
    return (
      <Modal title={`Ledger — ${a.patient.name}`} wide onClose={() => setSub(null)}>
        <PatientLedger patientId={a.patient.id} onDialog={setLedgerDialog} onChanged={changed} />
      </Modal>
    );
  }

  return (
    <Modal title="Appointment" onClose={onClose}>
      {error && <Notice kind="error">{error}</Notice>}
      {!a && !error && <p className="muted">Loading…</p>}
      {a && d && (
        <div className="stack">
          <div className="appt-title">
            <ServiceDot color={a.service.color} />
            <div>
              <strong>{a.service.name}</strong>{a.subOption && <span className="muted"> · {a.subOption}</span>}
              <div className="muted small">{fmtDayLong(a.localDate)} · {fmtTime12(a.localStart)} – {fmtTime12(a.localEnd)}</div>
            </div>
            <StatusPill appt={a} />
          </div>

          <dl className="facts">
            <dt>Patient</dt>
            <dd>
              {a.patient.id ? <Link to={`/front-desk/patients/${a.patient.id}`} onClick={onClose}>{a.patient.name}</Link> : a.patient.name}
              {!a.patient.linked && <> <span className="pill warn">not linked to a record</span></>}
            </dd>
            <dt>Provider</dt><dd>{a.staff || a.covering ? providerLine(a) : '—'}</dd>
            <dt>Room</dt><dd>{a.resource.name}</dd>
            {a.note && (<><dt>Note</dt><dd><NotePill note={a.note} doc={a.documentation.status} />
              {a.note === 'PENDING' && <span className="muted small"> · check-out does not wait for it; the provider signs it from their Unsigned notes list</span>}</dd></>)}
            <dt>Booked</dt><dd>{sourceLabel(a.source)}</dd>
            {!a.patient.linked && (<><dt>Contact</dt><dd>{d.contact.name} · {fmtPhone(d.contact.phone)}{d.contact.email ? ` · ${d.contact.email}` : ''}</dd></>)}
            {d.patientNote && (<><dt>Patient’s note</dt><dd>{d.patientNote}</dd></>)}
            {a.patientConfirmedAt && (<><dt>Patient</dt><dd>Replied <strong>C</strong> to confirm ({fmtInstantTime(a.patientConfirmedAt, tz)})</dd></>)}
            <dt>Texts</dt>
            <dd>
              {d.messages.length === 0
                ? <span className="muted">{a.patient.texts ? `None sent yet (consent ${a.patient.texts === 'online' ? 'given on the booking form' : 'recorded on the patient profile'})` : a.patient.linked ? 'No consent on file — no texts' : 'No consent — none was given on the booking form'}</span>
                : <ul className="plain">{d.messages.map((m, i) => <li key={i}>{MSG_KIND[m.kind] ?? m.kind}: {msgSummary(m, tz)}</li>)}</ul>}
            </dd>
          </dl>

          {a.status === 'PENDING_REVIEW' && (
            <Notice kind="warn">An online request waiting for a decision. Approving checks the room is still free.</Notice>
          )}

          <div className="sheet-actions">
            {a.status === 'PENDING_REVIEW' && (<>
              <button className="btn primary" disabled={busy} onClick={() => void run(`/api/bookings/${a.id}`, 'PATCH', { status: 'CONFIRMED' })}>Approve</button>
              <button className="btn" disabled={busy} onClick={() => void run(`/api/bookings/${a.id}`, 'PATCH', { status: 'DECLINED' })}>Decline</button>
            </>)}
            {desk && (
              <DeskActions a={a} ctx={{ isToday, nowMin: isToday ? toMinutes(nowHHMM(tz)) : null }} busy={busy}
                onVerb={(v: DeskVerb) => void run(`/api/fd/appointments/${a.id}/${v}`)} onCheckout={() => setSub('checkout')} onLink={() => setSub('link')} />
            )}
            {!desk && a.status === 'CONFIRMED' && isToday && !a.encounter?.status.match(/CHECKED|SEEN|PROGRESS/) && (
              <button className="btn primary" disabled={busy || !a.patient.linked} title={a.patient.linked ? '' : 'Link a patient record first'} onClick={() => void run(`/api/fd/appointments/${a.id}/check-in`)}>Check in</button>
            )}
            {(a.status === 'CONFIRMED' || a.status === 'PENDING_REVIEW') && !started && (<>
              <button className="btn" disabled={busy} onClick={() => setSub('move')}>Move…</button>
              <button className="btn" disabled={busy} onClick={() => setSub('cancel')}>Cancel…</button>
            </>)}
            {desk && a.status === 'CONFIRMED' && a.note !== 'SIGNED' && a.encounter?.status !== 'NO_SHOW' && (
              <button className="btn small" disabled={busy} onClick={() => setSub('provider')}>Change provider…</button>
            )}
            {desk && a.patient.linked && a.patient.id && <button className="btn small" disabled={busy} onClick={() => setSub('ledger')}>Ledger…</button>}
            {!desk && !a.patient.linked && a.status !== 'CANCELLED' && <button className="btn" disabled={busy} onClick={() => setSub('link')}>Link patient…</button>}
            {!desk && started && <button className="btn" onClick={() => { onClose(); nav('/front-desk'); }}>Open on Front Desk</button>}
          </div>
          {started && <p className="hint">{startedHint(a, desk)}</p>}
        </div>
      )}
    </Modal>
  );
}

/** Why a visit that has started can't be moved or cancelled, and what to do about it from where the person is. */
function startedHint(a: Appt, desk: boolean): string {
  const enc = a.encounter!.status;
  const where = desk ? 'here' : 'on the Front Desk page';
  if (enc === 'CHECKED_IN') return `This patient is checked in, so the visit can’t be moved or cancelled. Undo the check-in ${where} first.`;
  if (enc === 'CHECKED_OUT') return 'This visit is checked out, so it can’t be moved or cancelled.';
  if (enc === 'SEEN') return `The provider has seen this patient, so the visit can’t be moved or cancelled. It still needs to be checked out${desk ? '.' : ' on the Front Desk page.'}`;
  return `This patient is with the provider, so the visit can’t be moved or cancelled. It is checked out ${where} when they are finished.`;
}

export function StatusPill({ appt }: { appt: Appt }) {
  const enc = appt.encounter?.status;
  if (enc === 'CHECKED_IN' || enc === 'IN_PROGRESS') return <span className="pill ok">{visitStateLabel(appt)}</span>;
  // "Seen" is NOT finished: the provider has signed, but nothing is recorded until the front desk checks the patient out.
  if (enc === 'SEEN') return <span className="pill warn" title="The provider has signed. The visit is finished only once it is checked out.">{visitStateLabel(appt)}</span>;
  if (enc === 'CHECKED_OUT') return <span className="pill ok">{visitStateLabel(appt)}</span>;
  if (enc === 'NO_SHOW') return <span className="pill bad">No-show</span>;
  switch (appt.status) {
    case 'PENDING_REVIEW': return <span className="pill warn">Needs approval</span>;
    case 'HOLD': return <span className="pill off">Held</span>;
    case 'CANCELLED': return <span className="pill off">Cancelled</span>;
    case 'DECLINED': return <span className="pill off">Declined</span>;
    default: return <span className="pill">Confirmed</span>;
  }
}

