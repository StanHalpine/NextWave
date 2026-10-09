import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '../src/lib/prisma.js';
import { app, auditRows, blob, chiroStaff, makeAccount, signInFully } from './helpers.js';
import { del, makeClinic, makePatient, patch, post } from './phase2.js';

const fdLogin = async () => signInFully((await makeAccount({ roles: ['FRONT_DESK'] })).email);
let seq = 0;
const uniq = () => `Zq${Date.now().toString(36)}${++seq}`;

// Distinct phone and email per call: the duplicate check (correctly) fires on a shared one.
let phoneN = 0;
const valid = (lastName = uniq()) => ({
  firstName: 'Ingrid', lastName, phone: `(612) 555-${String(2000 + ++phoneN).padStart(4, '0')}`,
  email: `Ingrid.${lastName}@Example.test`, dateOfBirth: '1984-03-09',
});

describe('patients: access', () => {
  it('is closed to anonymous callers, providers and patients; open to front desk and admin', async () => {
    for (const [m, u] of [['post', '/api/fd/patients/search'], ['post', '/api/fd/patients'], ['get', '/api/fd/patients/x']] as const) {
      expect((await (request(app) as any)[m](u).send({})).status, u).toBe(401);
    }
    const staff = await chiroStaff();
    const prov = await signInFully((await makeAccount({ roles: ['PROVIDER_CHIRO'], staffId: staff.id })).email);
    expect((await post(prov, '/api/fd/patients/search', {})).status).toBe(403);
    expect((await post(prov, '/api/fd/patients', valid())).status).toBe(403);

    const fd = await fdLogin();
    expect((await post(fd, '/api/fd/patients/search', {})).status).toBe(200);
    const admin = await signInFully((await makeAccount({ roles: ['ADMIN'] })).email);
    expect((await post(admin, '/api/fd/patients/search', {})).status).toBe(200);
  });

  it('requires the CSRF token on writes', async () => {
    const fd = await fdLogin();
    expect((await fd.agent.post('/api/fd/patients').send(valid())).status).toBe(403);
  });
});

describe('patients: create and read', () => {
  it('creates a patient, normalises the phone and email, and audits without recording values', async () => {
    const fd = await fdLogin();
    const body = valid();
    const res = await post(fd, '/api/fd/patients', body);
    expect(res.status).toBe(201);
    const p = res.body.patient;
    expect(p.email).toBe(body.email.toLowerCase());
    expect(p.dateOfBirth).toBe('1984-03-09');
    expect(p.smsOptIn).toBe(false); // consent is never assumed

    const stored = await prisma.patient.findUniqueOrThrow({ where: { id: p.id } });
    expect(stored.phoneDigits).toBe(body.phone.replace(/\D/g, ''));

    const rows = await auditRows({ resourceType: 'patient', resourceId: p.id, action: 'CREATE' });
    expect(rows).toHaveLength(1);
    expect(blob(rows)).not.toContain(body.lastName);
    expect(blob(rows)).not.toContain(body.phone.replace(/\D/g, '').slice(3));
    expect(blob(rows)).not.toContain('1984');
  });

  it('rejects bad input without echoing it', async () => {
    const fd = await fdLogin();
    const cases = [
      { ...valid(), phone: '12' },
      { ...valid(), email: 'not-an-email' },
      { ...valid(), dateOfBirth: '2999-01-01' },
      { ...valid(), ssn: '123-45-6789' },        // unknown field — strict schema
      { ...valid(), firstName: '' },
    ];
    for (const c of cases) {
      const r = await post(fd, '/api/fd/patients', c);
      expect(r.status, JSON.stringify(Object.keys(c))).toBe(400);
      expect(blob(r.body)).not.toContain('123-45-6789');
    }
  });

  it('warns about a likely duplicate, and lets the desk confirm it is a different person', async () => {
    const fd = await fdLogin();
    const body = valid();
    expect((await post(fd, '/api/fd/patients', body)).status).toBe(201);
    const again = await post(fd, '/api/fd/patients', body);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('possible_duplicate');
    expect(again.body.matches.length).toBeGreaterThan(0);
    const forced = await post(fd, '/api/fd/patients', { ...body, confirmNotDuplicate: true });
    expect(forced.status).toBe(201);
  });

  it('reads one patient and writes a READ audit row naming the record', async () => {
    const fd = await fdLogin();
    const p = (await post(fd, '/api/fd/patients', valid())).body.patient;
    const res = await fd.agent.get(`/api/fd/patients/${p.id}`);
    expect(res.status).toBe(200);
    expect(res.body.patient.firstName).toBe('Ingrid');
    expect(await auditRows({ resourceType: 'patient', resourceId: p.id, action: 'READ' })).toHaveLength(1);
    expect((await fd.agent.get('/api/fd/patients/does-not-exist')).status).toBe(404);
  });
});

describe('patients: search', () => {
  it('finds by name prefix, phone fragment, email and birth date — via POST only', async () => {
    const fd = await fdLogin();
    const last = uniq();
    const created = (await post(fd, '/api/fd/patients', { ...valid(last), phone: '6125550177', dateOfBirth: '1971-11-30' })).body.patient;

    const byName = await post(fd, '/api/fd/patients/search', { q: `ingr ${last.slice(0, 6).toLowerCase()}` });
    expect(byName.body.patients.map((x: any) => x.id)).toContain(created.id);
    expect((await post(fd, '/api/fd/patients/search', { q: '555-0177' })).body.patients.map((x: any) => x.id)).toContain(created.id);
    expect((await post(fd, '/api/fd/patients/search', { q: created.email.toUpperCase() })).body.patients.map((x: any) => x.id)).toContain(created.id);
    expect((await post(fd, '/api/fd/patients/search', { q: '1971-11-30' })).body.patients.map((x: any) => x.id)).toContain(created.id);
    expect((await post(fd, '/api/fd/patients/search', { q: 'nobody-by-this-name-xyz' })).body.patients).toEqual([]);

    // A GET with the same term must not exist: names and numbers do not belong in URLs.
    expect((await fd.agent.get(`/api/fd/patients/search?q=${last}`)).status).toBe(404);
  });

  it('audits every search without recording the search term, and does not dedupe them', async () => {
    const fd = await fdLogin();
    const term = `Secret${uniq()}`;
    await post(fd, '/api/fd/patients/search', { q: term });
    await post(fd, '/api/fd/patients/search', { q: term });
    const rows = await auditRows({ resourceType: 'patient', action: 'READ', actorAccountId: fd.state.account?.id ?? undefined }, 2);
    expect(rows.filter((r) => JSON.stringify(r.meta ?? {}).includes('"search":true')).length).toBeGreaterThanOrEqual(2);
    expect(blob(rows)).not.toContain(term);
  });

  it('pages results', async () => {
    const fd = await fdLogin();
    const r = await post(fd, '/api/fd/patients/search', { q: '', page: 0 });
    expect(r.status).toBe(200);
    expect(r.body.patients.length).toBeLessThanOrEqual(25);
    expect((await post(fd, '/api/fd/patients/search', { q: '', page: -1 })).status).toBe(400);
    expect((await post(fd, '/api/fd/patients/search', { q: 'x', extra: 1 })).status).toBe(400);
  });
});

describe('patients: update, consent, delete', () => {
  it('updates fields, audits field NAMES only, and refuses unknown fields', async () => {
    const fd = await fdLogin();
    const p = (await post(fd, '/api/fd/patients', valid())).body.patient;
    const r = await patch(fd, `/api/fd/patients/${p.id}`, { city: 'Edina', phone: '612-555-0999' });
    expect(r.status).toBe(200);
    expect(r.body.patient.city).toBe('Edina');
    expect((await prisma.patient.findUniqueOrThrow({ where: { id: p.id } })).phoneDigits).toBe('6125550999');

    const rows = await auditRows({ resourceType: 'patient', resourceId: p.id, action: 'UPDATE' });
    expect(blob(rows)).toContain('city');
    expect(blob(rows)).not.toContain('Edina');
    expect((await patch(fd, `/api/fd/patients/${p.id}`, {})).status).toBe(400);
    expect((await patch(fd, `/api/fd/patients/${p.id}`, { smsOptIn: true })).status).toBe(400); // consent has its own endpoint
  });

  it('records SMS consent deliberately, with its source kept in the audit trail', async () => {
    const fd = await fdLogin();
    const p = (await post(fd, '/api/fd/patients', valid())).body.patient;
    expect((await post(fd, `/api/fd/patients/${p.id}/sms-consent`, { optIn: true })).status).toBe(400); // source required
    const on = await post(fd, `/api/fd/patients/${p.id}/sms-consent`, { optIn: true, source: 'verbal' });
    expect(on.status).toBe(200);
    expect(on.body.patient.smsOptIn).toBe(true);
    const stored = await prisma.patient.findUniqueOrThrow({ where: { id: p.id } });
    expect(stored.smsOptInAt).not.toBeNull();
    expect(stored.smsConsentRecordedById).not.toBeNull();

    const off = await post(fd, `/api/fd/patients/${p.id}/sms-consent`, { optIn: false, source: 'verbal' });
    expect(off.body.patient.smsOptIn).toBe(false);
    const rows = await auditRows({ resourceType: 'patient', resourceId: p.id, action: 'UPDATE' }, 2);
    expect(blob(rows)).toContain('verbal');
  });

  it('soft-deletes (admin only), keeps the record, and refuses while appointments are upcoming', async () => {
    const fd = await fdLogin();
    const admin = await signInFully((await makeAccount({ roles: ['ADMIN'] })).email);
    const p = (await post(fd, '/api/fd/patients', valid())).body.patient;

    expect((await del(fd, `/api/fd/patients/${p.id}`)).status).toBe(403);

    const clinic = await makeClinic();
    const user = await prisma.user.create({ data: { name: 'x', email: '', phone: '6125550000' } });
    const future = new Date(Date.now() + 5 * 86_400_000);
    await prisma.booking.create({
      data: { userId: user.id, serviceId: clinic.service.id, resourceId: clinic.rooms[0]!.id, staffId: clinic.staff[0]!.id, startTime: future, endTime: new Date(future.getTime() + 1800_000), status: 'CONFIRMED', patientId: p.id },
    });
    const blocked = await del(admin, `/api/fd/patients/${p.id}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('has_upcoming');

    await prisma.booking.updateMany({ where: { patientId: p.id }, data: { status: 'CANCELLED' } });
    expect((await del(admin, `/api/fd/patients/${p.id}`)).status).toBe(200);
    expect((await prisma.patient.findUniqueOrThrow({ where: { id: p.id } })).deletedAt).not.toBeNull();
    expect((await fd.agent.get(`/api/fd/patients/${p.id}`)).status).toBe(404);
    expect((await post(fd, '/api/fd/patients/search', { q: p.lastName })).body.patients).toEqual([]);
  });
});

describe('patients: visits and linking an online booking', () => {
  it('lists a patient\'s visits (audited) and links an online booking by suggestion, never automatically', async () => {
    const fd = await fdLogin();
    const clinic = await makeClinic();
    const phone = '6125550123';
    const p = await makePatient({ phone, email: 'link.me@example.test' });
    const user = await prisma.user.create({ data: { name: 'Online Person', email: 'link.me@example.test', phone } });
    const start = new Date(Date.now() + 6 * 86_400_000);
    const b = await prisma.booking.create({
      data: { userId: user.id, serviceId: clinic.service.id, resourceId: clinic.rooms[0]!.id, staffId: clinic.staff[0]!.id, startTime: start, endTime: new Date(start.getTime() + 1800_000), status: 'CONFIRMED' },
    });

    const matches = await fd.agent.get(`/api/fd/bookings/${b.id}/patient-matches`);
    expect(matches.status).toBe(200);
    expect(matches.body.matches.map((m: any) => m.id)).toContain(p.id);
    expect(matches.body.linkedPatientId).toBeNull(); // suggested, not linked

    expect((await post(fd, `/api/fd/bookings/${b.id}/link-patient`, { patientId: 'nope' })).status).toBe(404);
    expect((await post(fd, `/api/fd/bookings/${b.id}/link-patient`, { patientId: p.id })).status).toBe(200);
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: b.id } })).patientId).toBe(p.id);

    const visits = await fd.agent.get(`/api/fd/patients/${p.id}/visits`);
    expect(visits.status).toBe(200);
    expect(visits.body.visits.map((v: any) => v.id)).toContain(b.id);
    expect(await auditRows({ resourceType: 'patient', resourceId: p.id, action: 'READ' })).toHaveLength(1);
    expect(await auditRows({ resourceType: 'appointment', resourceId: b.id, action: 'UPDATE' })).toHaveLength(1);
  });
});
