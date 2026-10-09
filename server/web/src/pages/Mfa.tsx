import { useEffect, useState, type FormEvent } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';

/** First-time authenticator enrolment (mandatory for admins). */
export function MfaEnroll() {
  const { refresh, logout, me } = useAuth();
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ secret: string; otpauthUri: string }>('/api/auth/mfa/enroll/start', { method: 'POST', body: {} })
      .then(setSetup)
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not start setup.'));
  }, []);

  async function confirm(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await api<{ recoveryCodes: string[] }>('/api/auth/mfa/enroll/confirm', { method: 'POST', body: { code } });
      setCodes(r.recoveryCodes);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That did not work.');
      setCode('');
    } finally { setBusy(false); }
  }

  // The recovery codes are shown exactly once. Do not let the route guard move
  // on (it would the instant `refresh()` clears the outstanding step) until the
  // person has acknowledged that they saved them.
  if (codes) {
    return (
      <div className="card narrow auth-card">
        <h1>Save your recovery codes</h1>
        <p>Each code works <strong>once</strong>, if you lose your phone. They are shown <strong>only now</strong> — we store only a scrambled form and cannot show them again.</p>
        <ul className="codes mono">{codes.map((c) => <li key={c}>{c}</li>)}</ul>
        <button className="btn" onClick={() => void navigator.clipboard?.writeText(codes.join('\n'))}>Copy codes</button>
        <label className="check">
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          I have stored these somewhere safe
        </label>
        <button className="btn primary" disabled={!saved} onClick={() => void refresh()}>Continue</button>
      </div>
    );
  }

  return (
    <div className="card narrow auth-card">
      <h1>Set up your authenticator</h1>
      <p>Administrator accounts require a second step at every sign-in. Scan this with an authenticator app (Google Authenticator, 1Password, Authy…), then enter the 6-digit code it shows.</p>
      {setup ? (
        <>
          <div className="qr" aria-label="Authenticator QR code"><QRCodeSVG value={setup.otpauthUri} size={176} marginSize={2} /></div>
          <details><summary>Can't scan? Enter the key manually</summary><p className="mono key">{setup.secret}</p></details>
        </>
      ) : <p className="hint">Preparing…</p>}
      <form onSubmit={confirm}>
        <label>6-digit code
          <input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} required />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn primary" disabled={busy || !setup}>{busy ? 'Checking…' : 'Confirm and continue'}</button>
        <button type="button" className="btn ghost" onClick={() => void logout()}>Sign out</button>
      </form>
      <p className="hint">Signed in as {me?.account.email}.</p>
    </div>
  );
}

/** Second step at every sign-in once enrolled. */
export function MfaVerify() {
  const { refresh, logout } = useAuth();
  const [useRecovery, setUseRecovery] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api('/api/auth/mfa/verify', { method: 'POST', body: useRecovery ? { recoveryCode: value } : { code: value } });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That did not work.');
      setValue('');
      if (err instanceof ApiError && err.status === 401) void refresh(); // locked out → session revoked
    } finally { setBusy(false); }
  }

  return (
    <div className="card narrow auth-card">
      <h1>Enter your code</h1>
      <p>{useRecovery ? 'Enter one of your saved recovery codes. Each works once.' : 'Open your authenticator app and enter the current 6-digit code.'}</p>
      <form onSubmit={submit}>
        <label>{useRecovery ? 'Recovery code' : '6-digit code'}
          <input
            key={String(useRecovery)}
            inputMode={useRecovery ? 'text' : 'numeric'}
            autoComplete="one-time-code"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            required autoFocus
          />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn primary" disabled={busy}>{busy ? 'Checking…' : 'Verify'}</button>
        <button type="button" className="btn ghost" onClick={() => { setUseRecovery(!useRecovery); setValue(''); setError(null); }}>
          {useRecovery ? 'Use my authenticator app' : 'Use a recovery code instead'}
        </button>
        <button type="button" className="btn ghost" onClick={() => void logout()}>Sign out</button>
      </form>
    </div>
  );
}
