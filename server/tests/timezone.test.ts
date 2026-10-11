import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '../src/lib/prisma.js';
import { basePrisma } from '../src/lib/prismaBase.js';
import { setClockForTests } from '../src/lib/clock.js';
import { staffTransaction } from '../src/lib/staffTx.js';
import { suppressNumber } from '../src/lib/smsSuppression.js';
import { canonicalDigits } from '../src/lib/phone.js';
import { twilioSignature } from '../src/routes/smsInbound.js';
import { app } from './helpers.js';
import { makeClinic, makePatient } from './phase2.js';
import { grantLot, makeMembership } from './phase3.js';

/**
 * Raw SQL that binds an instant must say it is UTC (lib/sqlTime.ts): otherwise Postgres reads the stored UTC time in the
 * DATABASE SESSION's zone and every comparison is off by that offset. Each test here puts an instant a few hours either
 * side of the line, so it fails under the unfixed code in whichever direction the session zone points. The whole suite runs
 * with the session in Asia/Kolkata (tests/globalSetup.ts); where a test must see BOTH directions it sets the zone itself.
 */
afterAll(() => setClockForTests(null));

const inZone = <T>(zone: string, fn: (tx: Parameters<Parameters<typeof basePrisma.$transaction>[0]>[0]) => Promise<T>) =>
  basePrisma.$transaction(async (tx) => { await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${zone}'`); return fn(tx); });

describe('a credit grant', () => {
  it('is stamped with the instant it was granted, not that instant read in the database\'s zone', async () => {
    const at = new Date('2031-06-01T12:00:00.000Z');
    const p = await makePatient();
    const m = await makeMembership(p.id, 'PREVENT', '2031-06-01');
    await grantLot({ patientId: p.id, membershipId: m.id, credits: 3, periodStart: '2031-06-01', now: at });
    const lot = await basePrisma.creditLedger.findFirstOrThrow({ where: { patientId: p.id, reason: 'MONTHLY_GRANT' } });
    expect(lot.createdAt.toISOString()).toBe(at.toISOString());
  });
});

describe('a second STOP', () => {
  let n = 0;
  const num = () => { const last4 = String(7000 + ++n + (Date.now() % 900)).padStart(4, '0'); return { typed: `(612) 555-${last4}`, digits: `1612555${last4}` }; };

  /** A number already suppressed at `stopAt`, with an online booking whose consent tick was `hoursFromStop` hours after it. */
  async function setup(hoursFromStop: number) {
    const clinic = await makeClinic();
    const { typed, digits } = num();
    const stopAt = new Date('2031-06-01T12:00:00.000Z');
    await prisma.smsSuppression.create({ data: { phoneDigits: digits, suppressedAt: stopAt, source: 'STOP' } });
    const user = await prisma.user.create({ data: { name: 'Contact', email: '', phone: typed } });
    const start = new Date('2031-07-01T15:00:00.000Z');
    await prisma.booking.create({
      data: {
        userId: user.id, serviceId: clinic.service.id, resourceId: clinic.rooms[0]!.id, staffId: clinic.staff[0]!.id, startTime: start,
        endTime: new Date(start.getTime() + 1800_000), status: 'CONFIRMED', source: 'ONLINE', smsConsentAt: new Date(stopAt.getTime() + hoursFromStop * 3_600_000),
      },
    });
    return { typed, stopAt };
  }
  const stopAgain = (zone: string, typed: string) =>
    inZone(zone, (tx) => suppressNumber(tx as never, (async () => undefined) as never, { phone: typed, source: 'STOP', at: new Date('2031-06-02T12:00:00.000Z') }));

  // The confirmation is sent only when the number was TEXTABLE just before this STOP: i.e. consent newer than the last STOP exists.
  for (const zone of ['America/Los_Angeles', 'Pacific/Auckland', 'UTC']) {
    it(`treats consent given 3 hours AFTER the last STOP as newer, and 3 hours BEFORE it as older (session zone ${zone})`, async () => {
      const after = await setup(+3);
      expect((await stopAgain(zone, after.typed)).changed).toBe(true);
      const before = await setup(-3);
      expect((await stopAgain(zone, before.typed)).changed).toBe(false);
      expect(canonicalDigits(after.typed)).toHaveLength(11);
    });
  }
});

describe('a C reply', () => {
  const TOKEN = 'test-twilio-auth-token';
  const URL_ = 'http://localhost:4000/api/sms/inbound';
  const reply = (from: string) => {
    const params = { From: from, To: '+16125550999', Body: 'C', MessageSid: `SM${Math.random().toString(16).slice(2)}` };
    return request(app).post('/api/sms/inbound').type('form').set('X-Twilio-Signature', twilioSignature(TOKEN, URL_, params)).send(params);
  };

  it('confirms the next appointment by real time: one starting in 3 hours, never one that started 3 hours ago', async () => {
    process.env.TWILIO_AUTH_TOKEN = TOKEN;
    const now = new Date('2031-09-02T15:00:00.000Z');
    setClockForTests(now);
    try {
      const clinic = await makeClinic({ rooms: 2, staff: 2 });
      const last4 = String(4000 + (Date.now() % 5000));
      const patient = await makePatient({ phone: `(612) 555-${last4}`, firstName: 'Ingrid' });
      const user = await prisma.user.create({ data: { name: 'Contact', email: '', phone: '000' } });
      const create = (i: number, offsetHours: number) => {
        const start = new Date(now.getTime() + offsetHours * 3_600_000);
        return prisma.booking.create({
          data: {
            userId: user.id, serviceId: clinic.service.id, resourceId: clinic.rooms[i]!.id, staffId: clinic.staff[i]!.id,
            startTime: start, endTime: new Date(start.getTime() + 1800_000), status: 'CONFIRMED', source: 'FRONT_DESK', patientId: patient.id,
          },
        });
      };
      const earlier = await create(0, -3);
      const later = await create(1, +3);

      const r = await reply(`+1612555${last4}`);
      expect(r.status).toBe(200);
      expect((await prisma.booking.findUniqueOrThrow({ where: { id: later.id } })).patientConfirmedAt).not.toBeNull();
      expect((await prisma.booking.findUniqueOrThrow({ where: { id: earlier.id } })).patientConfirmedAt).toBeNull();
    } finally {
      setClockForTests(null);
      delete process.env.TWILIO_AUTH_TOKEN;
    }
  });
});
