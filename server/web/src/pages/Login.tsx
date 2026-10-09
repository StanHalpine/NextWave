import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError } from '../api';
import { useAuth } from '../auth';
import { rememberNext, STEP_ROUTE, useGoNext } from '../components';

/** Signed in with nothing left to do: go where the person was headed (or home). */
function Continue({ next }: { next: string | null }) {
  const goNext = useGoNext();
  useEffect(() => { goNext(next); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

export default function Login() {
  const { login, status, me, reason } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const why = params.get('reason') ?? reason;
  const next = params.get('next');

  // Signed in with no steps outstanding — either arriving here already signed in
  // (a bookmark) or a login that just succeeded. Both continue to `next`; sending
  // them to "/" here would race ahead of it and drop the page they asked for.
  if (status === 'authed' && me && me.needs.length === 0) return <Continue next={next} />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const m = await login(email.trim(), password);
      const step = m.needs[0];
      if (step) { rememberNext(next); navigate(STEP_ROUTE[step], { replace: true }); }
      // no step outstanding: the signed-in branch above takes over and continues to `next`
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in. Check your connection and try again.');
      setPassword('');
    } finally { setBusy(false); }
  }

  return (
    <div className="card narrow auth-card">
      <h1>Staff sign-in</h1>
      {why === 'idle' && <p className="notice">You were signed out after 15 minutes of inactivity.</p>}
      {why === 'expired' && <p className="notice">Your session ended. Please sign in again.</p>}
      <form onSubmit={submit}>
        <label>Email
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </label>
        <label>Password
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
      <p className="hint">Accounts are created by an administrator. Forgot your password? Ask them for a new setup link.</p>
    </div>
  );
}
