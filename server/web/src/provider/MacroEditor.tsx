import { useState, type FormEvent } from 'react';
import { errorText } from '../ui';
import type { MacroLite, NoteSection } from '../types';

export const SECTION_LABEL: Record<NoteSection, string> = {
  SUBJECTIVE: 'Subjective', OBJECTIVE: 'Objective', ASSESSMENT: 'Assessment', PLAN: 'Plan', GENERAL: 'Session-log notes',
};
const ORDER: NoteSection[] = ['SUBJECTIVE', 'OBJECTIVE', 'ASSESSMENT', 'PLAN', 'GENERAL'];

export interface MacroOps {
  add: (m: { section: NoteSection; title: string; body: string }) => Promise<void>;
  update: (id: string, patch: { section?: NoteSection; title?: string; body?: string }) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

/**
 * The list of macros with add / edit / delete, used for a provider's own macros and for an
 * administrator's shared sets. It owns no data: the caller supplies the macros and the three
 * operations, so the same screen serves both.
 */
export function MacroEditor({ macros, ops, noun = 'macro' }: { macros: MacroLite[]; ops: MacroOps; noun?: string }) {
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | 'new' | null>(null);

  async function run(fn: () => Promise<void>) {
    setError(null);
    try { await fn(); } catch (e) { setError(errorText(e)); }
  }
  const bySection = ORDER.map((s) => ({ s, items: macros.filter((m) => m.section === s) })).filter((g) => g.items.length > 0);

  return (
    <div className="stack">
      <p className="hint"><strong>Don’t put patient details in a {noun}.</strong> It is a template that is inserted into any patient’s note: wording, not people.</p>
      {error && <p className="error" role="alert">{error}</p>}
      {bySection.length === 0 && editing !== 'new' && <p className="empty">No {noun}s yet.</p>}
      {bySection.map(({ s, items }) => (
        <section key={s}>
          <div className="label-like">{SECTION_LABEL[s]}</div>
          <ul className="macro-list">
            {items.map((m) => (
              <li key={m.id}>
                {editing === m.id
                  ? <MacroForm initial={m} submitLabel="Save" onCancel={() => setEditing(null)} onSubmit={(v) => run(async () => { await ops.update(m.id, v); setEditing(null); })} />
                  : (
                    <div className="macro-row">
                      <div><strong>{m.title}</strong><div className="macro-body">{m.body}</div></div>
                      <div className="macro-actions">
                        <button type="button" className="btn small" onClick={() => setEditing(m.id)}>Edit</button>
                        <button type="button" className="btn small danger" onClick={() => { if (window.confirm(`Delete “${m.title}”?`)) void run(() => ops.remove(m.id)); }}>Delete</button>
                      </div>
                    </div>
                  )}
              </li>
            ))}
          </ul>
        </section>
      ))}
      {editing === 'new'
        ? <MacroForm submitLabel={`Add ${noun}`} onCancel={() => setEditing(null)} onSubmit={(v) => run(async () => { await ops.add({ section: v.section ?? 'PLAN', title: v.title ?? '', body: v.body ?? '' }); setEditing(null); })} />
        : <div><button type="button" className="btn" onClick={() => setEditing('new')}>Add a {noun}</button></div>}
    </div>
  );
}

function MacroForm({ initial, submitLabel, onSubmit, onCancel }: {
  initial?: MacroLite; submitLabel: string; onCancel: () => void;
  onSubmit: (v: { section?: NoteSection; title?: string; body?: string }) => Promise<void>;
}) {
  const [section, setSection] = useState<NoteSection>(initial?.section ?? 'PLAN');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [body, setBody] = useState(initial?.body ?? '');
  const [busy, setBusy] = useState(false);
  const ok = title.trim() !== '' && body.trim() !== '' && body.length <= 4000;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ok) return;
    setBusy(true);
    try { await onSubmit({ section, title: title.trim(), body }); } finally { setBusy(false); }
  }
  return (
    <form className="macro-form stack" onSubmit={(e) => void submit(e)}>
      <div className="form-grid two">
        <label>Section
          <select value={section} onChange={(e) => setSection(e.target.value as NoteSection)}>
            {ORDER.map((s) => <option key={s} value={s}>{SECTION_LABEL[s]}</option>)}
          </select>
        </label>
        <label>Title<input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} placeholder="e.g. Home stretching" autoFocus /></label>
      </div>
      <label>Text to insert
        <textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000} />
        <span className="hint">{body.length} / 4,000</span>
      </label>
      <div className="sheet-actions">
        <button className="btn primary" disabled={!ok || busy}>{busy ? 'Saving…' : submitLabel}</button>
        <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
