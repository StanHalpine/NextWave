import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';

interface Integration { kind: string; provider: string; enabled: boolean; isStub: boolean }

const LABEL: Record<string, string> = { AI_SCRIBE: 'AI scribe (Bedrock + Transcribe)', FILE_STORAGE: 'File storage (S3)', MESSAGING: 'Messaging (Twilio)' };

export default function AdminHome() {
  const [items, setItems] = useState<Integration[] | null>(null);
  useEffect(() => { api<{ integrations: Integration[] }>('/api/admin/integrations').then((r) => setItems(r.integrations)).catch(() => setItems([])); }, []);

  return (
    <>
      <h1>Admin</h1>
      <div className="grid">
        <Link className="tile" to="/admin/accounts"><h2>Accounts</h2><p>Create logins, assign roles, reset passwords and authenticators.</p></Link>
        <Link className="tile" to="/admin/audit"><h2>Audit log</h2><p>Who accessed or changed what, and when. Append-only.</p></Link>
        <Link className="tile" to="/admin/membership"><h2>Memberships</h2><p>Tiers, monthly credits, rollover, and the perks each tier includes.</p></Link>
        <Link className="tile" to="/admin/promotions"><h2>Promotions</h2><p>Percent or amount off chosen services or products for a range of days; applied at check-out when better than the membership discount.</p></Link>
        <Link className="tile" to="/admin/catalog"><h2>Product catalog</h2><p>Products and service add-ons for the Charges window, their prices, the sales tax on products, and the member discount on products.</p></Link>
        <Link className="tile" to="/admin/macros"><h2>Macro sets</h2><p>Shared text blocks providers insert into their notes, by section and role.</p></Link>
        <Link className="tile" to="/admin/note-signers"><h2>Notes signed by another provider</h2><p>Signed before only the visit’s own provider could sign. Confirm the signer as covering, or leave it flagged.</p></Link>
        <a className="tile" href="/admin.html"><h2>Catalogue &amp; staff</h2><p>Services, prices and credit costs, rooms, bookable staff and their shifts.</p></a>
      </div>

      <h2 className="section">Integrations</h2>
      <p className="hint">Which implementation backs each external service. While a service shows “Development stub” nothing is connected to AWS or Twilio and no real credentials are used. The AI scribe switches itself off in production until storage and transcription are real.</p>
      <table className="table">
        <thead><tr><th>Service</th><th>Provider</th><th>Status</th></tr></thead>
        <tbody>
          {(items ?? []).map((i) => (
            <tr key={i.kind}>
              <td>{LABEL[i.kind] ?? i.kind}</td>
              <td className="mono">{i.provider}</td>
              <td>{i.isStub ? <span className="pill warn">Development stub</span> : <span className="pill ok">Live</span>}</td>
            </tr>
          ))}
          {items === null && <tr><td colSpan={3}>Loading…</td></tr>}
        </tbody>
      </table>
    </>
  );
}
