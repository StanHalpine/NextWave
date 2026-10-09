import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api';
import { PasswordFields } from '../components';

/**
 * Redeems the one-time link an administrator issued. The token travels in the
 * URL FRAGMENT (#token=…) — browsers never send a fragment to the server, so it
 * cannot appear in access logs or Referer headers. It is read once into memory
 * and then scrubbed from the address bar and history.
 */
export default function Setup() {
  const [token, setToken] = useState<string | null>(null);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const m = /(?:^#|&)token=([^&]+)/.exec(window.location.hash);
    if (m) {
      setToken(decodeURIComponent(m[1]!));
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (pw !== pw2) return setError('The two passwords do not match.');
    setBusy(true); setError(null);
    try {
      const r = await api<{ email: string }>('/api/auth/setup', { method: 'POST', body: { token, newPassword: pw } });
      setDone(r.email);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
    } finally { setBusy(false); }
  }

  if (done) {
    return (
      <div className="card narrow auth-card">
        <h1>Password set</h1>
        <p>Your password is saved. Sign in with <strong>{done}</strong>
          {' '}— administrators will then be asked to set up an authenticator app.</p>
        <Link className="btn primary" to="/login">Go to sign-in</Link>
      </div>
    );
  }
  if (!token) {
    return (
      <div className="card narrow auth-card">
        <h1>Setup link needed</h1>
        <p>Open the full link an administrator gave you. It looks like <span className="mono">…/app/setup#token=…</span>.</p>
        <Link className="btn" to="/login">Go to sign-in</Link>
      </div>
    );
  }
  return (
    <div className="card narrow auth-card">
      <h1>Choose your password</h1>
      <p>This one-time link lets you set your own password. No one else will ever know it.</p>
      <form onSubmit={submit}>
        <PasswordFields value={pw} confirm={pw2} onValue={setPw} onConfirm={setPw2} />
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Set password'}</button>
      </form>
    </div>
  );
}
