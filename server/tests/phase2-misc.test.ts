import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '../src/lib/prisma.js';
import { setClockForTests, now } from '../src/lib/clock.js';
import { config } from '../src/config.js';
import { isValidUsPhone, phoneDigits, toE164 } from '../src/lib/phone.js';
import { app, auditRows, blob, makeAccount, signInFully } from './helpers.js';
import { patch, makePatient, makeClinic } from './phase2.js';

describe('service documentation type (SOAP vs session log)', () => {
  it('is seeded per the owner\'s list: SOAP for the six named services, session log for everything else', async () => {
    const rows = await prisma.service.findMany({ where: { slug: { in: ['manual-adjustment', 'spinal-postural-exam', 'functional-medicine-consult', 'iv-therapy', 'vitamin-shots', 'biomarker-testing'] } } });
    expect(rows.length).toBeGreaterThanOrEqual(6);
    for (const r of rows) expect(r.documentationType, r.slug).toBe('SOAP');

    for (const slug of ['hyperbaric-oxygen-therapy', 'red-light-therapy', 'body-composition']) {
      const timed = await prisma.service.findMany({ where: { slug } });
      for (const r of timed) expect(r.documentationType, slug).toBe('SESSION_LOG');
    }
  });

  it('defaults a NEW service to the session log, so nothing is silently a full clinical encounter', async () => {
    const { service } = await makeClinic();
    expect(service.documentationType).toBe('SESSION_LOG');
  });

  it('can be changed by an admin only, validated, and the change is audited from → to', async () => {
    const admin = await signInFully((await makeAccount({ roles: ['ADMIN'] })).email);
    const fd = await signInFully((await makeAccount({ roles: ['FRONT_DESK'] })).email);
    const { service } = await makeClinic();

    expect((await patch(fd, `/api/admin/services/${service.id}`, { documentationType: 'SOAP' })).status).toBe(403);
    expect((await patch(admin, `/api/admin/services/${service.id}`, { documentationType: 'FREE_TEXT' })).status).toBe(400);

    const res = await patch(admin, `/api/admin/services/${service.id}`, { documentationType: 'SOAP' });
    expect(res.status).toBe(200);
    expect(res.body.service.documentationType).toBe('SOAP');
    expect((await prisma.service.findUniqueOrThrow({ where: { id: service.id } })).documentationType).toBe('SOAP');

    const rows = await auditRows({ resourceType: 'service', resourceId: service.id, action: 'UPDATE' });
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0]!.meta)).toContain('SESSION_LOG');
    expect(JSON.stringify(rows[0]!.meta)).toContain('SOAP');

    // Saving the same value again is not a change.
    await patch(admin, `/api/admin/services/${service.id}`, { documentationType: 'SOAP' });
    expect(await auditRows({ resourceType: 'service', resourceId: service.id, action: 'UPDATE' })).toHaveLength(1);

    const list = await admin.agent.get('/api/admin/services');
    expect(list.body.services.find((s: any) => s.id === service.id).documentationType).toBe('SOAP');
  });
});

describe('audit resource types', () => {
  it('records the legacy booking-contact lookups as booking_contact, not patient', async () => {
    const admin = await signInFully((await makeAccount({ roles: ['ADMIN'] })).email);
    await admin.agent.post('/api/patients/search').set('x-csrf-token', admin.csrf).send({ email: 'someone@example.test' });
    const rows = await auditRows({ resourceType: 'booking_contact', action: 'READ' });
    expect(rows.length).toBeGreaterThan(0);
  });

  it('records writes to the Patient table through the client extension as patient', async () => {
    const p = await makePatient();
    // makePatient writes with the audited client: that is the extension at work.
    const rows = await auditRows({ resourceType: 'patient', resourceId: p.id, action: 'CREATE' });
    expect(rows).toHaveLength(1);
    expect(blob(rows)).not.toContain(p.lastName);
  });
});

describe('clock', () => {
  it('is the real time unless a test pins it, and refuses to be pinned outside a test', () => {
    const before = Date.now();
    const real = now().getTime();
    expect(real).toBeGreaterThanOrEqual(before);
    expect(real - before).toBeLessThan(2000);

    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => setClockForTests(new Date('2030-01-01T00:00:00Z'))).toThrow();
    } finally {
      process.env.NODE_ENV = original;
    }
    setClockForTests(new Date('2030-01-01T00:00:00Z'));
    expect(now().toISOString()).toBe('2030-01-01T00:00:00.000Z');
    setClockForTests(null);
    expect(now().getFullYear()).toBeLessThan(2030);
  });
});

describe('phone numbers', () => {
  it('accept US numbers in common shapes and refuse the rest', () => {
    for (const ok of ['6125550142', '(612) 555-0142', '1-612-555-0142', '+1 612 555 0142']) {
      expect(isValidUsPhone(ok), ok).toBe(true);
      expect(toE164(ok), ok).toBe('+16125550142');
    }
    for (const bad of ['', '555-0142', '612555014', '26125550142', 'call the office']) {
      expect(isValidUsPhone(bad), bad).toBe(false);
      expect(toE164(bad), bad).toBeNull();
    }
    expect(phoneDigits('(612) 555-0142')).toBe('6125550142');
  });
});

describe('configuration and the retired shared gate', () => {
  it('has the shared Basic-auth gate OFF and the in-process job timer OFF by default', () => {
    expect(config.basicAuthGate).toBe(false);
    expect(config.jobsInProcess).toBe(false);
    expect(config.jobsIntervalMin).toBeGreaterThanOrEqual(1);
  });

  it('does not challenge a browser for Basic credentials on the staff surface', async () => {
    for (const url of ['/dashboard.html', '/admin.html', '/app', '/api/services']) {
      const r = await request(app).get(url);
      expect(r.headers['www-authenticate'], url).toBeUndefined();
      expect(r.status, url).not.toBe(401 /* the HTML pages are public shells; their DATA calls are what is protected */);
    }
    // …while the data behind them still demands an individual login.
    expect((await request(app).get('/api/front-desk/schedule?date=2026-10-13')).status).toBe(401);
  });
});
