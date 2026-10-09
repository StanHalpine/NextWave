import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { errorText, Modal, useDebounced } from '../ui';
import { fmtPhone } from '../lib';
import type { PatientSummary } from '../types';
import { NewPatientForm } from '../patients/PatientForm';
import FrontDeskNav from './FrontDeskNav';

/** Patient directory: one search box, results as a table. Search is a POST so nothing personal is in a URL. */
export default function Patients() {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 250);
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<PatientSummary[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);

  useEffect(() => { setPage(0); }, [dq]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    api<{ patients: PatientSummary[]; hasMore: boolean }>('/api/fd/patients/search', { method: 'POST', body: { q: dq, page } })
      .then((r) => { if (live) { setRows(r.patients); setHasMore(r.hasMore); setError(null); } })
      .catch((e) => { if (live) setError(errorText(e)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [dq, page]);

  return (
    <>
      <FrontDeskNav />
      <div className="page-head">
        <div>
          <h1>Patients</h1>
          <p className="lede">Search by name, phone number, email, or birth date (YYYY-MM-DD).</p>
        </div>
        <button className="btn primary" onClick={() => setAdding(true)}>+ New patient</button>
      </div>

      <div className="filters">
        <label style={{ flex: 1, maxWidth: 460 }}>Find a patient
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" autoFocus placeholder="Ingrid, 555-0142, ingrid@…, 1984-03-09" />
        </label>
      </div>

      {error && <p className="error" role="alert">{error}</p>}
      <table className="table" aria-busy={loading}>
        <thead><tr><th>Name</th><th>Born</th><th>Phone</th><th>Email</th><th>Texts</th></tr></thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id} className="clickable" onClick={() => nav(`/front-desk/patients/${p.id}`)}>
              <td>
                <Link to={`/front-desk/patients/${p.id}`} onClick={(e) => e.stopPropagation()}>{p.name}</Link>
                {p.preferredName && <span className="muted small"> “{p.preferredName}”</span>}
              </td>
              <td>{p.dateOfBirth ?? <span className="muted">—</span>}</td>
              <td>{fmtPhone(p.phone)}</td>
              <td>{p.email ?? <span className="muted">—</span>}</td>
              <td>{p.smsOptIn ? <span className="pill ok">consented</span> : <span className="pill off">no consent</span>}</td>
            </tr>
          ))}
          {!loading && rows.length === 0 && <tr><td colSpan={5} className="muted">{dq ? 'No one matches that search.' : 'No patients yet. Add the first one.'}</td></tr>}
        </tbody>
      </table>
      {(page > 0 || hasMore) && (
        <div className="pager">
          <button className="btn small" disabled={page === 0} onClick={() => setPage(page - 1)}>← Previous</button>
          <span className="muted small">Page {page + 1}</span>
          <button className="btn small" disabled={!hasMore} onClick={() => setPage(page + 1)}>Next →</button>
        </div>
      )}

      {adding && (
        <Modal title="New patient" wide onClose={() => setAdding(false)}>
          <NewPatientForm
            onCancel={() => setAdding(false)}
            onCreated={(p) => nav(`/front-desk/patients/${p.id}`)}
            onUseExisting={(p) => nav(`/front-desk/patients/${p.id}`)}
          />
        </Modal>
      )}
    </>
  );
}
