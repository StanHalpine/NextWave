/**
 * Production start-up guards. These run `config.ts` in a child process with
 * NODE_ENV=production and a deliberately wrong environment, and assert the app
 * REFUSES to start — and that the refusal never echoes the connection string.
 */
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

function boot(overrides: { sslmode?: string | null; mfaKey?: string | null; baseUrl?: string | null; env?: Record<string, string> }) {
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.delete('sslmode');
  url.searchParams.delete('ssl');
  if (overrides.sslmode) url.searchParams.set('sslmode', overrides.sslmode);

  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production', DATABASE_URL: url.toString() };
  delete env.MFA_ENCRYPTION_KEY;
  delete env.APP_BASE_URL;
  if (overrides.mfaKey) env.MFA_ENCRYPTION_KEY = overrides.mfaKey;
  if (overrides.baseUrl) env.APP_BASE_URL = overrides.baseUrl;
  delete env.TWILIO_AUTH_TOKEN;
  delete env.CLINIC_PHONE;
  Object.assign(env, overrides.env ?? {});

  const r = spawnSync('npx', ['tsx', '-e', "import('./src/config.ts').catch((e) => { console.error('Error: ' + e.message); process.exit(1); })"], { env, encoding: 'utf8', timeout: 30_000 });
  const out = `${r.stdout}${r.stderr}`;
  return { status: r.status, out, leaksConnection: /postgres(ql)?:\/\//.test(out) || out.includes(new URL(process.env.DATABASE_URL!).host) };
}

const KEY = Buffer.alloc(32, 5).toString('base64');
const HTTPS = 'https://staff.example.test';

describe('production refuses to start when it is not safe', () => {
  it('without TLS to the database', () => {
    const r = boot({ sslmode: null, mfaKey: KEY, baseUrl: HTTPS });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/does not require TLS/);
    expect(r.leaksConnection).toBe(false);
  });
  it('treats sslmode=disable and =prefer as NOT secure', () => {
    for (const mode of ['disable', 'prefer', 'allow']) {
      expect(boot({ sslmode: mode, mfaKey: KEY, baseUrl: HTTPS }).status, mode).not.toBe(0);
    }
  });
  it('without an MFA encryption key (no hard-coded fallback exists)', () => {
    const r = boot({ sslmode: 'require', mfaKey: null, baseUrl: HTTPS });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/MFA_ENCRYPTION_KEY is not set/);
  });
  it('with a key of the wrong length', () => {
    const r = boot({ sslmode: 'require', mfaKey: Buffer.alloc(16).toString('base64'), baseUrl: HTTPS });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/32 bytes/);
  });
  it('without an https APP_BASE_URL', () => {
    expect(boot({ sslmode: 'require', mfaKey: KEY, baseUrl: null }).status).not.toBe(0);
    expect(boot({ sslmode: 'require', mfaKey: KEY, baseUrl: 'http://staff.example.test' }).status).not.toBe(0);
  });
  it('with real text messaging switched on (a provider token) but no clinic phone for the HELP reply', () => {
    const r = boot({ sslmode: 'require', mfaKey: KEY, baseUrl: HTTPS, env: { TWILIO_AUTH_TOKEN: 'x'.repeat(32) } });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/CLINIC_PHONE is not set/);
    expect(r.out).not.toContain('x'.repeat(32));                  // the token is never echoed
    expect(boot({ sslmode: 'require', mfaKey: KEY, baseUrl: HTTPS, env: { TWILIO_AUTH_TOKEN: 'x'.repeat(32), CLINIC_PHONE: '(612) 555-0100' } }).status).toBe(0);
  });
  it('and starts when everything is in order', () => {
    expect(boot({ sslmode: 'require', mfaKey: KEY, baseUrl: HTTPS }).status).toBe(0);
    expect(boot({ sslmode: 'verify-full', mfaKey: KEY, baseUrl: HTTPS }).status).toBe(0);
  });
});
