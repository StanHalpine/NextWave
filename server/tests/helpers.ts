import request from 'supertest';
import type { AccountRole } from '@prisma/client';
import { buildApp } from '../src/index.js';
import { prisma } from '../src/lib/prisma.js';
import { hashPassword } from '../src/lib/password.js';
import { currentTotp } from '../src/lib/totp.js';

export const app = buildApp();
export const PASSWORD = 'correct-horse-battery-staple-7';

let n = 0;
export const uniqueEmail = (tag = 'user') => `${tag}-${Date.now()}-${++n}@example.test`;

export async function makeAccount(opts: {
  roles: AccountRole[];
  email?: string;
  staffId?: string | null;
  password?: string;
  mustChangePassword?: boolean;
  active?: boolean;
}) {
  return prisma.account.create({
    data: {
      email: opts.email ?? uniqueEmail(),
      displayName: 'Test Person',
      roles: opts.roles,
      staffId: opts.staffId ?? null,
      passwordHash: await hashPassword(opts.password ?? PASSWORD),
      mustChangePassword: opts.mustChangePassword ?? false,
      active: opts.active ?? true,
    },
  });
}

export interface Signed {
  agent: ReturnType<typeof request.agent>;
  csrf: string;
  state: any;
  /** Present once the account has enrolled TOTP. */
  totpSecret?: string;
}

/** Password step only. */
export async function signIn(email: string, password = PASSWORD): Promise<Signed> {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ email, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { agent, csrf: res.body.csrfToken, state: res.body };
}

/** Sign in AND satisfy every outstanding step, enrolling TOTP if the role needs it. */
export async function signInFully(email: string, password = PASSWORD): Promise<Signed> {
  const s = await signIn(email, password);
  if (s.state.needs.includes('mfa_enroll')) {
    const start = await s.agent.post('/api/auth/mfa/enroll/start').set('x-csrf-token', s.csrf).send({});
    s.totpSecret = start.body.secret as string;
    const conf = await s.agent.post('/api/auth/mfa/enroll/confirm').set('x-csrf-token', s.csrf).send({ code: currentTotp(s.totpSecret) });
    if (conf.status !== 200) throw new Error(`mfa enrol failed: ${JSON.stringify(conf.body)}`);
  }
  const me = await s.agent.get('/api/auth/me');
  s.state = me.body;
  if (me.body.needs.length) throw new Error(`still has outstanding steps: ${me.body.needs}`);
  return s;
}

/** Audit rows are flushed AFTER the response, so poll briefly rather than race. */
export async function auditRows(where: object, minCount = 1, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await prisma.auditLog.findMany({ where, orderBy: { id: 'asc' } });
    if (rows.length >= minCount || Date.now() > deadline) return rows;
    await new Promise((r) => setTimeout(r, 40));
  }
}

let staffN = 0;
/**
 * A FRESH bookable chiropractor per call. Account.staffId is unique (one login
 * per provider record, by design), so tests must not share one.
 */
export async function chiroStaff() {
  return prisma.staff.create({ data: { name: `Test Chiropractor ${++staffN}`, role: 'CHIROPRACTOR' } });
}

/** A confirmed booking with a named patient, for note and read-audit tests. */
export async function makeBooking(patient = { name: 'Zelda Quillfeather', email: 'zelda.q@example.test', phone: '6125550187' }) {
  const service = await prisma.service.findFirstOrThrow({ where: { slug: 'manual-adjustment' } });
  const resource = await prisma.resource.findFirstOrThrow({ where: { type: 'ADJUSTING_ROOM' } });
  const staff = await chiroStaff();
  const user = await prisma.user.create({ data: patient });
  const start = new Date(Date.now() + 3 * 86_400_000);
  const booking = await prisma.booking.create({
    data: {
      userId: user.id, serviceId: service.id, resourceId: resource.id, staffId: staff.id,
      startTime: start, endTime: new Date(start.getTime() + 30 * 60_000), status: 'CONFIRMED',
    },
  });
  return { booking, user, staff, patient };
}

/** JSON.stringify that survives the BigInt ids on AuditLog rows. */
export const blob = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
