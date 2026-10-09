import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, ApiError, setCsrf, setSessionLostHandler, type Me, type Role } from './api';
import { idlePhase, secondsUntilSignOut, shouldPing, type IdlePhase } from './idle';

type Status = 'loading' | 'anon' | 'authed';

interface AuthContextValue {
  status: Status;
  me: Me | null;
  /** Why the user is signed out, if the app ended the session ('idle' | 'expired'). */
  reason: string | null;
  idle: { phase: IdlePhase; secondsLeft: number };
  refresh: () => Promise<Me | null>;
  login: (email: string, password: string) => Promise<Me>;
  logout: (reason?: string) => Promise<void>;
  setMe: (me: Me) => void;
  stayActive: () => void;
  hasRole: (...roles: Role[]) => boolean;
}

const Ctx = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}

const INPUT_EVENTS = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'click'] as const;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [me, setMeState] = useState<Me | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [idle, setIdle] = useState<{ phase: IdlePhase; secondsLeft: number }>({ phase: 'active', secondsLeft: 900 });

  const lastInput = useRef(Date.now());
  const lastPing = useRef(Date.now());
  const warning = useRef(false);

  const setMe = useCallback((m: Me) => {
    setCsrf(m.csrfToken);
    setMeState(m);
    setStatus('authed');
    setReason(null);
    lastInput.current = Date.now();
    lastPing.current = Date.now();
  }, []);

  const goAnon = useCallback((why: string | null) => {
    setCsrf('');
    setMeState(null);
    setStatus('anon');
    setReason(why);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const m = await api<Me>('/api/auth/me');
      setMe(m);
      return m;
    } catch (e) {
      goAnon(e instanceof ApiError && e.code === 'idle_timeout' ? 'idle' : e instanceof ApiError && e.code === 'session_expired' ? 'expired' : null);
      return null;
    }
  }, [goAnon, setMe]);

  const login = useCallback(async (email: string, password: string) => {
    const m = await api<Me>('/api/auth/login', { method: 'POST', body: { email, password } });
    setMe(m);
    return m;
  }, [setMe]);

  const logout = useCallback(async (why?: string) => {
    try { await api('/api/auth/logout', { method: 'POST', body: {} }); } catch { /* already gone */ }
    goAnon(why ?? null);
  }, [goAnon]);

  const stayActive = useCallback(() => {
    warning.current = false;
    lastInput.current = Date.now();
    lastPing.current = Date.now();
    setIdle({ phase: 'active', secondsLeft: secondsUntilSignOut(Date.now(), lastInput.current) });
    api('/api/auth/ping', { method: 'POST', body: {} }).catch(() => {});
  }, []);

  // Any API call that comes back 401 means the server ended the session.
  useEffect(() => {
    setSessionLostHandler((code) => goAnon(code === 'idle_timeout' ? 'idle' : 'expired'));
    return () => setSessionLostHandler(null);
  }, [goAnon]);

  useEffect(() => { void refresh(); }, [refresh]);

  // ── inactivity watch ────────────────────────────────────────────────────────
  // Real input events — not API traffic — are what counts as "a person is here".
  // The server's idle clock works the same way; this just warns first.
  useEffect(() => {
    if (status !== 'authed') return;
    const onInput = () => { if (!warning.current) lastInput.current = Date.now(); };
    INPUT_EVENTS.forEach((e) => window.addEventListener(e, onInput, { passive: true }));

    const tick = window.setInterval(() => {
      const now = Date.now();
      const phase = idlePhase(now, lastInput.current);
      warning.current = phase === 'warning';
      setIdle((prev) => {
        const next = { phase, secondsLeft: secondsUntilSignOut(now, lastInput.current) };
        return prev.phase === next.phase && prev.secondsLeft === next.secondsLeft ? prev : next;
      });
      if (phase === 'expired') { void logout('idle'); return; }
      if (phase === 'active' && shouldPing(now, lastInput.current, lastPing.current)) {
        lastPing.current = now;
        api('/api/auth/ping', { method: 'POST', body: {} }).catch(() => {});
      }
    }, 1000);

    return () => {
      INPUT_EVENTS.forEach((e) => window.removeEventListener(e, onInput));
      window.clearInterval(tick);
    };
  }, [status, logout]);

  const value = useMemo<AuthContextValue>(() => ({
    status, me, reason, idle, refresh, login, logout, setMe, stayActive,
    hasRole: (...roles) => !!me && roles.some((r) => me.account.roles.includes(r)),
  }), [status, me, reason, idle, refresh, login, logout, setMe, stayActive]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
