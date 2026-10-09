import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './auth';
import type { Need, Role } from './api';
import { MODULES, ROLE_LABEL } from './modules';

export const STEP_ROUTE: Record<Need, string> = {
  change_password: '/change-password',
  mfa_enroll: '/mfa/enroll',
  mfa_verify: '/mfa/verify',
};

const NEXT_KEY = 'nw.next';

/**
 * Sign-in can take several steps (password, change-password, MFA). The page the
 * person was trying to reach must survive all of them, so it is parked here for
 * the duration — a path only, validated again by useGoNext() when it is used.
 */
export function rememberNext(next: string | null) {
  try { if (next) sessionStorage.setItem(NEXT_KEY, next); else sessionStorage.removeItem(NEXT_KEY); } catch { /* storage blocked: fall back to the home page */ }
}
function takeNext(): string | null {
  try { const v = sessionStorage.getItem(NEXT_KEY); sessionStorage.removeItem(NEXT_KEY); return v; } catch { return null; }
}

function GoNext() {
  const go = useGoNext();
  useEffect(() => { go(takeNext()); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return <Splash />;
}

/** Where to send someone after sign-in. Only internal paths — never an open redirect. */
export function useGoNext() {
  const navigate = useNavigate();
  return (next: string | null) => {
    if (next && next.startsWith('/app/')) return navigate(next.slice(4) || '/', { replace: true });
    if (next === '/dashboard.html' || next === '/admin.html') { window.location.assign(next); return; }
    navigate('/', { replace: true });
  };
}

export function Splash() {
  return <div className="splash" role="status" aria-live="polite">Loading…</div>;
}

export function Forbidden() {
  return (
    <div className="card narrow">
      <h1>Not available to your role</h1>
      <p>Your account does not have access to this part of the system. If you think it should, ask an administrator.</p>
      <Link className="btn" to="/">Back to the staff app</Link>
    </div>
  );
}

/** Gate for pages that need a fully signed-in user (optionally with one of `roles`). */
export function Protected({ roles, children }: { roles?: Role[]; children: ReactNode }) {
  const { status, me } = useAuth();
  const loc = useLocation();
  if (status === 'loading') return <Splash />;
  if (status === 'anon' || !me) return <Navigate to={`/login?next=${encodeURIComponent('/app' + loc.pathname)}`} replace />;
  const step = me.needs[0];
  if (step) return <Navigate to={STEP_ROUTE[step]} replace />;
  if (roles && !roles.some((r) => me.account.roles.includes(r))) return <Forbidden />;
  return <Layout>{children}</Layout>;
}

/** Gate for the sign-in steps themselves: needs a session, but only the matching outstanding step. */
export function StepGate({ need, children }: { need: Need; children: ReactNode }) {
  const { status, me } = useAuth();
  if (status === 'loading') return <Splash />;
  if (status === 'anon' || !me) return <Navigate to="/login" replace />;
  const first = me.needs[0];
  if (!first) return <GoNext />; // every step is done — continue to where they were headed
  if (first !== need) return <Navigate to={STEP_ROUTE[first]} replace />;
  return <>{children}</>;
}

export function Layout({ children }: { children: ReactNode }) {
  const { me, logout, hasRole } = useAuth();
  if (!me) return null;
  const visible = MODULES.filter((m) => hasRole(...m.roles));
  // The calendar and the front desk columns need the room; the other pages read better narrow.
  const wide = /^\/(schedule|front-desk)/.test(useLocation().pathname);
  return (
    <>
      <header className="topnav">
        <Link to="/" className="brand">NextWave <span>Staff</span></Link>
        <nav aria-label="Modules">
          {visible.map((m) => m.href
            ? <a key={m.key} href={m.href}>{m.label}</a>
            : <NavLink key={m.key} to={m.to!}>{m.label}</NavLink>)}
          {hasRole('ADMIN') && <NavLink to="/admin">Admin</NavLink>}
        </nav>
        <div className="who">
          <span className="name">{me.account.displayName}</span>
          <span className="roles">{me.account.roles.map((r) => ROLE_LABEL[r]).join(' · ')}</span>
        </div>
        <button className="btn ghost" onClick={() => void logout()}>Sign out</button>
      </header>
      <main className={`page${wide ? ' wide' : ''}`}>{children}</main>
      <IdleWarning />
    </>
  );
}

/** Shown from 14 minutes of inactivity; the session ends at 15. */
export function IdleWarning() {
  const { idle, stayActive } = useAuth();
  const [shown, setShown] = useState(false);
  useEffect(() => setShown(idle.phase === 'warning'), [idle.phase]);
  if (!shown) return null;
  const m = Math.floor(idle.secondsLeft / 60);
  const s = String(idle.secondsLeft % 60).padStart(2, '0');
  return (
    <div className="modal-backdrop" role="alertdialog" aria-modal="true" aria-labelledby="idle-title">
      <div className="modal">
        <h2 id="idle-title">Still there?</h2>
        <p>
          For patient privacy you will be signed out in <strong className="mono">{m}:{s}</strong> because
          there has been no activity.
        </p>
        <button className="btn primary" autoFocus onClick={stayActive}>Stay signed in</button>
      </div>
    </div>
  );
}

export function PasswordFields(props: {
  value: string; confirm: string; onValue: (v: string) => void; onConfirm: (v: string) => void; label?: string;
}) {
  return (
    <>
      <label>{props.label ?? 'New password'}
        <input type="password" autoComplete="new-password" value={props.value} onChange={(e) => props.onValue(e.target.value)} required minLength={12} />
      </label>
      <label>Confirm new password
        <input type="password" autoComplete="new-password" value={props.confirm} onChange={(e) => props.onConfirm(e.target.value)} required />
      </label>
      <p className="hint">At least 12 characters. A passphrase of a few unrelated words works well. Avoid common passwords and anything containing your email.</p>
    </>
  );
}
