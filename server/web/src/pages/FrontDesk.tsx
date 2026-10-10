import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useInterval, errorText, Modal, Notice, ServiceDot, sourceLabel } from '../ui';
import { addDays, fmtDayLong, fmtInstantTime, fmtTime12, nowHHMM, serviceLabel, toMinutes } from '../lib';
import { STATUS_LABEL, STATUS_PILL } from '../provider/docs';
import type { Appt, Dashboard, ServiceLite } from '../types';
import { PatientPicker } from '../patients/PatientPicker';
import { AppointmentDialog, LinkPatientDialog } from '../schedule/dialogs';
import { CheckoutDialog } from '../schedule/CheckoutDialog';
import FrontDeskNav from './FrontDeskNav';

type Verb = 'check-in' | 'undo-check-in' | 'no-show';

export default function FrontDesk() {
  const [date, setDate] = useState<string | undefined>(undefined);   // undefined = today
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; text: string } | null>(null);
  const [walkIn, setWalkIn] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [link, setLink] = useState<Appt | null>(null);
  const [checkout, setCheckout] = useState<Appt | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string>('');

  const load = useCallback(async () => {
    try {
      const d = await api<Dashboard>(`/api/fd/dashboard${date ? `?date=${date}` : ''}`);
      setData(d); setError(null);
      setUpdatedAt(fmtInstantTime(d.now, d.timezone));
    } catch (e) { setError(errorText(e)); }
  }, [date]);

  useEffect(() => { void load(); }, [load]);
  // Refresh every 30s. These are GETs, so they do not keep an unattended session alive.
  useInterval(() => { void load(); }, 30_000);

  async function act(a: Appt, verb: Verb) {
    setBusyId(a.id); setRowError(null);
    try { await api(`/api/fd/appointments/${a.id}/${verb}`, { method: 'POST', body: {} }); await load(); }
    catch (e) { setRowError({ id: a.id, text: errorText(e) }); }
    finally { setBusyId(null); }
  }

  const today = data?.today;
  const viewing = data?.date ?? date ?? '';
  const nowMin = data?.isToday ? toMinutes(nowHHMM(data.timezone)) : null;

  return (
    <>
      <FrontDeskNav />
      <div className="page-head">
        <div>
          <h1>Front Desk</h1>
          <p className="lede">{viewing ? fmtDayLong(viewing) : 'Today'}{data?.isToday && ' · today'}</p>
        </div>
        <div className="head-actions">
          <div className="date-nav" role="group" aria-label="Day">
            <button className="btn small" onClick={() => viewing && setDate(addDays(viewing, -1))} aria-label="Previous day">‹</button>
            <button className="btn small" onClick={() => setDate(undefined)} disabled={data?.isToday}>Today</button>
            <button className="btn small" onClick={() => viewing && setDate(addDays(viewing, 1))} aria-label="Next day">›</button>
          </div>
          <button className="btn primary" onClick={() => setWalkIn(true)} disabled={data ? !data.isToday : false} title={data && !data.isToday ? 'Walk-ins are for today' : ''}>+ Walk-in</button>
        </div>
      </div>

      {error && <Notice kind="error">{error}</Notice>}
      {data && data.pendingReview > 0 && (
        <Notice kind="warn">
          <strong>{data.pendingReview}</strong> online {data.pendingReview === 1 ? 'request is' : 'requests are'} waiting for approval. <Link to="/schedule">Open the Schedule →</Link>
        </Notice>
      )}
      {data && !data.isToday && <Notice>You are looking at {fmtDayLong(data.date)}. Check-in and walk-ins are for today only.</Notice>}

      <div className="columns" aria-busy={!data}>
        <Column title="Today’s appointments" hint="Still to arrive" count={data?.scheduled.length ?? 0}>
          {data?.scheduled.map((a) => (
            <Card key={a.id} a={a} onOpen={() => setOpen(a.id)} error={rowError?.id === a.id ? rowError.text : null}>
              {!a.patient.linked && <button className="btn small" onClick={() => setLink(a)}>Link patient</button>}
              <button className="btn small primary" disabled={busyId === a.id || !a.patient.linked || !data.isToday} title={!a.patient.linked ? 'Link a patient record first' : ''} onClick={() => void act(a, 'check-in')}>Check in</button>
              {nowMin !== null && toMinutes(a.localStart) <= nowMin && <button className="btn small" disabled={busyId === a.id} onClick={() => void act(a, 'no-show')}>No-show</button>}
            </Card>
          ))}
          {data && data.scheduled.length === 0 && <Empty>No one else is expected{data.isToday ? ' today' : ''}.</Empty>}
          {data && data.noShows.length > 0 && (
            <details className="noshows">
              <summary>No-shows ({data.noShows.length})</summary>
              {data.noShows.map((a) => (
                <Card key={a.id} a={a} muted onOpen={() => setOpen(a.id)} error={rowError?.id === a.id ? rowError.text : null}>
                  <button className="btn small" disabled={busyId === a.id || !a.patient.linked || !data.isToday} onClick={() => void act(a, 'check-in')}>They arrived — check in</button>
                </Card>
              ))}
            </details>
          )}
        </Column>

        <Column title="Checked in" hint="Here now" count={data?.checkedIn.length ?? 0}>
          {data?.checkedIn.map((a) => (
            <Card key={a.id} a={a} onOpen={() => setOpen(a.id)} error={rowError?.id === a.id ? rowError.text : null}
              extra={a.encounter?.checkedInAt && <span className="wait">in at {fmtInstantTime(a.encounter.checkedInAt, data.timezone)}{waiting(a.encounter.checkedInAt, data.now)}</span>}>
              <button className="btn small primary" disabled={busyId === a.id} onClick={() => setCheckout(a)}>Check out…</button>
              <button className="btn small" disabled={busyId === a.id} onClick={() => void act(a, 'undo-check-in')}>Undo check-in</button>
            </Card>
          ))}
          {data && data.checkedIn.length === 0 && <Empty>No one is checked in.</Empty>}
        </Column>

        <Column title="Seen / checked out" hint="Finished" count={data?.done.length ?? 0}>
          {data?.done.map((a) => (
            <Card key={a.id} a={a} muted onOpen={() => setOpen(a.id)} error={null}
              extra={a.encounter?.checkedOutAt && <span className="wait">out at {fmtInstantTime(a.encounter.checkedOutAt, data.timezone)}</span>} />
          ))}
          {data && data.done.length === 0 && <Empty>Nobody has finished yet.</Empty>}
        </Column>
      </div>

      <p className="muted small updated">{updatedAt && `Updated ${updatedAt} · refreshes every 30 seconds · `}<button className="linklike" onClick={() => void load()}>Refresh now</button></p>

      {walkIn && today && <WalkInDialog tz={data!.timezone} onClose={() => setWalkIn(false)} onPlaced={() => { setWalkIn(false); void load(); }} />}
      {open && <AppointmentDialog id={open} today={today ?? ''} onClose={() => setOpen(null)} onChanged={() => void load()} />}
      {checkout && <CheckoutDialog appt={checkout} onClose={() => setCheckout(null)} onDone={() => void load()} />}
      {link && <LinkPatientDialog appt={link} onClose={() => setLink(null)} onLinked={() => { setLink(null); void load(); }} />}
    </>
  );
}

function waiting(since: string, nowIso: string): string {
  const min = Math.floor((new Date(nowIso).getTime() - new Date(since).getTime()) / 60_000);
  return min >= 1 ? ` · ${min} min` : '';
}

function Column({ title, hint, count, children }: { title: string; hint: string; count: number; children: React.ReactNode }) {
  return (
    <section className="column" aria-label={title}>
      <header><h2>{title}</h2><span className="count" aria-label={`${count} patients`}>{count}</span></header>
      <p className="hint col-hint">{hint}</p>
      <div className="col-body">{children}</div>
    </section>
  );
}

const Empty = ({ children }: { children: React.ReactNode }) => <p className="empty">{children}</p>;

function Card({ a, onOpen, children, extra, muted, error }: {
  a: Appt; onOpen: () => void; children?: React.ReactNode; extra?: React.ReactNode; muted?: boolean; error: string | null;
}) {
  return (
    <article className={`appt-card${muted ? ' muted-card' : ''}`} style={{ borderLeftColor: a.service.color }}>
      <button className="appt-main" onClick={onOpen} aria-label={`Details for ${a.patient.name}`}>
        <span className="appt-time">{fmtTime12(a.localStart)}</span>
        <span className="appt-who">{a.patient.name}</span>
        <span className="appt-svc"><ServiceDot color={a.service.color} /> {a.service.name}{a.subOption ? ` · ${a.subOption}` : ''}</span>
        <span className="appt-meta">{a.staff?.name ?? 'No provider'} · {a.resource.name}{a.source !== 'ONLINE' ? ` · ${sourceLabel(a.source)}` : ''}</span>
        {extra}
        {a.encounter && a.encounter.status !== 'SCHEDULED' && a.encounter.status !== 'NO_SHOW' && (
          <span className={`pill ${STATUS_PILL[a.documentation.status]}`} title="Whether the provider's note exists and is signed. The note itself is not shown here.">{STATUS_LABEL[a.documentation.status]}</span>
        )}
        {!a.patient.linked && <span className="pill warn">not linked to a patient record</span>}
      </button>
      {error && <p className="error small" role="alert">{error}</p>}
      {children && <div className="appt-actions">{children}</div>}
    </article>
  );
}

// ---- walk-in ---------------------------------------------------------------------------------

interface WalkInConflict { error: string; nextAvailable: string[] }

function WalkInDialog({ tz, onClose, onPlaced }: { tz: string; onClose: () => void; onPlaced: () => void }) {
  const [patient, setPatient] = useState<{ id: string; name: string } | null>(null);
  const [services, setServices] = useState<ServiceLite[]>([]);
  const [serviceId, setServiceId] = useState('');
  const [subOption, setSubOption] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<WalkInConflict | null>(null);

  useEffect(() => { api<{ services: ServiceLite[] }>('/api/services').then((r) => setServices(r.services)).catch((e) => setError(errorText(e))); }, []);
  const service = services.find((s) => s.id === serviceId);
  const categories = [...new Set(services.map((s) => s.category))];

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!patient || !serviceId) return;
    setBusy(true); setError(null); setConflict(null);
    try {
      await api('/api/fd/walk-ins', { method: 'POST', body: { patientId: patient.id, serviceId, ...(subOption ? { subOption } : {}) } });
      onPlaced();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setConflict({ error: err.message, nextAvailable: ((err.body as { nextAvailable?: string[] }).nextAvailable) ?? [] });
      else setError(errorText(err));
    } finally { setBusy(false); }
  }

  return (
    <Modal title="Walk-in" wide onClose={onClose}>
      <form className="stack" onSubmit={(e) => void submit(e)}>
        <p className="hint">Places the patient in the current 15-minute slot and checks them in. If a room or provider isn’t free right now, nothing is booked.</p>
        <div><div className="label-like">Patient</div><PatientPicker value={patient} onPick={setPatient} /></div>
        <div className="form-grid two">
          <label>Service
            <select value={serviceId} onChange={(e) => { setServiceId(e.target.value); setSubOption(''); setConflict(null); }} required>
              <option value="">— choose —</option>
              {categories.map((c) => (
                <optgroup key={c} label={c}>{services.filter((s) => s.category === c).map((s) => <option key={s.id} value={s.id}>{serviceLabel(s)}</option>)}</optgroup>
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
        </div>
        {conflict && (
          <Notice kind="warn">
            <strong>Not available right now.</strong> {conflict.error}
            {conflict.nextAvailable.length > 0
              ? <> Next openings today: {conflict.nextAvailable.map((t) => fmtInstantTime(t, tz)).join(', ')}. Book one from the Schedule.</>
              : <> Nothing else is open today for this service.</>}
          </Notice>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="sheet-actions">
          <button className="btn primary" disabled={busy || !patient || !serviceId}>{busy ? 'Placing…' : 'Check in walk-in'}</button>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
