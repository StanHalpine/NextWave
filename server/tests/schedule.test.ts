import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '../src/lib/prisma.js';
import { setClockForTests } from '../src/lib/clock.js';
import { app, auditRows, blob, chiroStaff, makeAccount, signInFully } from './helpers.js';
import { TUESDAY_1007, TUESDAY_DATE, futureTuesday, makeClinic, makePatient, post, slotAt } from './phase2.js';

const fdLogin = async () => signInFully((await makeAccount({ roles: ['FRONT_DESK'] })).email);

beforeAll(() => setClockForTests(TUESDAY_1007));
afterAll(() => setClockForTests(null));

const create = (s: any, clinic: Awaited<ReturnType<typeof makeClinic>>, patientId: string, hhmm: string, extra: object = {}) =>
  post(s, '/api/schedule/appointments', { serviceId: clinic.service.id, start: slotAt(hhmm).toISOString(), patientId, ...extra });

describe('schedule: access', () => {
  it('is closed to anonymous callers and providers, open to front desk and admin', async () => {
    const urls = ['/api/schedule/calendar?from=2026-10-13&to=2026-10-13', '/api/schedule/appointments/x'];
    for (const u of urls) expect((await request(app).get(u)).status, u).toBe(401);
    expect((await request(app).post('/api/schedule/appointments').send({})).status).toBe(401);

    const staff = await chiroStaff();
    const prov = await signInFully((await makeAccount({ roles: ['PROVIDER_CHIRO'], staffId: staff.id })).email);
    for (const u of urls) expect((await prov.agent.get(u)).status, u).toBe(403);

    const fd = await fdLogin();
    expect((await fd.agent.get(urls[0]!)).status).toBe(200);
    const admin = await signInFully((await makeAccount({ roles: ['ADMIN'] })).email);
    expect((await admin.agent.get(urls[0]!)).status).toBe(200);
  });

  it('requires the CSRF token on every write', async () => {
    const fd = await fdLogin();
    for (const [m, u] of [['post', '/api/schedule/appointments'], ['post', '/api/schedule/appointments/x/move'], ['post', '/api/schedule/appointments/x/cancel']] as const) {
      expect((await (fd.agent as any)[m](u).send({})).status, u).toBe(403);
    }
  });
});

describe('schedule: calendar', () => {
  it('returns days, providers with shifts, rooms and appointments, and audits the read', async () => {
    const fd = await fdLogin();
    const clinic = await makeClinic();
    const patient = await makePatient();
    const made = await create(fd, clinic, patient.id, '11:00');
    expect(made.status).toBe(201);

    const res = await fd.agent.get(`/api/schedule/calendar?from=${TUESDAY_DATE}&to=2026-10-18`);
    expect(res.status).toBe(200);
    expect(res.body.timezone).toBe('America/Chicago');
    expect(res.body.today).toBe(TUESDAY_DATE);
    expect(res.body.days).toHaveLength(6);
    const sunday = res.body.days.find((d: any) => d.date === '2026-10-18');
    expect(sunday).toMatchObject({ closed: true, open: null });
    expect(res.body.days[0]).toMatchObject({ date: TUESDAY_DATE, open: '07:00', close: '19:00', closed: false });

    const prov = res.body.staff.find((s: any) => s.id === clinic.staff[0]!.id);
    expect(prov.shifts[TUESDAY_DATE]).toEqual([{ start: '07:00', end: '19:00' }]);
    expect(prov.shifts['2026-10-18']).toEqual([]);
    expect(res.body.rooms.map((r: any) => r.id)).toContain(clinic.rooms[0]!.id);

    const appt = res.body.appointments.find((a: any) => a.id === made.body.appointment.id);
    expect(appt).toMatchObject({ localStart: '11:00', localEnd: '11:30', status: 'CONFIRMED', source: 'PHONE' });
    expect(appt.service.name).toBe(clinic.service.name);
    expect(appt.patient).toMatchObject({ id: patient.id, linked: true });

    expect((await auditRows({ resourceType: 'appointment', action: 'READ' })).some((r) => JSON.stringify(r.meta).includes('calendar'))).toBe(true);
  });

  it('validates the range, hides cancelled and expired holds by default', async () => {
    const fd = await fdLogin();
    expect((await fd.agent.get('/api/schedule/calendar?from=2026-10-13')).status).toBe(400);
    expect((await fd.agent.get('/api/schedule/calendar?from=nope&to=2026-10-13')).status).toBe(400);
    expect((await fd.agent.get('/api/schedule/calendar?from=2026-10-13&to=2026-12-31')).status).toBe(400);
    expect((await fd.agent.get('/api/schedule/calendar?from=2026-10-14&to=2026-10-13')).status).toBe(400);

    const clinic = await makeClinic();
    const patient = await makePatient();
    const a = await create(fd, clinic, patient.id, '13:00');
    const b = await create(fd, clinic, patient.id, '14:00');
    await post(fd, `/api/schedule/appointments/${b.body.appointment.id}/cancel`, { reason: 'patient_request' });
    const user = await prisma.user.create({ data: { name: 'x', email: '', phone: '6125550000' } });
    const expired = await prisma.booking.create({
      data: { userId: user.id, serviceId: clinic.service.id, resourceId: clinic.rooms[0]!.id, staffId: clinic.staff[0]!.id, startTime: slotAt('15:00'), endTime: slotAt('15:30'), status: 'HOLD', holdExpiresAt: new Date(TUESDAY_1007.getTime() - 60_000) },
    });

    const day = (q = '') => fd.agent.get(`/api/schedule/calendar?from=${TUESDAY_DATE}&to=${TUESDAY_DATE}${q}`).then((r) => r.body.appointments.map((x: any) => x.id));
    const ids = await day();
    expect(ids).toContain(a.body.appointment.id);
    expect(ids).not.toContain(b.body.appointment.id);
    expect(ids).not.toContain(expired.id);
    expect(await day('&includeCancelled=true')).toContain(b.body.appointment.id);
  });
});

describe('schedule: create', () => {
  it('creates a confirmed appointment through the engine and audits it atomically', async () => {
    const fd = await fdLogin();
    const clinic = await makeClinic();
    const patient = await makePatient();
    const res = await create(fd, clinic, patient.id, '11:00', { source: 'FRONT_DESK' });
    expect(res.status).toBe(201);
    const id = res.body.appointment.id;

    const row = await prisma.booking.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: 'CONFIRMED', source: 'FRONT_DESK', patientId: patient.id, resourceId: clinic.rooms[0]!.id, staffId: clinic.staff[0]!.id });
    expect(row.createdByAccountId).toBe(fd.state.account.id);
    expect(row.startTime.toISOString()).toBe(slotAt('11:00').toISOString());
    expect(row.endTime.getTime() - row.startTime.getTime()).toBe(30 * 60_000);

    const rows = await auditRows({ resourceType: 'appointment', resourceId: id, action: 'CREATE' });
    expect(rows).toHaveLength(1);
    expect(blob(rows)).not.toContain(patient.lastName);
  });

  it('refuses a taken slot with a 409 and writes nothing — not even an audit row for a change that did not happen', async () => {
    const fd = await fdLogin();
    const clinic = await makeClinic();
    const p1 = await makePatient();
    const p2 = await makePatient();
    expect((await create(fd, clinic, p1.id, '11:00')).status).toBe(201);

    const before = await prisma.booking.count({ where: { serviceId: clinic.service.id } });
    const auditBefore = await prisma.auditLog.count({ where: { resourceType: 'appointment', action: 'CREATE' } });
    const second = await create(fd, clinic, p2.id, '11:00');
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('slot_unavailable');
    expect(await prisma.booking.count({ where: { serviceId: clinic.service.id } })).toBe(before);
    expect(await prisma.auditLog.count({ where: { resourceType: 'appointment', action: 'CREATE' } })).toBe(auditBefore);
    // An orphaned contact snapshot would be the other half-written thing.
    expect(await prisma.user.count({ where: { name: `${p2.firstName} ${p2.lastName}` } })).toBe(0);
  });

  it('refuses the past, a closed day, an unknown patient/service/option, and unknown fields', async () => {
    const fd = await fdLogin();
    const clinic = await makeClinic();
    const patient = await makePatient();
    const past = await post(fd, '/api/schedule/appointments', { serviceId: clinic.service.id, start: slotAt('09:00').toISOString(), patientId: patient.id });
    expect(past.status).toBe(400);
    expect(past.body.code).toBe('in_the_past');

    const sunday = await post(fd, '/api/schedule/appointments', { serviceId: clinic.service.id, start: slotAt('11:00', '2026-10-18').toISOString(), patientId: patient.id });
    expect(sunday.status).toBe(409);

    expect((await create(fd, clinic, 'no-such-patient', '11:00')).status).toBe(404);
    expect((await post(fd, '/api/schedule/appointments', { serviceId: 'nope', start: slotAt('11:00').toISOString(), patientId: patient.id })).status).toBe(404);
    expect((await create(fd, clinic, patient.id, '11:00', { subOption: 'Not a real option' })).status).toBe(400);
    expect((await create(fd, clinic, patient.id, '11:00', { status: 'CANCELLED' })).status).toBe(400);
    expect((await create(fd, clinic, patient.id, '11:00', { source: 'ONLINE' })).status).toBe(400); // staff cannot claim an online source
    expect((await post(fd, '/api/schedule/appointments', { serviceId: clinic.service.id, start: 'tomorrow', patientId: patient.id })).status).toBe(400);
  });

  it('honours a requested provider and refuses one who is busy', async () => {
    const fd = await fdLogin();
    const clinic = await makeClinic({ rooms: 2, staff: 2 });
    const p = await makePatient();
    const [a, b] = clinic.staff;
    const first = await create(fd, clinic, p.id, '11:00', { staffId: b!.id });
    expect(first.body.appointment.staff.id).toBe(b!.id);
    const busy = await create(fd, clinic, (await makePatient()).id, '11:00', { staffId: b!.id });
    expect(busy.status).toBe(409);
    expect(busy.body.code).toBe('provider_unavailable');
    const other = await create(fd, clinic, (await makePatient()).id, '11:00', { staffId: a!.id });
    expect(other.status).toBe(201);
  });

  it('shares the booking engine\'s view of the world: a live online hold blocks a staff booking', async () => {
    // Real clock for this one: the public hold route uses it, so the hold's expiry only
    // means something against the real now.
    setClockForTests(null);
    try {
      const fd = await fdLogin();
      const clinic = await makeClinic();
      const date = futureTuesday();
      const start = slotAt('11:00', date);
      const hold = await request(app).post('/api/holds').send({ serviceId: clinic.service.id, start: start.toISOString() });
      expect(hold.status).toBe(201);

      const blocked = await post(fd, '/api/schedule/appointments', { serviceId: clinic.service.id, start: start.toISOString(), patientId: (await makePatient()).id });
      expect(blocked.status).toBe(409);

      // And the reverse: the engine refuses a hold on a slot staff booked.
      const other = slotAt('13:00', date);
      expect((await post(fd, '/api/schedule/appointments', { serviceId: clinic.service.id, start: other.toISOString(), patientId: (await makePatient()).id })).status).toBe(201);
      const refused = await request(app).post('/api/holds').send({ serviceId: clinic.service.id, start: other.toISOString() });
      expect(refused.status).toBe(409);
    } finally {
      setClockForTests(TUESDAY_1007);
    }
  });
});

describe('schedule: move', () => {
  it('moves in place, keeps id/patient/provider, and may overlap its own old time', async () => {
    const fd = await fdLogin();
    const clinic = await makeClinic();
    const p = await makePatient();
    const made = await create(fd, clinic, p.id, '11:00');
    const id = made.body.appointment.id;

    const res = await post(fd, `/api/schedule/appointments/${id}/move`, { start: slotAt('11:15').toISOString() }); // overlaps 11:00–11:30
    expect(res.status).toBe(200);
    expect(res.body.appointment).toMatchObject({ id, localStart: '11:15', localEnd: '11:45', status: 'CONFIRMED' });
    const row = await prisma.booking.findUniqueOrThrow({ where: { id } });
    expect(row.patientId).toBe(p.id);
    expect(row.staffId).toBe(clinic.staff[0]!.id);
    expect(await prisma.booking.count({ where: { serviceId: clinic.service.id } })).toBe(1);
    expect((await auditRows({ resourceType: 'appointment', resourceId: id, action: 'UPDATE' })).length).toBe(1);
  });

  it('is all-or-nothing: moving onto a taken slot leaves the original untouched and unaudited', async () => {
    const fd = await fdLogin();
    const clinic = await makeClinic();
    const a = await create(fd, clinic, (await makePatient()).id, '11:00');
    const b = await create(fd, clinic, (await makePatient()).id, '12:00');
    const auditBefore = await prisma.auditLog.count({ where: { resourceId: b.body.appointment.id, action: 'UPDATE' } });

    const res = await post(fd, `/api/schedule/appointments/${b.body.appointment.id}/move`, { start: slotAt('11:15').toISOString() });
    expect(res.status).toBe(409);
    const row = await prisma.booking.findUniqueOrThrow({ where: { id: b.body.appointment.id } });
    expect(row.status).toBe('CONFIRMED'); // the temporary self-cancel rolled back
    expect(row.startTime.toISOString()).toBe(slotAt('12:00').toISOString());
    expect(await prisma.auditLog.count({ where: { resourceId: b.body.appointment.id, action: 'UPDATE' } })).toBe(auditBefore);
    // …and the slot b tried to take is still a's.
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: a.body.appointment.id } })).startTime.toISOString()).toBe(slotAt('11:00').toISOString());
  });

  it('refuses the past, an unknown appointment, a cancelled one, and one already checked in', async () => {
    const fd = await fdLogin();
    const clinic = await makeClinic();
    const made = await create(fd, clinic, (await makePatient()).id, '11:00');
    const id = made.body.appointment.id;
    expect((await post(fd, `/api/schedule/appointments/${id}/move`, { start: slotAt('09:00').toISOString() })).status).toBe(400);
    expect((await post(fd, '/api/schedule/appointments/nope/move', { start: slotAt('12:00').toISOString() })).status).toBe(404);
    expect((await post(fd, `/api/schedule/appointments/${id}/move`, { start: slotAt('12:00').toISOString(), extra: 1 })).status).toBe(400);

    expect((await post(fd, `/api/fd/appointments/${id}/check-in`)).status).toBe(200);
    const moved = await post(fd, `/api/schedule/appointments/${id}/move`, { start: slotAt('12:00').toISOString() });
    expect(moved.status).toBe(409);
    expect(moved.body.code).toBe('already_started');

    const other = await create(fd, clinic, (await makePatient()).id, '15:00');
    await post(fd, `/api/schedule/appointments/${other.body.appointment.id}/cancel`, { reason: 'other' });
    expect((await post(fd, `/api/schedule/appointments/${other.body.appointment.id}/move`, { start: slotAt('16:00').toISOString() })).body.code).toBe('not_movable');
  });
});

describe('schedule: cancel', () => {
  it('cancels with a reason CODE, frees the slot, and is idempotent', async () => {
    const fd = await fdLogin();
    const clinic = await makeClinic();
    const made = await create(fd, clinic, (await makePatient()).id, '11:00');
    const id = made.body.appointment.id;

    expect((await post(fd, `/api/schedule/appointments/${id}/cancel`, {})).status).toBe(400);
    expect((await post(fd, `/api/schedule/appointments/${id}/cancel`, { reason: 'chemo schedule changed' })).status).toBe(400); // free text refused
    const res = await post(fd, `/api/schedule/appointments/${id}/cancel`, { reason: 'patient_request' });
    expect(res.status).toBe(200);
    expect(res.body.appointment.status).toBe('CANCELLED');
    expect((await post(fd, `/api/schedule/appointments/${id}/cancel`, { reason: 'patient_request' })).status).toBe(200); // again: no-op

    const rows = await auditRows({ resourceType: 'appointment', resourceId: id, action: 'UPDATE' });
    expect(rows).toHaveLength(1);
    expect(blob(rows)).toContain('patient_request');

    expect((await create(fd, clinic, (await makePatient()).id, '11:00')).status).toBe(201); // the slot is free again
    expect((await post(fd, '/api/schedule/appointments/nope/cancel', { reason: 'other' })).status).toBe(404);
  });

  it('will not cancel a patient who is checked in', async () => {
    const fd = await fdLogin();
    const clinic = await makeClinic();
    const made = await create(fd, clinic, (await makePatient()).id, '11:00');
    const id = made.body.appointment.id;
    await post(fd, `/api/fd/appointments/${id}/check-in`);
    const res = await post(fd, `/api/schedule/appointments/${id}/cancel`, { reason: 'other' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('already_started');
  });
});

describe('schedule: appointment detail', () => {
  it('returns contact and text DELIVERY status — never a phone number or message body — and audits the read', async () => {
    const fd = await fdLogin();
    const clinic = await makeClinic();
    const p = await makePatient({ smsOptIn: true });
    const made = await create(fd, clinic, p.id, '11:00');
    const id = made.body.appointment.id;
    await prisma.messageLog.create({
      data: { bookingId: id, patientId: p.id, kind: 'CONFIRMATION', forStart: slotAt('11:00'), templateId: 'appt_confirmation_v1', status: 'SENT', sentAt: new Date() },
    });

    const res = await fd.agent.get(`/api/schedule/appointments/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([expect.objectContaining({ kind: 'CONFIRMATION', status: 'SENT' })]);
    expect(blob(res.body.messages)).not.toMatch(/\d{7}/);
    expect(await auditRows({ resourceType: 'appointment', resourceId: id, action: 'READ' })).toHaveLength(1);
    expect((await fd.agent.get('/api/schedule/appointments/nope')).status).toBe(404);
  });
});

describe('schedule: open slots (the picker)', () => {
  it('lists bookable starts with the providers who could take each, and hides what has begun', async () => {
    const fd = await fdLogin();
    const clinic = await makeClinic({ rooms: 2, staff: 2 });
    const res = await fd.agent.get(`/api/schedule/slots?serviceId=${clinic.service.id}&date=${TUESDAY_DATE}`);
    expect(res.status).toBe(200);
    expect(res.body.durationMin).toBe(30);
    const starts: string[] = res.body.slots.map((s: any) => s.start);
    expect(starts).not.toContain(slotAt('10:00').toISOString());   // already begun at 10:07
    expect(starts).toContain(slotAt('10:15').toISOString());
    expect(starts).toContain(slotAt('18:30').toISOString());       // last 30-min start before 19:00 close
    expect(starts).not.toContain(slotAt('18:45').toISOString());
    const first = res.body.slots[0];
    expect(first.staffIds.sort()).toEqual(clinic.staff.map((s) => s.id).sort());
    expect(res.body.staff.map((s: any) => s.id).sort()).toEqual(clinic.staff.map((s) => s.id).sort());
    expect(res.body.staff[0]).toEqual({ id: expect.any(String), name: expect.stringContaining('Test Provider') });
    expect(blob(res.body)).not.toMatch(/Patient/);

    const sunday = await fd.agent.get(`/api/schedule/slots?serviceId=${clinic.service.id}&date=2026-10-18`);
    expect(sunday.body.slots).toEqual([]);
    expect(sunday.body.closedReason).toMatch(/closed/i);
    expect((await fd.agent.get(`/api/schedule/slots?serviceId=nope&date=${TUESDAY_DATE}`)).status).toBe(404);
    expect((await fd.agent.get('/api/schedule/slots?date=2026-10-13')).status).toBe(400);
    expect((await request(app).get(`/api/schedule/slots?serviceId=${clinic.service.id}&date=${TUESDAY_DATE}`)).status).toBe(401);
  });

  it('for a move, offers the times that overlap the appointment\'s own — and leaves it untouched', async () => {
    const fd = await fdLogin();
    const clinic = await makeClinic();
    const made = await create(fd, clinic, (await makePatient()).id, '11:00');
    const id = made.body.appointment.id;

    const plain = await fd.agent.get(`/api/schedule/slots?serviceId=${clinic.service.id}&date=${TUESDAY_DATE}`);
    const plainStarts: string[] = plain.body.slots.map((s: any) => s.start);
    expect(plainStarts).not.toContain(slotAt('11:15').toISOString());   // overlaps the booking, one room, one provider

    const asIf = await fd.agent.get(`/api/schedule/slots?serviceId=${clinic.service.id}&date=${TUESDAY_DATE}&forAppointmentId=${id}`);
    const asIfStarts: string[] = asIf.body.slots.map((s: any) => s.start);
    expect(asIfStarts).toContain(slotAt('11:15').toISOString());
    expect(asIfStarts).toContain(slotAt('11:00').toISOString());

    const row = await prisma.booking.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('CONFIRMED');                                // the as-if cancellation rolled back
    expect((await fd.agent.get(`/api/schedule/slots?serviceId=${clinic.service.id}&date=${TUESDAY_DATE}`)).body.slots.map((s: any) => s.start)).not.toContain(slotAt('11:15').toISOString());

    const other = await makeClinic();
    expect((await fd.agent.get(`/api/schedule/slots?serviceId=${other.service.id}&date=${TUESDAY_DATE}&forAppointmentId=${id}`)).status).toBe(404); // not that service's appointment
    // And what it offered is genuinely movable.
    expect((await post(fd, `/api/schedule/appointments/${id}/move`, { start: slotAt('11:15').toISOString() })).status).toBe(200);
  });
});
