import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { PasswordFields } from '../components';

export default function ChangePassword() {
  const { refresh, logout } = useAuth();
  const [current, setCurrent] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (pw !== pw2) return setError('The two new passwords do not match.');
    setBusy(true); setError(null);
    try {
      await api('/api/auth/change-password', { method: 'POST', body: { currentPassword: current, newPassword: pw } });
      await refresh(); // outstanding steps may have changed; the route guard takes it from here
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change the password.');
    } finally { setBusy(false); }
  }

  return (
    <div className="card narrow auth-card">
      <h1>Change your password</h1>
      <p>You need to choose a new password before continuing.</p>
      <form onSubmit={submit}>
        <label>Current password
          <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </label>
        <PasswordFields value={pw} confirm={pw2} onValue={setPw} onConfirm={setPw2} />
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Change password'}</button>
        <button type="button" className="btn ghost" onClick={() => void logout()}>Sign out</button>
      </form>
    </div>
  );
}
