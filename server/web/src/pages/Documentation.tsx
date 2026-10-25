import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { useClinicTz } from '../clinic';
import { fmtDay, fmtInstantTime, fmtTime12 } from '../lib';
import { errorText, Modal, Notice } from '../ui';
import { emptySoap, insertMacro, macrosFor, parseMinutes, ROLE_NAME, roleName, SECTIONS, signBlockers, STATUS_LABEL, STATUS_PILL, type SoapFields } from '../provider/docs';
import { MacroEditor, type MacroOps } from '../provider/MacroEditor';
import { ScribePanel } from '../provider/ScribePanel';
import { Recordings } from '../provider/Recordings';
import { SignedNotes } from '../provider/SignedNotes';
import { ChargesDialog } from '../patients/Charges';
import type { MacroLibrary, MacroLite, ProviderRole, Section, Workspace } from '../types';

type Save =
  | { state: 'idle' }
  | { state: 'dirty' }
  | { state: 'saving' }
  | { state: 'saved'; at: Date }
  | { state: 'error'; message: string }
  | { state: 'conflict' };

const AUTOSAVE_MS = 1200;

/**
 * The documentation workspace for one visit. A SOAP service gets four sections; a session-log service gets a
 * duration and notes. What is typed is saved to a DRAFT as it goes (it is a scratchpad, not the record);
 * signing turns it into the record, after which the only change is an amendment that keeps the original.
 */
export default function Documentation() {
  const { id = '' } = useParams();
  const tz = useClinicTz();
  const { me } = useAuth();
  const [ws, setWs] = useState<Workspace | null>(null);
  const [lib, setLib] = useState<MacroLibrary | null>(null);
  const [loadError, setLoadError] = useState<{ text: string; code?: string } | null>(null);

  // ---- what is typed ----
  const [soap, setSoap] = useState<SoapFields>(emptySoap());
  const [notes, setNotes] = useState('');
  const [minutes, setMinutes] = useState('');
  const [save, setSave] = useState<Save>({ state: 'idle' });
  const [signing, setSigning] = useState(false);
  const [macrosOpen, setMacrosOpen] = useState(false);
  const [chargesOpen, setChargesOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const version = useRef<number | undefined>(undefined);
  const lastSaved = useRef('');
  const inflight = useRef<Promise<void> | null>(null);
  const latest = useRef({ soap, notes, minutes });
  latest.current = { soap, notes, minutes };
  const boxes = useRef<Record<string, HTMLTextAreaElement | null>>({});

  const held = me?.account.roles.filter((r): r is ProviderRole => r.startsWith('PROVIDER_')) ?? [];
  const roleBody = useMemo<{ role?: string }>(() => (held.length > 1 && ws?.access.role ? { role: ws.access.role } : {}), [held.length, ws?.access.role]);   // eslint-disable-line react-hooks/exhaustive-deps

  const type = ws?.documentation.type;
  const body = useCallback(() => {
    const m = parseMinutes(latest.current.minutes);
    return type === 'SOAP'
      ? { ...latest.current.soap }
      : { notes: latest.current.notes, durationMin: m === undefined ? null : m };
  }, [type]);
  const signature = (b: object) => JSON.stringify(b);

  /** Load (or reload) the workspace and reset the editor to what the server holds. */
  const load = useCallback(async () => {
    try {
      const w = await api<Workspace>(`/api/provider/visits/${id}/documentation`);
      setWs(w);
      setLoadError(null);
      const d = w.draft;
      const nextSoap = d ? { subjective: d.subjective, objective: d.objective, assessment: d.assessment, plan: d.plan } : emptySoap();
      setSoap(nextSoap);
      setNotes(d?.notes ?? '');
      setMinutes(d?.durationMin != null ? String(d.durationMin) : '');
      version.current = d?.version;
      lastSaved.current = signature(w.documentation.type === 'SOAP' ? nextSoap : { notes: d?.notes ?? '', durationMin: d?.durationMin ?? null });
      setSave({ state: 'idle' });
      return w;
    } catch (e) {
      setLoadError({ text: errorText(e), code: e instanceof ApiError ? e.code : undefined });
      return null;
    }
  }, [id]);

  /** Rev 2.1, administrator: the note's signer did see the patient — record them as the visit's covering provider. The signature is untouched. */
  async function confirmCovering() {
    setConfirming(true); setConfirmError(null);
    try { await api(`/api/provider/visits/${id}/confirm-covering`, { method: 'POST', body: {} }); await load(); }
    catch (e) { setConfirmError(errorText(e)); }
    finally { setConfirming(false); }
  }

  useEffect(() => {
    void load().then((w) => {
      // Opening a patient's documentation is the start of the visit.
      if (w?.access.canWrite && w.encounter?.status === 'CHECKED_IN' && w.documentation.status !== 'SIGNED') {
        void api(`/api/provider/visits/${id}/start`, { method: 'POST', body: roleBody }).catch(() => undefined);
      }
    });
    api<MacroLibrary>('/api/provider/macros').then(setLib).catch(() => setLib({ personal: { macros: [] }, shared: [] }));
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const editable = !!ws?.access.canWrite && ws.documentation.status !== 'SIGNED';

  // ---- autosave ----
  const persist = useCallback(async (): Promise<void> => {
    if (!editable) return;
    if (inflight.current) await inflight.current;
    const b = body();
    const sig = signature(b);
    if (sig === lastSaved.current) return;
    setSave({ state: 'saving' });
    const run = (async () => {
      try {
        const r = await api<{ version: number }>(`/api/provider/visits/${id}/draft`, {
          method: 'PUT', body: { ...roleBody, ...(version.current !== undefined ? { version: version.current } : {}), ...b },
        });
        version.current = r.version;
        lastSaved.current = sig;
        setSave(signature(body()) === sig ? { state: 'saved', at: new Date() } : { state: 'dirty' });
      } catch (e) {
        setSave(e instanceof ApiError && (e.code === 'stale_draft' || e.code === 'no_draft') ? { state: 'conflict' } : { state: 'error', message: errorText(e) });
      }
    })();
    inflight.current = run;
    try { await run; } finally { inflight.current = null; }
  }, [editable, body, id, roleBody]);

  useEffect(() => {
    if (!editable) return;
    const dirty = signature(body()) !== lastSaved.current;
    if (!dirty) return;
    setSave((s) => (s.state === 'saving' || s.state === 'conflict' ? s : { state: 'dirty' }));
    const t = window.setTimeout(() => void persist(), AUTOSAVE_MS);
    return () => window.clearTimeout(t);
  }, [soap, notes, minutes, editable, body, persist]);

  // Leaving with unsaved words is the one thing this page must not let happen silently.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (save.state === 'dirty' || save.state === 'saving' || save.state === 'error') { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [save.state]);

  /** Save everything typed so far; resolves with the draft's version once the server has it. */
  const flush = useCallback(async (): Promise<number | undefined> => {
    for (let i = 0; i < 3; i++) { await persist(); if (signature(body()) === lastSaved.current) break; }
    return version.current;
  }, [persist, body]);

  /** Refresh the scribe's view of the visit WITHOUT touching what is being typed. */
  const refreshWorkspaceOnly = useCallback(async () => {
    try { setWs(await api<Workspace>(`/api/provider/visits/${id}/documentation`)); } catch { /* the next poll will try again */ }
  }, [id]);

  // ---- macros ----
  function insertInto(key: Section | 'notes', m: MacroLite) {
    const el = boxes.current[key];
    const current = key === 'notes' ? notes : soap[key];
    const start = el?.selectionStart ?? current.length;
    const end = el?.selectionEnd ?? current.length;
    const r = insertMacro(current, start, end, m.body);
    if (key === 'notes') setNotes(r.text); else setSoap((s) => ({ ...s, [key]: r.text }));
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(r.cursor, r.cursor); });
  }
  const refreshMacros = async () => setLib(await api<MacroLibrary>('/api/provider/macros'));
  const macroOps: MacroOps = {
    add: async (m) => { await api('/api/provider/macros', { method: 'POST', body: m }); await refreshMacros(); },
    update: async (mid, patch) => { await api(`/api/provider/macros/${mid}`, { method: 'PATCH', body: patch }); await refreshMacros(); },
    remove: async (mid) => { await api(`/api/provider/macros/${mid}`, { method: 'DELETE', body: {} }); await refreshMacros(); },
  };

  // ---- render ----
  if (loadError) {
    const mfa = loadError.code?.startsWith('mfa_');
    return (
      <>
        <p className="crumb"><Link to="/provider">← Provider queue</Link></p>
        <Notice kind="error">{loadError.text}</Notice>
        {mfa && <p><Link className="btn primary" to="/mfa/enroll">Set up your authenticator</Link></p>}
      </>
    );
  }
  if (!ws) return <p className="muted">Loading…</p>;

  const status = ws.documentation.status;
  const b = ws.booking;
  const signedView = status === 'SIGNED';
  const blockers = signBlockers(ws.documentation.type, soap, { notes, durationMin: parseMinutes(minutes) ?? null });
  const minutesBad = minutes.trim() !== '' && parseMinutes(minutes) === undefined;
  const aiDraft = !!ws.draft?.aiDrafted;
  const roleLabel = ws.access.role ? ROLE_NAME[ws.access.role] : null;

  return (
    <>
      <p className="crumb"><Link to="/provider">← Provider queue</Link> · <Link to="/provider/unsigned">Unsigned notes</Link></p>
      <div className="page-head">
        <div>
          <h1>{b.patient.name}</h1>
          <p className="lede">{b.service.name}{b.subOption ? ` · ${b.subOption}` : ''} · {fmtDay(b.localDate)} {fmtTime12(b.localStart)}–{fmtTime12(b.localEnd)}{b.provider ? ` · ${b.provider.name}` : ''}</p>
        </div>
        <div className="head-actions">
          <span className={`pill ${STATUS_PILL[status]}`}>{STATUS_LABEL[status]}</span>
          {b.patient.id && <Link className="btn small" to={`/front-desk/patients/${b.patient.id}`} target="_blank" rel="noopener">Patient record</Link>}
          {editable && <button className="btn small" onClick={() => setMacrosOpen(true)}>My macros</button>}
          {/* Rev 2.3 (decision 4): the visit's provider adds charges — InBody, supplements — for the desk to check out. */}
          {ws.access.canWrite && b.patient.id && ['CHECKED_IN', 'IN_PROGRESS', 'SEEN'].includes(ws.encounter?.status ?? '') && (
            <button className="btn small" onClick={() => setChargesOpen(true)}>Charges</button>
          )}
        </div>
      </div>

      {b.patientNote && <div className="patient-note"><div className="label-like">What the patient wrote when booking</div><p>{b.patientNote}</p></div>}
      {!ws.access.canWrite && !signedView && <Notice kind="warn">{ws.access.readOnlyReason ?? 'You can read this but not write it.'}</Notice>}
      {!ws.access.canWrite && signedView && ws.access.readOnlyReason && <p className="hint">{ws.access.readOnlyReason}</p>}
      {/* Rev 2.0: the note is apart from check-out. Say so where it matters to the person writing it. */}
      {!signedView && ws.note === 'NOT_REQUIRED' && <p className="hint">This service does not need a note. You can still write and sign one.</p>}
      {!signedView && ws.note === 'PENDING' && ws.encounter?.status === 'CHECKED_OUT' && (
        <Notice>The patient has been checked out. You can still write and sign this note; it will be recorded as signed after check-out.</Notice>
      )}

      {signedView && ws.signature && (
        <section className="card wide-card signed-card">
          <div className="signed-line">
            <span className="pill ok">Signed</span>
            <span>by <strong>{ws.signature.signedBy ?? 'a provider'}</strong> ({roleName(ws.signature.signedRole)}) · {fmtInstantTime(ws.signature.signedAt, tz)}</span>
            {ws.signature.aiAssisted && <span className="pill off" title="The note began as an AI-generated draft that the provider reviewed.">Began as an AI draft{ws.signature.aiDraftUnchanged ? ' · signed unchanged' : ' · edited'}</span>}
            {ws.signature.afterCheckout && <span className="pill off" title="Signed after the patient had been checked out.">Signed after check-out</span>}
          </div>
          {/* Rev 2.1: signed by someone other than the visit's provider (the old role rule allowed it). Flagged; the signature is never changed. */}
          {!ws.signature.signerIsVisitProvider && (
            <Notice kind="warn">
              Signed by <strong>{ws.signature.signedBy ?? 'a provider'}</strong>, who is not this visit’s provider ({b.provider?.name ?? 'not assigned'}).
              {ws.access.canConfirmCovering
                ? <> If they saw the patient, confirm them as the covering provider. <button className="btn small" disabled={confirming} onClick={() => void confirmCovering()}>Confirm as covering provider</button></>
                : ' An administrator can confirm them as the covering provider; the visit’s provider can add an addendum.'}
              {confirmError && <span className="error"> {confirmError}</span>}
            </Notice>
          )}
          <SignedNotes notes={ws.notes} canAddend={ws.access.canAddend} tz={tz} onAmended={async () => { await load(); }} />
        </section>
      )}
      {signedView && ws.signature && (
        <Recordings visitId={id} sessions={ws.scribe.sessions} signedAt={ws.signature.signedAt} retentionDays={ws.scribe.audioRetentionDays} tz={tz} />
      )}

      {!signedView && (
        <div className="doc-layout">
          <section className="card wide-card editor-card">
            {aiDraft && (
              <Notice kind="warn">
                <strong>Part of this note began as an AI-generated draft.</strong> Read all of it, correct what is wrong, and sign only when it is yours. It is not signed until you sign it.
              </Notice>
            )}
            {save.state === 'conflict' && (
              <Notice kind="error">
                This draft was changed in another window, so your latest edits were not saved.{' '}
                <button className="linklike" onClick={() => void load()}>Reload the saved version</button> (your unsaved edits in this window are lost).
              </Notice>
            )}

            {ws.documentation.type === 'SOAP' ? (
              <div className="stack">
                {SECTIONS.map((s) => {
                  const m = macrosFor(s.kind, lib?.shared ?? [], lib?.personal.macros ?? []);
                  return (
                    <div key={s.key} className="soap-section">
                      <label htmlFor={`soap-${s.key}`}><span className="soap-letter">{s.letter}</span> {s.label} <span className="hint inline">{s.hint}</span></label>
                      {editable && <MacroBar shared={m.shared} personal={m.personal} onPick={(mm) => insertInto(s.key, mm)} onManage={() => setMacrosOpen(true)} />}
                      <textarea id={`soap-${s.key}`} ref={(el) => { boxes.current[s.key] = el; }} rows={6} value={soap[s.key]} readOnly={!editable}
                        onChange={(e) => setSoap((v) => ({ ...v, [s.key]: e.target.value }))} maxLength={20000} />
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="stack">
                <div className="form-grid two">
                  <label>Duration (minutes)
                    <input inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value)} readOnly={!editable} aria-invalid={minutesBad} />
                    {minutesBad && <span className="error small">Whole minutes, 1 to 1,440.</span>}
                  </label>
                  <div><div className="label-like">Provider</div><div className="static-field">{ws.access.canWrite ? `${ws.access.signsAs ?? me?.account.displayName ?? ''}${roleLabel ? ` · ${roleLabel}` : ''}` : (b.provider?.name ?? '—')}</div></div>
                </div>
                <div className="soap-section">
                  <label htmlFor="log-notes">Notes</label>
                  {editable && (() => { const m = macrosFor('GENERAL', lib?.shared ?? [], lib?.personal.macros ?? []); return <MacroBar shared={m.shared} personal={m.personal} onPick={(mm) => insertInto('notes', mm)} onManage={() => setMacrosOpen(true)} />; })()}
                  <textarea id="log-notes" ref={(el) => { boxes.current.notes = el; }} rows={8} value={notes} readOnly={!editable} onChange={(e) => setNotes(e.target.value)} maxLength={20000} />
                </div>
              </div>
            )}

            {editable && (
              <div className="sign-bar">
                <SaveStatus s={save} tz={tz} />
                <div className="sign-actions">
                  {blockers.length > 0 && <span className="hint">{blockers[0]}</span>}
                  <button className="btn primary" disabled={blockers.length > 0 || minutesBad || save.state === 'conflict'} onClick={() => setSigning(true)}>Review and sign…</button>
                </div>
              </div>
            )}
          </section>

          {(editable || ws.scribe.sessions.length > 0) && (
            <aside className="doc-side">
              <ScribePanel visitId={id} ws={ws} roleBody={roleBody} reload={refreshWorkspaceOnly} flush={flush} onApplied={async () => { await load(); }} />
            </aside>
          )}
        </div>
      )}

      {signing && ws.access.role && (
        <SignDialog roleLabel={ROLE_NAME[ws.access.role]} name={ws.access.signsAs ?? me?.account.displayName ?? ''} aiDraft={aiDraft}
          onClose={() => setSigning(false)}
          onSign={async (reviewed) => {
            const v = await flush();
            if (signature(body()) !== lastSaved.current || v === undefined) throw new Error('Your latest words could not be saved, so nothing was signed. Try again.');
            await api(`/api/provider/visits/${id}/sign`, { method: 'POST', body: { ...roleBody, version: v, ...(aiDraft ? { reviewedAiDraft: reviewed } : {}) } });
            setSigning(false);
            await load();
          }} />
      )}

      {chargesOpen && (
        <ChargesDialog target={{ kind: 'provider', bookingId: id, role: ws.access.role }} title={`Charges — ${b.patient.name}`} onClose={() => setChargesOpen(false)} />
      )}
      {macrosOpen && (
        <Modal title="My macros" wide onClose={() => setMacrosOpen(false)}>
          <p className="hint">Saved text you can insert into a note with one click. Shared sets from an administrator appear in the note itself; these are yours alone.</p>
          <MacroEditor macros={lib?.personal.macros ?? []} ops={macroOps} />
        </Modal>
      )}
    </>
  );
}

function MacroBar({ shared, personal, onPick, onManage }: { shared: MacroLite[]; personal: MacroLite[]; onPick: (m: MacroLite) => void; onManage: () => void }) {
  if (shared.length === 0 && personal.length === 0) {
    return <div className="macro-bar"><span className="hint inline">No macros for this section yet.</span> <button type="button" className="linklike small" onClick={onManage}>Add one</button></div>;
  }
  return (
    <div className="macro-bar" role="group" aria-label="Insert a macro">
      {[...shared.map((m) => ({ m, own: false })), ...personal.map((m) => ({ m, own: true }))].map(({ m, own }) => (
        <button key={m.id} type="button" className={`chip${own ? ' own' : ''}`} title={m.body.length > 160 ? `${m.body.slice(0, 160)}…` : m.body}
          onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(m)}>+ {m.title}</button>
      ))}
    </div>
  );
}

function SaveStatus({ s, tz }: { s: Save; tz: string }) {
  switch (s.state) {
    case 'saving': return <span className="save-status" role="status">Saving…</span>;
    case 'saved': return <span className="save-status ok" role="status">Saved {fmtInstantTime(s.at.toISOString(), tz)}</span>;
    case 'dirty': return <span className="save-status" role="status">Unsaved changes…</span>;
    case 'error': return <span className="save-status bad" role="alert">Couldn’t save: {s.message}. It will try again as you type.</span>;
    case 'conflict': return <span className="save-status bad" role="alert">Not saved — changed in another window.</span>;
    default: return <span className="save-status muted">Saved as you type.</span>;
  }
}

function SignDialog({ roleLabel, name, aiDraft, onSign, onClose }: {
  roleLabel: string; name: string; aiDraft: boolean; onSign: (reviewedAiDraft: boolean) => Promise<void>; onClose: () => void;
}) {
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function go() {
    setBusy(true); setError(null);
    try { await onSign(reviewed); } catch (e) { setError(errorText(e)); setBusy(false); }
  }
  return (
    <Modal title="Sign this note" onClose={onClose}>
      <div className="stack">
        <p>You are signing as <strong>{roleLabel}</strong>{name ? <> — {name}</> : null}.</p>
        <p className="hint">Signing makes this part of the patient’s record. After that it cannot be edited: a correction is an amendment, which keeps what you signed and shows why it changed.</p>
        {aiDraft && (
          <label className="check consent-check">
            <input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} autoFocus />
            <span>Part of this note began as an AI-generated draft. <strong>I have read all of it, corrected what needed correcting, and it is accurate.</strong></span>
          </label>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="sheet-actions">
          <button className="btn primary" disabled={busy || (aiDraft && !reviewed)} onClick={() => void go()}>{busy ? 'Signing…' : 'Sign note'}</button>
          <button className="btn ghost" onClick={onClose}>Not yet</button>
        </div>
      </div>
    </Modal>
  );
}

