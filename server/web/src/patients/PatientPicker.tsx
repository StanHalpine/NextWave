import { useEffect, useState } from 'react';
import { api } from '../api';
import { errorText, useDebounced } from '../ui';
import { fmtPhone } from '../lib';
import type { Patient, PatientSummary } from '../types';
import { NewPatientForm } from './PatientForm';

/**
 * Find a patient (search is a POST — a name or number never goes in a URL) or add a new one.
 * Calls `onPick` with the chosen patient's id and a display name.
 */
export function PatientPicker({ value, onPick }: {
  value: { id: string; name: string } | null;
  onPick: (p: { id: string; name: string } | null) => void;
}) {
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 250);
  const [results, setResults] = useState<PatientSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (value || adding || dq.length < 2) { setResults([]); return; }
    let live = true;
    api<{ patients: PatientSummary[] }>('/api/fd/patients/search', { method: 'POST', body: { q: dq } })
      .then((r) => { if (live) { setResults(r.patients); setError(null); } })
      .catch((e) => { if (live) setError(errorText(e)); });
    return () => { live = false; };
  }, [dq, value, adding]);

  if (value) {
    return (
      <div className="picked">
        <strong>{value.name}</strong>
        <button type="button" className="linklike" onClick={() => onPick(null)}>Change</button>
      </div>
    );
  }

  if (adding) {
    return (
      <div className="inline-panel">
        <h3>New patient</h3>
        <NewPatientForm
          onCancel={() => setAdding(false)}
          onCreated={(p: Patient) => { setAdding(false); onPick({ id: p.id, name: `${p.firstName} ${p.lastName}` }); }}
          onUseExisting={(p) => { setAdding(false); onPick({ id: p.id, name: p.name }); }}
        />
      </div>
    );
  }

  return (
    <div className="picker">
      <input
        type="search" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off"
        placeholder="Search by name, phone, email or birth date (YYYY-MM-DD)" aria-label="Find a patient"
      />
      {error && <p className="error" role="alert">{error}</p>}
      {results.length > 0 && (
        <ul className="results" role="listbox">
          {results.map((p) => (
            <li key={p.id}>
              <button type="button" role="option" aria-selected="false" onClick={() => onPick({ id: p.id, name: p.name })}>
                <strong>{p.name}</strong>
                <span className="muted small"> {p.dateOfBirth ? `born ${p.dateOfBirth} · ` : ''}{fmtPhone(p.phone)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {dq.length >= 2 && results.length === 0 && !error && <p className="hint">No one matches “{dq}”.</p>}
      <button type="button" className="btn small" onClick={() => setAdding(true)}>+ New patient</button>
    </div>
  );
}
