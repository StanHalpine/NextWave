import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useClinicTz } from '../clinic';
import { fmtDay, fmtInstantTime, fmtTime12 } from '../lib';
import { errorText, Notice } from '../ui';

interface Mismatch {
  bookingId: string; start: string; localDate: string; localStart: string; service: string; patient: string;
  visitProvider: { id: string; name: string } | null;
  signedBy: { id: string; name: string | null };
  signedAt: string;
}

/**
 * Admin → Notes signed by another provider (rev 2.1). Before rev 2.1 any provider in the right role could sign a visit's note; now only
 * the visit's provider can. Notes signed the old way are listed here, unchanged. If the signer did see the patient, confirm them as the
 * covering provider (the signature is never edited); otherwise leave it flagged, and the visit's provider can add an addendum.
 */
export default function SignatureReview() {
  const tz = useClinicTz();
  const [data, setData] = useState<{ rows: Mismatch[]; more: boolean } | null>(null);
  const [error, setError] = useState<{ text: string; code?: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setData(await api('/api/provider/signature-mismatches')); setError(null); }
    catch (e) { setError({ text: errorText(e), code: e instanceof ApiError ? e.code : undefined }); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function confirm(id: string) {
    setBusy(id);
    try { await api(`/api/provider/visits/${id}/confirm-covering`, { method: 'POST', body: {} }); await load(); }
    catch (e) { setError({ text: errorText(e) }); }
    finally { setBusy(null); }
  }

  return (
    <>
      <p className="crumb"><Link to="/admin">← Admin</Link></p>
      <h1>Notes signed by another provider</h1>
      <p className="lede">Signed before only the visit’s own provider could sign. The signatures are kept exactly as they are.</p>
      {error && <Notice kind="error">{error.text}</Notice>}
      {error?.code?.startsWith('mfa_') && <p><Link className="btn primary" to="/mfa/enroll">Set up your authenticator</Link></p>}
      {!data && !error && <p className="muted">Loading…</p>}
      {data && data.rows.length === 0 && <p className="empty">None. Every signed note was signed by its visit’s provider.</p>}
      {data && data.rows.length > 0 && (
        <div className="table-scroll">
          <table className="table">
            <thead><tr><th>Visit</th><th>Patient</th><th>Service</th><th>Visit’s provider</th><th>Signed by</th><th /></tr></thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.bookingId}>
                  <td className="nowrap">{fmtDay(r.localDate)} · {fmtTime12(r.localStart)}</td>
                  <td><strong>{r.patient}</strong></td>
                  <td>{r.service}</td>
                  <td>{r.visitProvider?.name ?? <span className="muted">Not assigned</span>}</td>
                  <td>{r.signedBy.name ?? 'Unknown'}<div className="muted small">{fmtInstantTime(r.signedAt, tz)}</div></td>
                  <td className="actions">
                    <button className="btn small" disabled={busy === r.bookingId} onClick={() => void confirm(r.bookingId)} title="The signer saw the patient: record them as the visit's covering provider">Confirm as covering provider</button>{' '}
                    <Link className="btn small ghost" to={`/provider/visits/${r.bookingId}`}>Open</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data?.more && <p className="hint">Showing the oldest {data.rows.length}.</p>}
      <p className="hint">Confirming makes the signer the visit’s provider. It never changes the note or its signature, a check-out already recorded keeps the
        provider it recorded, and the change is written to the audit log. If the signer did not see the patient, leave it here: the visit’s provider can add an addendum.</p>
    </>
  );
}
