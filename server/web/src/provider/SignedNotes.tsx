import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { errorText } from '../ui';
import { fmtInstantTime } from '../lib';
import { inNoteOrder, parseMinutes, roleName, SECTIONS } from './docs';
import type { SignedNote } from '../types';

const KIND_LABEL: Record<string, string> = { ...Object.fromEntries(SECTIONS.map((s) => [s.kind, s.label])), GENERAL: 'Session log' };

/**
 * The signed record. Nothing here edits a note: correcting one is an AMENDMENT, which adds a new version
 * beside the old one (with the reason) and keeps both. Every earlier version stays readable below.
 */
export function SignedNotes({ notes, canAmend, tz, onAmended }: { notes: SignedNote[]; canAmend: boolean; tz: string; onAmended: () => Promise<void> }) {
  return (
    <div className="stack">
      {inNoteOrder(notes).map((n) => <NoteBlock key={n.id} note={n} canAmend={canAmend} tz={tz} onAmended={onAmended} />)}
    </div>
  );
}

function NoteBlock({ note, canAmend, tz, onAmended }: { note: SignedNote; canAmend: boolean; tz: string; onAmended: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(note.body);
  const [duration, setDuration] = useState(note.durationMin != null ? String(note.durationMin) : '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isLog = note.kind === 'GENERAL';
  const minutes = parseMinutes(duration);
  const ok = body.trim() !== '' && reason.trim() !== '' && (!isLog || (minutes !== undefined && minutes !== null));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ok) return;
    setBusy(true); setError(null);
    try {
      await api(`/api/visit-notes/${note.id}/amend`, { method: 'POST', body: { body, amendReason: reason.trim(), ...(isLog && minutes ? { durationMin: minutes } : {}) } });
      setEditing(false); setReason('');
      await onAmended();
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  }

  return (
    <article className="note-block">
      <header>
        <h3>{KIND_LABEL[note.kind] ?? note.kind}{isLog && note.durationMin != null ? ` · ${note.durationMin} min` : ''}</h3>
        {note.amended && <span className="pill warn">Amended</span>}
      </header>
      {!editing ? <p className="note-text">{note.body}</p> : (
        <form className="stack" onSubmit={(e) => void submit(e)}>
          {isLog && <label>Duration (minutes)<input inputMode="numeric" value={duration} onChange={(e) => setDuration(e.target.value)} style={{ maxWidth: 140 }} /></label>}
          <label>Corrected note<textarea rows={Math.max(4, Math.min(14, body.split('\n').length + 2))} value={body} onChange={(e) => setBody(e.target.value)} /></label>
          <label>Why is it being amended?<input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="Required — e.g. wrong side recorded" /></label>
          <p className="hint">The original stays in the record. This adds a new version beside it.</p>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="sheet-actions">
            <button className="btn primary" disabled={!ok || busy}>{busy ? 'Saving…' : 'Save amendment'}</button>
            <button type="button" className="btn ghost" onClick={() => { setEditing(false); setBody(note.body); setReason(''); }}>Cancel</button>
          </div>
        </form>
      )}
      {!editing && canAmend && <div><button className="btn small" onClick={() => setEditing(true)}>Amend…</button></div>}
      {note.history.length > 0 && (
        <details className="note-history">
          <summary>{note.history.length} earlier {note.history.length === 1 ? 'version' : 'versions'}</summary>
          <ol>
            {[...note.history].reverse().map((h) => (
              <li key={h.id}>
                <div className="muted small">
                  {h.author.name} ({roleName(h.author.role)}) · {fmtInstantTime(h.createdAt, tz)}
                  {h.amendReason ? <> — replaced because: <em>{h.amendReason}</em></> : null}
                </div>
                <p className="note-text old">{h.body}{h.durationMin != null ? ` (${h.durationMin} min)` : ''}</p>
              </li>
            ))}
          </ol>
        </details>
      )}
    </article>
  );
}
