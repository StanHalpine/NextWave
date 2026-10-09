/**
 * Thin fetch wrapper for the staff API.
 *
 * Authentication is a session cookie (httpOnly — this code cannot read it, which
 * is the point). Writes additionally carry the per-session CSRF token the server
 * hands back from /api/auth/me and /api/auth/login.
 */

export type Role = 'FRONT_DESK' | 'ADMIN' | 'PROVIDER_CHIRO' | 'PROVIDER_NP' | 'PROVIDER_NURSE';
export type Need = 'change_password' | 'mfa_enroll' | 'mfa_verify';

export interface Me {
  account: { id: string; email: string; displayName: string; roles: Role[]; staffId: string | null; mfaEnabled: boolean };
  needs: Need[];
  csrfToken: string;
  idleSecondsRemaining: number;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string | undefined, message: string, public body: unknown) {
    super(message);
  }
}

let csrf = '';
export const setCsrf = (t: string) => { csrf = t; };

let onSessionLost: ((code: string | undefined) => void) | null = null;
export const setSessionLostHandler = (fn: typeof onSessionLost) => { onSessionLost = fn; };

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrf) headers['x-csrf-token'] = csrf;

  const res = await fetch(path, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // A 401 on anything but the sign-in calls themselves means the session is gone.
    if (res.status === 401 && !path.startsWith('/api/auth/login') && !path.startsWith('/api/auth/mfa') && !path.startsWith('/api/auth/setup')) {
      onSessionLost?.(body.code);
    }
    throw new ApiError(res.status, body.code, body.error ?? `Request failed (${res.status})`, body);
  }
  return body as T;
}
