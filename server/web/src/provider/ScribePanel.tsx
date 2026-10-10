import { useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { clock, scribeFailure, scribeUnavailable } from './docs';
import { useRecorder } from './useRecorder';
import { errorText, Notice, useInterval } from '../ui';
import type { ScribeSessionView, Workspace } from '../types';

type Mode = 'fill_empty' | 'replace_all';
const WORKING = ['UPLOADED', 'TRANSCRIBING', 'DRAFTING'];
const WORKING_LABEL: Record<string, string> = { UPLOADED: 'Waiting to transcribe…', TRANSCRIBING: 'Transcribing the recording…', DRAFTING: 'Drafting the note from the transcript…' };

interface Props {
  visitId: string;
  ws: Workspace;
  roleBody: { role?: string };
  /** Reload the workspace (session states, consent). */
  reload: () => Promise<void>;
  /** Save anything typed so far and return the draft's current version (undefined if there is none yet). */
  flush: () => Promise<number | undefined>;
  /** The AI draft was put into the note: reload and show it. */
  onApplied: () => Promise<void>;
}

/**
 * The AI scribe. The browser records the visit (after the provider confirms the patient agreed), uploads it
 * to the address the server hands out, and the server transcribes it and drafts a SOAP note. The draft is
 * then OFFERED: nothing goes into the note until the provider chooses to insert it, and inserting it does
 * not sign it. The microphone, the audio and the transcript never touch this page's logs or URLs.
 */
export function ScribePanel({ visitId, ws, roleBody, reload, flush, onApplied }: Props) {
  const { stayActive } = useAuth();
  const { scribe } = ws;
  const base = `/api/provider/visits/${visitId}/scribe`;
  const rec = useRecorder(() => void stopAndUpload());

  const [agreed, setAgreed] = useState(false);
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [pending, setPending] = useState<{ sessionId: string; blob: Blob } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canWrite = ws.access.canWrite;

  // Keep polling while the server is working, and keep the sign-in alive while a recording is being made:
  // a person speaking to a patient for twenty minutes is not "away from the screen".
  useInterval(() => { if (scribe.sessions.some((s) => WORKING.includes(s.status))) void reload(); }, 2000);
  useInterval(() => { if (rec.state === 'recording' || uploading) stayActive(); }, 60_000);

  if (!scribe.applicable) return null;
  if (!scribe.available) {
    return <section className="card scribe-card"><h2>AI scribe</h2><p className="muted">{scribeUnavailable(scribe.unavailableReason)}</p></section>;
  }

  async function startRecording() {
    setError(null);
    try {
      await api(`${base}/consent`, { method: 'POST', body: { ...roleBody, consented: true } });   // the provider's attestation, recorded first
      const type = await rec.start();
      if (!type) return;
      try {
        const r = await api<{ session: { id: string } }>(`${base}/sessions`, { method: 'POST', body: { ...roleBody, contentType: type } });
        setRecordingId(r.session.id);
        void reload();
      } catch (e) { rec.cancel(); setError(errorText(e)); }
    } catch (e) { setError(errorText(e)); }
  }

  async function upload(sessionId: string, blob: Blob) {
    setUploading(true); setError(null);
    try {
      const t = await api<{ upload: { url: string; method: string; headers: Record<string, string> } }>(`${base}/sessions/${sessionId}/upload`, { method: 'POST', body: roleBody });
      // As with S3: straight to the address we were given, with no cookie and no extra headers.
      const put = await fetch(t.upload.url, { method: t.upload.method, headers: t.upload.headers, body: blob, credentials: 'omit' });
      if (!put.ok) throw new Error('The recording could not be uploaded. Try again.');
      await api(`${base}/sessions/${sessionId}/finish`, { method: 'POST', body: { ...roleBody, bytes: blob.size } });
      setPending(null);
    } catch (e) {
      setPending({ sessionId, blob });                                      // keep the audio in memory so the upload can be retried
      setError(errorText(e));
    } finally { setUploading(false); await reload(); }
  }

  async function stopAndUpload() {
    const sessionId = recordingId;
    if (!sessionId) { rec.cancel(); return; }
    setRecordingId(null);
    try {
      const { blob } = await rec.stop();
      await upload(sessionId, blob);
    } catch (e) { setError(errorText(e)); }
  }

  async function cancelRecording() {
    const sessionId = recordingId;
    rec.cancel();
    setRecordingId(null);
    if (sessionId) await api(`${base}/sessions/${sessionId}/discard`, { method: 'POST', body: roleBody }).catch(() => undefined);
    await reload();
  }

  const recording = rec.state === 'recording';

  return (
    <section className="card scribe-card" aria-label="AI scribe">
      <h2>AI scribe <span className="pill off">draft only</span></h2>
      <p className="hint">Records the visit and drafts the note from it. The draft is <strong>not</strong> part of the record until you review it, edit it and sign it yourself.</p>
      {(error || rec.error) && <Notice kind="error">{error ?? rec.error}</Notice>}

      {canWrite && !recording && !uploading && !pending && (
        <div className="stack">
          {scribe.consentAt
            ? <p className="small ok-text">The patient’s consent to recording is on record.</p>
            : (
              <label className="check consent-check">
                <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
                <span>The patient has agreed to this visit being recorded to help prepare the note.</span>
              </label>
            )}
          <div>
            <button className="btn primary" disabled={(!scribe.consentAt && !agreed) || rec.state === 'starting'} onClick={() => void startRecording()}>
              {rec.state === 'starting' ? 'Starting the microphone…' : '● Start recording'}
            </button>
          </div>
        </div>
      )}

      {recording && (
        <div className="recording" role="status">
          <div className="rec-line"><span className="rec-dot" aria-hidden="true" /> <strong>Recording</strong> <span className="mono">{clock(rec.seconds)}</span></div>
          <div className="sheet-actions">
            <button className="btn primary" onClick={() => void stopAndUpload()}>■ Stop and make a draft</button>
            <button className="btn ghost" onClick={() => void cancelRecording()}>Discard recording</button>
          </div>
        </div>
      )}
      {uploading && <p role="status">Uploading the recording…</p>}
      {pending && !uploading && (
        <div className="stack">
          <p>The recording is still on this page but has not reached the server.</p>
          <div className="sheet-actions">
            <button className="btn primary" onClick={() => void upload(pending.sessionId, pending.blob)}>Try uploading again</button>
            <button className="btn ghost" onClick={() => { setPending(null); void api(`${base}/sessions/${pending.sessionId}/discard`, { method: 'POST', body: roleBody }).then(reload); }}>Discard it</button>
          </div>
        </div>
      )}

      {scribe.sessions.length > 0 && (
        <ul className="plain sessions">
          {[...scribe.sessions].reverse().map((s) => (
            <li key={s.id}>
              <Session s={s} base={base} roleBody={roleBody} canWrite={canWrite} isLive={s.id === recordingId || pending?.sessionId === s.id}
                reload={reload} flush={flush} onApplied={onApplied} onError={setError} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Session({ s, base, roleBody, canWrite, isLive, reload, flush, onApplied, onError }: {
  s: ScribeSessionView; base: string; roleBody: { role?: string }; canWrite: boolean; isLive: boolean;
  reload: () => Promise<void>; flush: () => Promise<number | undefined>; onApplied: () => Promise<void>; onError: (m: string | null) => void;
}) {
  const [mode, setMode] = useState<Mode>('fill_empty');
  const [transcript, setTranscript] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const url = `${base}/sessions/${s.id}`;

  async function act(fn: () => Promise<void>) {
    setBusy(true); onError(null);
    try { await fn(); } catch (e) { onError(errorText(e)); } finally { setBusy(false); }
  }
  const showTranscript = () => act(async () => {
    if (transcript !== null) { setTranscript(null); return; }
    setTranscript((await api<{ transcript: string }>(`${url}/transcript`)).transcript);
  });
  const insert = () => act(async () => {
    const version = await flush();
    await api(`${url}/apply`, { method: 'POST', body: { ...roleBody, mode, ...(version !== undefined ? { version } : {}) } });
    await onApplied();
  });
  const discard = () => act(async () => {
    if (!window.confirm('Throw this recording away? The audio, transcript and draft are deleted.')) return;
    await api(`${url}/discard`, { method: 'POST', body: roleBody });
    await reload();
  });
  const retry = () => act(async () => { await api(`${url}/retry`, { method: 'POST', body: roleBody }); await reload(); });

  if (isLive) return null;                                  // the recording in progress is shown above
  if (s.status === 'RECORDING') {
    return (
      <div className="session"><span className="pill warn">Unfinished</span> A recording was started here but never uploaded.
        {canWrite && <button className="btn small ghost" disabled={busy} onClick={() => void discard()}>Discard</button>}</div>
    );
  }
  if (WORKING.includes(s.status)) return <div className="session" role="status"><span className="spinner" aria-hidden="true" /> {WORKING_LABEL[s.status]}</div>;
  if (s.status === 'FAILED') {
    return (
      <div className="session">
        <span className="pill bad">Failed</span> {scribeFailure(s.failureCode)}
        {canWrite && <span className="session-actions"><button className="btn small" disabled={busy} onClick={() => void retry()}>Try again</button><button className="btn small ghost" disabled={busy} onClick={() => void discard()}>Discard</button></span>}
      </div>
    );
  }
  return (
    <div className="session ready">
      <div><span className="pill ok">Draft ready</span> {s.applied && <span className="muted small">· already inserted into the note</span>}</div>
      {canWrite && !s.applied && (
        <fieldset className="mode">
          <legend className="sr-only">How to insert the draft</legend>
          <label className="check small"><input type="radio" name={`mode-${s.id}`} checked={mode === 'fill_empty'} onChange={() => setMode('fill_empty')} /> Fill the empty sections only</label>
          <label className="check small"><input type="radio" name={`mode-${s.id}`} checked={mode === 'replace_all'} onChange={() => setMode('replace_all')} /> Replace all four sections</label>
        </fieldset>
      )}
      <div className="session-actions">
        {canWrite && !s.applied && <button className="btn primary small" disabled={busy} onClick={() => void insert()}>Insert draft into the note</button>}
        <button className="btn small" disabled={busy} onClick={() => void showTranscript()}>{transcript === null ? 'View transcript' : 'Hide transcript'}</button>
        {canWrite && !s.applied && <button className="btn small ghost" disabled={busy} onClick={() => void discard()}>Discard recording</button>}
      </div>
      {transcript !== null && <pre className="transcript" aria-label="Transcript">{transcript}</pre>}
    </div>
  );
}
