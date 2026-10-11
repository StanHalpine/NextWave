import { useState } from 'react';
import { api } from '../api';
import { fmtDayLong, fmtInstantTime } from '../lib';
import { errorText } from '../ui';
import type { ScribeSessionView } from '../types';

/**
 * The recordings made for a visit that is now SIGNED. The raw audio is kept for a fixed number of days after
 * signing and then deleted; the transcript and the AI draft stay with the visit, so they are still readable here
 * (and each reading is audited).
 */
export function Recordings({ visitId, sessions, signedAt, retentionDays, tz }: {
  visitId: string; sessions: ScribeSessionView[]; signedAt: string; retentionDays: number; tz: string;
}) {
  const made = sessions.filter((s) => s.status === 'READY');
  if (made.length === 0) return null;
  // "Kept until" is the signing date plus the retention period, in the clinic's calendar.
  const until = new Date(new Date(signedAt).getTime() + retentionDays * 86_400_000);
  const untilDay = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(until);

  return (
    <section className="card wide-card recordings">
      <h2>Recordings</h2>
      <p className="hint">The audio is deleted {retentionDays} days after the note was signed. The transcript and the AI draft stay with this visit.</p>
      <ul className="plain">
        {made.map((s, i) => <Recording key={s.id} n={i + 1} s={s} visitId={visitId} untilDay={untilDay} tz={tz} />)}
      </ul>
    </section>
  );
}

function Recording({ n, s, visitId, untilDay, tz }: { n: number; s: ScribeSessionView; visitId: string; untilDay: string; tz: string }) {
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    if (text !== null) { setText(null); return; }
    setBusy(true); setError(null);
    try { setText((await api<{ transcript: string }>(`/api/provider/visits/${visitId}/scribe/sessions/${s.id}/transcript`)).transcript); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }

  return (
    <li className="session">
      <div>
        <strong>Recording {n}</strong> <span className="muted small">· {fmtInstantTime(s.createdAt, tz)}</span>{' '}
        {s.audioPurged ? <span className="pill off">Audio deleted</span> : <span className="pill warn">Audio kept until {fmtDayLong(untilDay)}</span>}
      </div>
      <div className="session-actions"><button className="btn small" disabled={busy} onClick={() => void toggle()}>{text === null ? 'View transcript' : 'Hide transcript'}</button></div>
      {error && <p className="error small" role="alert">{error}</p>}
      {text !== null && <pre className="transcript" aria-label="Transcript">{text}</pre>}
    </li>
  );
}
