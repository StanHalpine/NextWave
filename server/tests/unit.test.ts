import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { hashPassword, validatePassword, verifyPassword } from '../src/lib/password.js';
import { decryptSecret, encryptSecret, sha256Hex } from '../src/lib/crypto.js';
import { currentTotp, newRecoveryCodes, newTotpSecret, verifyTotp } from '../src/lib/totp.js';
import { redact, sanitizeError, logger } from '../src/lib/logger.js';
import { ABSOLUTE_MS, computeNeeds, evaluateSession, IDLE_MS } from '../src/lib/sessions.js';

const KEY = Buffer.alloc(32, 9);

describe('passwords', () => {
  it('hashes with argon2id and verifies', async () => {
    const h = await hashPassword('a-long-enough-passphrase');
    expect(h.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(h, 'a-long-enough-passphrase')).toBe(true);
    expect(await verifyPassword(h, 'wrong')).toBe(false);
  });
  it('treats a corrupt stored hash as a wrong password, not an error', async () => {
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
  });
  it('enforces the policy', () => {
    expect(validatePassword('short')).toMatch(/at least 12/);
    expect(validatePassword('password1234')).toMatch(/too common/);
    expect(validatePassword('aaaaaaaaaaaa')).toMatch(/repeated/);
    expect(validatePassword('jane.doe@clinic.test', { email: 'jane.doe@clinic.test' })).toMatch(/email/);
    expect(validatePassword('janedoe-is-here-1', { email: 'janedoe@clinic.test' })).toMatch(/email/);
    expect(validatePassword('a-genuinely-fine-passphrase', { email: 'x@y.test' })).toBeNull();
  });
});

describe('secret encryption', () => {
  it('round-trips and uses a fresh IV each time', () => {
    const a = encryptSecret('JBSWY3DPEHPK3PXP', KEY);
    const b = encryptSecret('JBSWY3DPEHPK3PXP', KEY);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, KEY)).toBe('JBSWY3DPEHPK3PXP');
  });
  it('rejects tampering and the wrong key', () => {
    const blob = encryptSecret('secret', KEY);
    const parts = blob.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decryptSecret(parts.join('.'), KEY)).toThrow();
    expect(() => decryptSecret(blob, Buffer.alloc(32, 1))).toThrow();
  });
  it('never stores anything resembling the plaintext', () => {
    expect(encryptSecret('JBSWY3DPEHPK3PXP', KEY)).not.toContain('JBSWY3DPEHPK3PXP');
  });
});

describe('TOTP', () => {
  it('accepts the current code and rejects a wrong one', () => {
    const s = newTotpSecret();
    expect(verifyTotp(s, currentTotp(s), null).ok).toBe(true);
    expect(verifyTotp(s, '000000', null).ok).toBe(false);
    expect(verifyTotp(s, 'abcdef', null).ok).toBe(false);
  });
  it('blocks replay of an already-used time step', () => {
    const s = newTotpSecret();
    const first = verifyTotp(s, currentTotp(s), null);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // the same code, presented again after that step was recorded
    expect(verifyTotp(s, currentTotp(s), first.timeStep).ok).toBe(false);
  });
  it('generates 10 distinct recovery codes whose hashes are stored, not the codes', () => {
    const { plain, hashes } = newRecoveryCodes();
    expect(plain).toHaveLength(10);
    expect(new Set(plain).size).toBe(10);
    expect(plain.every((c) => /^[a-z0-9]{5}-[a-z0-9]{5}$/.test(c))).toBe(true);
    expect(hashes).not.toContain(plain[0]);
    expect(hashes[0]).toBe(sha256Hex(plain[0]!));
  });
});

describe('session policy', () => {
  const t0 = new Date('2026-10-09T12:00:00Z');
  const base = { lastActivityAt: t0, expiresAt: new Date(t0.getTime() + ABSOLUTE_MS), revokedAt: null };
  const ok = { active: true };
  const at = (ms: number) => new Date(t0.getTime() + ms);

  it('is valid inside the idle window', () => {
    expect(evaluateSession(base, ok, at(IDLE_MS - 1000))).toBe('ok');
  });
  it('expires at exactly 15 minutes of inactivity', () => {
    expect(evaluateSession(base, ok, at(IDLE_MS))).toBe('idle');
    expect(evaluateSession(base, ok, at(IDLE_MS + 60_000))).toBe('idle');
  });
  it('enforces the absolute cap even for a continuously active session', () => {
    const active = { ...base, lastActivityAt: at(ABSOLUTE_MS - 1000) };
    expect(evaluateSession(active, ok, at(ABSOLUTE_MS))).toBe('expired');
  });
  it('honours revocation and deactivation', () => {
    expect(evaluateSession({ ...base, revokedAt: t0 }, ok, t0)).toBe('revoked');
    expect(evaluateSession(base, { active: false }, t0)).toBe('inactive');
  });
});

describe('sign-in steps', () => {
  const session = (verified: boolean) => ({ mfaVerifiedAt: verified ? new Date() : null });
  it('requires MFA enrolment for admins', () => {
    expect(computeNeeds({ roles: ['ADMIN'], mustChangePassword: false, mfaEnabledAt: null }, session(false))).toEqual(['mfa_enroll']);
  });
  it('requires a code each session once enrolled', () => {
    const acct = { roles: ['ADMIN' as const], mustChangePassword: false, mfaEnabledAt: new Date() };
    expect(computeNeeds(acct, session(false))).toEqual(['mfa_verify']);
    expect(computeNeeds(acct, session(true))).toEqual([]);
  });
  it('requires MFA enrolment of every provider role (the Phase 4 gate), and a code each session once enrolled', () => {
    for (const role of ['PROVIDER_CHIRO', 'PROVIDER_NP', 'PROVIDER_NURSE'] as const) {
      expect(computeNeeds({ roles: [role], mustChangePassword: false, mfaEnabledAt: null }, session(false)), role).toEqual(['mfa_enroll']);
      expect(computeNeeds({ roles: [role], mustChangePassword: false, mfaEnabledAt: new Date() }, session(false)), role).toEqual(['mfa_verify']);
      expect(computeNeeds({ roles: [role], mustChangePassword: false, mfaEnabledAt: new Date() }, session(true)), role).toEqual([]);
    }
  });
  it('still lets the front desk sign in without it', () => {
    expect(computeNeeds({ roles: ['FRONT_DESK'], mustChangePassword: false, mfaEnabledAt: null }, session(false))).toEqual([]);
  });
  it('puts the password change first', () => {
    expect(computeNeeds({ roles: ['ADMIN'], mustChangePassword: true, mfaEnabledAt: null }, session(false))).toEqual(['change_password', 'mfa_enroll']);
  });
});

describe('PHI-safe logging', () => {
  const PHI = ['zelda', 'Quillfeather', '612-555-0187', '6125550187'];
  const leaks = (s: string) => PHI.filter((p) => s.toLowerCase().includes(p.toLowerCase()));

  it('never logs a Prisma validation message (it embeds the query arguments)', () => {
    const err = new Prisma.PrismaClientValidationError(
      'Invalid `prisma.user.create()` invocation: data: { name: "Zelda Quillfeather", email: "zelda.q@example.test", phone: "6125550187" }',
      { clientVersion: '6.0.0' },
    );
    const out = sanitizeError(err);
    expect(out.errorClass).toBe('PrismaClientValidationError');
    expect(leaks(JSON.stringify(out))).toEqual([]);
  });
  it('logs only code, model and field NAMES for known Prisma errors', () => {
    const err = new Prisma.PrismaClientKnownRequestError('Unique constraint failed: email = zelda.q@example.test', {
      code: 'P2002', clientVersion: '6.0.0', meta: { modelName: 'User', target: ['email'], cause: 'zelda.q@example.test' },
    });
    const out = sanitizeError(err);
    expect(out.message).toBe('Prisma P2002 model=User fields=email');
    expect(leaks(JSON.stringify(out))).toEqual([]);
  });
  it('redacts emails, phone numbers and quoted values from generic errors', () => {
    const out = sanitizeError(new Error('failed for zelda.q@example.test at 612-555-0187 name "Zelda Quillfeather"'));
    expect(leaks(JSON.stringify(out))).toEqual([]);
    expect(redact('call 612-555-0187')).toContain('[number]');
  });
  it('reports only field paths for Zod failures', async () => {
    const { z } = await import('zod');
    const r = z.object({ email: z.string().email() }).safeParse({ email: 'zelda-not-an-email' });
    if (r.success) throw new Error('expected failure');
    const out = sanitizeError(r.error);
    expect(out.message).toBe('Validation failed at: email');
    expect(leaks(JSON.stringify(out))).toEqual([]);
  });
  it('emits one JSON line with class + request id and nothing from the message of a Prisma error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logger.error('holds_create_failed', new Prisma.PrismaClientValidationError('name: "Zelda Quillfeather"', { clientVersion: '6' }));
    const line = String(spy.mock.calls[0]?.[0]);
    spy.mockRestore();
    const parsed = JSON.parse(line);
    expect(parsed).toMatchObject({ level: 'error', event: 'holds_create_failed', errorClass: 'PrismaClientValidationError' });
    expect(leaks(line)).toEqual([]);
  });
});
