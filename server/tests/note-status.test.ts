import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { DateTime } from 'luxon';
import { basePrisma } from '../src/lib/prismaBase.js';
import { setClockForTests } from '../src/lib/clock.js';
import { config } from '../src/config.js';
import { app, auditRows, blob, makeAccount, signIn, signInFully, type Signed } from './helpers.js';
import { makeClinic, makePatient, patch, post, slotAt, TUESDAY_1007 } from './phase2.js';
import { adminLogin, frontDeskLogin, providerLogin, saveSoap, URL, visit, type Provider } from './phase4.js';

/**
 * Rev 2.0: billing and documentation are decoupled. Check-out never waits for a signed note; the note's status is tracked apart from
 * the visit's (NOT_REQUIRED | PENDING | SIGNED, lib/noteStatus.ts); only services that need a note (Service.requiresNote, fixed per
 * visit at check-in) can be pending; and every pending note is on its provider's Unsigned notes worklist (lib/unsignedNotes.ts),
 * checked out or not, until it is signed — late, if need be, and recorded as late.
 *
 * The clock is pinned to Tuesday 2026-10-13, 10:07 in the clinic (America/Chicago, CDT = UTC−5).
 */

beforeAll(() => setClockForTests(TUESDAY_1007));
afterAll(() => setClockForTests(null));

const ZONE = 'America/Chicago';
const local = (iso: string) => DateTime.fromISO(iso, { zone: ZONE }).toJSDate();
const HOUR = 3_600_000;
const ago = (ms: number, from = TUESDAY_1007) => new Date(from.getTime() - ms);

const WORKLIST = (staffId?: string) => `/api/provider/unsigned-notes${staffId ? `?staffId=${staffId}` : ''}`;
const CHECKOUT = (id: string) => `/api/fd/appointments/${id}/check-out`;
const encounterOf = (bookingId: string) => basePrisma.encounter.findUniqueOrThrow({ where: { bookingId } });
const ledgerOf = async (s: Signed, patientId: string) => (await s.agent.get(`/api/fd/patients/${patientId}/ledger`)).body;
const ledgerVisit = (body: any, bookingId: string) => [...body.todayVisits, ...body.priorVisits].find((v: any) => v.id === bookingId);
const worklist = async (s: Signed, staffId?: string) => {
  const r = await s.agent.get(WORKLIST(staffId));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
};
const ids = (rows: Array<{ bookingId: string }>) => rows.map((r) => r.bookingId);
/** The appointment card for a booking, wherever it is on that day's Front Desk dashboard. */
async function card(fd: Signed, bookingId: string, date = '2026-10-13') {
  const d = (await fd.agent.get(`/api/fd/dashboard?date=${date}`)).body;
  return [...d.scheduled, ...d.checkedIn, ...d.done, ...d.noShows].find((a: any) => a.id === bookingId);
}
async function sign(p: Provider, bookingId: string) {
  const version = await saveSoap(p, bookingId);
  const r = await post(p, URL.sign(bookingId), { version });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.signed as { afterCheckout: boolean };
}
const checkOut = async (fd: Signed, bookingId: string) => {
  const r = await post(fd, CHECKOUT(bookingId), { payment: 'CASH', priceCents: 5500 });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
};

describe('check-out does not wait for the note', () => {
  it('checks out a visit whose note is pending — checked in, with the provider (a draft open), or seen — and the note stays as it was', async () => {
    const prov = await providerLogin('PROVIDER_CHIRO');
    const fd = await frontDeskLogin();
    const patient = await makePatient();

    const untouched = await visit({ staffId: prov.staff.id, patientId: patient.id, start: slotAt('09:00') });
    const drafted = await visit({ staffId: prov.staff.id, patientId: patient.id, start: slotAt('09:15') });
    await saveSoap(prov, drafted.booking.id);                                                       // IN_PROGRESS, draft not signed
    const signedFirst = await visit({ staffId: prov.staff.id, patientId: patient.id, start: slotAt('09:30') });
    await sign(prov, signedFirst.booking.id);                                                        // SEEN
    expect((await encounterOf(drafted.booking.id)).status).toBe('IN_PROGRESS');
    expect((await encounterOf(signedFirst.booking.id)).status).toBe('SEEN');

    for (const [v, note] of [[untouched, 'PENDING'], [drafted, 'PENDING'], [signedFirst, 'SIGNED']] as const) {
      const out = await checkOut(fd, v.booking.id);
      expect(out.appointment.encounter.status).toBe('CHECKED_OUT');
      expect(out.appointment.note).toBe(note);
      expect(await basePrisma.revenueEvent.count({ where: { encounterId: v.encounter!.id } })).toBe(1);
    }
    // the draft is untouched by check-out: the provider finishes it later
    expect(await basePrisma.documentationDraft.count({ where: { bookingId: drafted.booking.id } })).toBe(1);
    expect((await card(fd, drafted.booking.id)).documentation.status).toBe('DRAFT');
    // both pending notes are now on the provider's worklist, as checked-out visits
    const list = await worklist(prov);
    expect(ids(list.rows)).toEqual([untouched.booking.id, drafted.booking.id]);
    expect(list.rows.map((r: any) => r.visit.status)).toEqual(['CHECKED_OUT', 'CHECKED_OUT']);
    expect(list.rows.map((r: any) => r.documentation.status)).toEqual(['NONE', 'DRAFT']);
  });

  it('the Front Desk card and the Ledger say where the note is at each step, and check-out is offered throughout', async () => {
    const prov = await providerLogin('PROVIDER_CHIRO');
    const fd = await frontDeskLogin();
    const p = await makePatient();
    const notYet = await visit({ staffId: prov.staff.id, patientId: p.id, encounter: null, start: slotAt('16:00') });
    const adjust = await visit({ staffId: prov.staff.id, patientId: p.id, start: slotAt('09:00') });
    const light = await visit({ staffRole: 'REGISTERED_NURSE', requiresNote: false, patientId: p.id, start: slotAt('09:30') });

    expect((await card(fd, notYet.booking.id)).note).toBeNull();                                     // nothing to document before check-in
    expect((await card(fd, adjust.booking.id)).note).toBe('PENDING');
    expect((await card(fd, light.booking.id)).note).toBe('NOT_REQUIRED');
    let l = await ledgerOf(fd, p.id);
    expect(ledgerVisit(l, adjust.booking.id)).toMatchObject({ state: 'ready_to_check_out', note: 'PENDING' });
    expect(ledgerVisit(l, light.booking.id)).toMatchObject({ state: 'ready_to_check_out', note: 'NOT_REQUIRED' });
    expect(ledgerVisit(l, notYet.booking.id)).toMatchObject({ state: 'not_arrived', note: null });
    expect(l.todayTotals.notesPending).toBe(1);

    await checkOut(fd, adjust.booking.id);
    l = await ledgerOf(fd, p.id);
    expect(ledgerVisit(l, adjust.booking.id)).toMatchObject({ state: 'checked_out', note: 'PENDING' });   // paid, note still to come
    expect(l.todayTotals.notesPending).toBe(1);

    await sign(prov, adjust.booking.id);
    expect((await card(fd, adjust.booking.id)).note).toBe('SIGNED');
    l = await ledgerOf(fd, p.id);
    expect(ledgerVisit(l, adjust.booking.id)).toMatchObject({ state: 'checked_out', note: 'SIGNED' });
    expect(l.todayTotals.notesPending).toBe(0);
  });
});

describe('a note signed after check-out — a late note', () => {
  it('can still be written and signed; the visit stays CHECKED_OUT; the signature and its audit row record that it was late', async () => {
    const prov = await providerLogin('PROVIDER_CHIRO');
    const fd = await frontDeskLogin();
    const v = await visit({ staffId: prov.staff.id, patientId: (await makePatient()).id });
    await checkOut(fd, v.booking.id);

    const signed = await sign(prov, v.booking.id);
    expect(signed.afterCheckout).toBe(true);
    const enc = await encounterOf(v.booking.id);
    expect(enc.status).toBe('CHECKED_OUT');                                                          // never pulled back to SEEN
    expect(enc.seenAt).not.toBeNull();
    const sig = await basePrisma.noteSignature.findUniqueOrThrow({ where: { bookingId: v.booking.id } });
    expect(sig.afterCheckout).toBe(true);
    const [row] = await auditRows({ resourceType: 'note_signature', resourceId: sig.id, action: 'CREATE' });
    expect(row!.meta).toMatchObject({ afterCheckout: true, overdue: false });
    expect(await basePrisma.revenueEvent.count({ where: { encounterId: enc.id } })).toBe(1);          // signing charged nothing again
    expect(ids((await worklist(prov)).rows)).not.toContain(v.booking.id);
    expect((await (await prov.agent.get(URL.ws(v.booking.id))).body).signature).toMatchObject({ afterCheckout: true });
  });

  it('one signed while the patient is still here is not late, and the visit becomes SEEN', async () => {
    const prov = await providerLogin('PROVIDER_CHIRO');
    const v = await visit({ staffId: prov.staff.id });
    expect((await sign(prov, v.booking.id)).afterCheckout).toBe(false);
    expect((await encounterOf(v.booking.id)).status).toBe('SEEN');
    const sig = await basePrisma.noteSignature.findUniqueOrThrow({ where: { bookingId: v.booking.id } });
    expect(sig.afterCheckout).toBe(false);
    expect((await auditRows({ resourceType: 'note_signature', resourceId: sig.id, action: 'CREATE' }))[0]!.meta).toMatchObject({ afterCheckout: false });
  });

  it('is recorded as overdue when it comes more than the threshold after check-in', async () => {
    const prov = await providerLogin('PROVIDER_CHIRO');
    const fd = await frontDeskLogin();
    const v = await visit({ staffId: prov.staff.id, start: slotAt('09:00', '2026-10-12'), checkedInAt: ago(25 * HOUR) });
    await checkOut(fd, v.booking.id);
    await sign(prov, v.booking.id);
    const sig = await basePrisma.noteSignature.findUniqueOrThrow({ where: { bookingId: v.booking.id } });
    expect((await auditRows({ resourceType: 'note_signature', resourceId: sig.id, action: 'CREATE' }))[0]!.meta).toMatchObject({ afterCheckout: true, overdue: true });
  });
});

describe('a service that needs no note', () => {
  it('never appears on the worklist — today, checked out, or weeks ago — nor in the provider queue\'s "still to sign"', async () => {
    const prov = await providerLogin('PROVIDER_NURSE');
    const fd = await frontDeskLogin();
    const today = await visit({ staffId: prov.staff.id, requiresNote: false });
    const out = await visit({ staffId: prov.staff.id, requiresNote: false, start: slotAt('11:00') });
    await checkOut(fd, out.booking.id);
    const old = await visit({ staffId: prov.staff.id, requiresNote: false, encounter: 'CHECKED_OUT', start: slotAt('10:00', '2026-10-09') });
    const needsOne = await visit({ staffId: prov.staff.id, encounter: 'CHECKED_OUT', start: slotAt('10:30', '2026-10-09') });

    expect(ids((await worklist(prov)).rows)).toEqual([needsOne.booking.id]);
    // The role queue is shared with every other nurse visit in the schema, so look only at these four.
    const q = (await prov.agent.get(URL.queue())).body;
    const backlog = q.backlog.map((r: any) => r.bookingId);
    expect(backlog).toContain(needsOne.booking.id);
    expect(backlog).not.toContain(old.booking.id);
    expect(q.backlog.every((r: any) => r.note === 'PENDING')).toBe(true);
    const todays = q.rows.filter((r: any) => [today.booking.id, out.booking.id].includes(r.bookingId));
    expect(todays.map((r: any) => r.note)).toEqual(['NOT_REQUIRED', 'NOT_REQUIRED']);
    // "notes still to sign" counts only what needs a note
    expect(q.pending).toBe(q.rows.filter((r: any) => r.note === 'PENDING').length + q.backlog.length);
    expect((await card(fd, old.booking.id, '2026-10-09')).note).toBe('NOT_REQUIRED');
  });

  it('can still be documented if the provider chooses to, and then reads as signed', async () => {
    const prov = await providerLogin('PROVIDER_CHIRO');
    const fd = await frontDeskLogin();
    const v = await visit({ staffId: prov.staff.id, requiresNote: false });
    await sign(prov, v.booking.id);
    expect((await card(fd, v.booking.id)).note).toBe('SIGNED');
    expect(ids((await worklist(prov)).rows)).not.toContain(v.booking.id);
  });

  it('in the seeded catalogue: red light, both hyperbaric sessions, body composition and biomarker testing (rev 2.2) need none; every other service needs one', async () => {
    const seeded = await basePrisma.service.findMany({ where: { id: { startsWith: '5e401ce0-' } }, select: { slug: true, durationMin: true, requiresNote: true } });
    expect(seeded).toHaveLength(15);
    const none = seeded.filter((s) => !s.requiresNote).map((s) => `${s.slug}${s.slug === 'hyperbaric-oxygen-therapy' ? `-${s.durationMin}` : ''}`).sort();
    expect(none).toEqual(['biomarker-testing', 'body-composition', 'hyperbaric-oxygen-therapy-60', 'hyperbaric-oxygen-therapy-90', 'red-light-therapy']);
  });
});

describe('whether a visit needs a note is fixed when the patient is checked in', () => {
  it('check-in copies the service\'s setting; changing the service later leaves that visit alone; undo and a fresh check-in take it again', async () => {
    const fd = await frontDeskLogin();
    const v = await visit({ encounter: null, patientId: (await makePatient()).id, start: slotAt('10:00') });
    expect((await post(fd, `/api/fd/appointments/${v.booking.id}/check-in`)).status).toBe(200);
    expect(await encounterOf(v.booking.id)).toMatchObject({ status: 'CHECKED_IN', noteRequired: true });

    await basePrisma.service.update({ where: { id: v.service.id }, data: { requiresNote: false } });
    expect((await encounterOf(v.booking.id)).noteRequired).toBe(true);                               // an admin's change is not retroactive
    expect((await card(fd, v.booking.id)).note).toBe('PENDING');

    expect((await post(fd, `/api/fd/appointments/${v.booking.id}/undo-check-in`)).status).toBe(200);
    expect(await encounterOf(v.booking.id)).toMatchObject({ status: 'SCHEDULED', noteRequired: false });
    expect((await card(fd, v.booking.id)).note).toBeNull();
    expect((await post(fd, `/api/fd/appointments/${v.booking.id}/check-in`)).status).toBe(200);
    expect(await encounterOf(v.booking.id)).toMatchObject({ status: 'CHECKED_IN', noteRequired: false });   // the service's value NOW
  });

  it('and keeps it as the visit moves on — with the provider, seen, checked out — after the service is changed', async () => {
    const prov = await providerLogin('PROVIDER_CHIRO');
    const fd = await frontDeskLogin();
    const needed = await visit({ staffId: prov.staff.id, patientId: (await makePatient()).id });            // checked in while the service needed a note
    const notNeeded = await visit({ staffId: prov.staff.id, requiresNote: false, start: slotAt('09:00') });
    await basePrisma.service.update({ where: { id: needed.service.id }, data: { requiresNote: false } });
    await basePrisma.service.update({ where: { id: notNeeded.service.id }, data: { requiresNote: true } });

    expect((await post(prov, URL.start(needed.booking.id))).status).toBe(200);                                // → IN_PROGRESS
    await checkOut(fd, needed.booking.id);                                                                     // → CHECKED_OUT
    expect((await post(prov, URL.start(notNeeded.booking.id))).status).toBe(200);
    await sign(prov, notNeeded.booking.id);                                                                    // → SEEN
    expect(await encounterOf(needed.booking.id)).toMatchObject({ status: 'CHECKED_OUT', noteRequired: true });
    expect(await encounterOf(notNeeded.booking.id)).toMatchObject({ status: 'SEEN', noteRequired: false });
    expect(ids((await worklist(prov)).rows)).toEqual([needed.booking.id]);
  });

  it('a walk-in gets it too — its encounter is created by the scheduling engine, which this phase does not change', async () => {
    const fd = await frontDeskLogin();
    const plain = await makeClinic();
    const noNote = await makeClinic();
    await basePrisma.service.update({ where: { id: noNote.service.id }, data: { requiresNote: false } });
    const a = await post(fd, '/api/fd/walk-ins', { patientId: (await makePatient()).id, serviceId: plain.service.id });
    const b = await post(fd, '/api/fd/walk-ins', { patientId: (await makePatient()).id, serviceId: noNote.service.id });
    expect([a.status, b.status]).toEqual([201, 201]);
    expect([a.body.appointment.note, b.body.appointment.note]).toEqual(['PENDING', 'NOT_REQUIRED']);
    expect((await encounterOf(a.body.appointment.id)).noteRequired).toBe(true);
  });

  it('a no-show needs no note, and is never on a worklist', async () => {
    const prov = await providerLogin('PROVIDER_CHIRO');
    const fd = await frontDeskLogin();
    const v = await visit({ staffId: prov.staff.id, encounter: null, start: slotAt('09:00') });
    expect((await post(fd, `/api/fd/appointments/${v.booking.id}/no-show`)).status).toBe(200);
    expect(await encounterOf(v.booking.id)).toMatchObject({ status: 'NO_SHOW', noteRequired: false });
    expect((await card(fd, v.booking.id)).note).toBeNull();
    expect(ids((await worklist(prov)).rows)).not.toContain(v.booking.id);
  });
});

describe('the Unsigned notes worklist', () => {
  it('lists the signed-in provider\'s pending notes, oldest first, checked out or not and from any day, with what it needs to open each one', async () => {
    const prov = await providerLogin('PROVIDER_CHIRO');
    const other = await providerLogin('PROVIDER_CHIRO');
    const patient = await makePatient({ firstName: 'Wanda', lastName: 'Worklist' });
    const mine = (o: Parameters<typeof visit>[0]) => visit({ staffId: prov.staff.id, patientId: patient.id, ...o });

    const sixWeeks = await mine({ encounter: 'CHECKED_OUT', start: slotAt('08:00', '2026-09-01') });     // older than the queue's 30-day backlog
    const yesterday = await mine({ encounter: 'CHECKED_OUT', start: slotAt('17:00', '2026-10-12') });
    const now = await mine({ start: slotAt('09:30') });
    const signedOne = await mine({ start: slotAt('09:00') });
    await sign(prov, signedOne.booking.id);
    const cancelled = await mine({ encounter: 'CHECKED_IN', bookingStatus: 'CANCELLED', start: slotAt('08:00') });
    const deleted = await mine({ start: slotAt('08:15') });
    await basePrisma.encounter.update({ where: { id: deleted.encounter!.id }, data: { deletedAt: new Date() } });
    const notArrived = await mine({ encounter: null, start: slotAt('15:00') });
    const theirs = await visit({ staffId: other.staff.id, start: slotAt('08:30') });

    const list = await worklist(prov);
    expect(ids(list.rows)).toEqual([sixWeeks.booking.id, yesterday.booking.id, now.booking.id]);
    for (const left of [signedOne, cancelled, deleted, notArrived, theirs]) expect(ids(list.rows)).not.toContain(left.booking.id);
    expect(list.provider).toMatchObject({ id: prov.staff.id, name: prov.staff.name, own: true });
    expect(list.providers).toBeNull();                                                                // a provider is not offered anyone else's
    expect(list.rows[0]).toMatchObject({
      localDate: '2026-09-01', localStart: '08:00',
      patient: { id: patient.id, name: 'Wanda Worklist' },
      service: { id: sixWeeks.service.id, name: sixWeeks.service.name, documentationType: 'SOAP' },
      visit: { status: 'CHECKED_OUT' }, documentation: { status: 'NONE' },
    });
    expect(list.rows[2].visit.status).toBe('CHECKED_IN');
    // one click opens the note: the row's booking id is the workspace's, and the provider can write there
    const ws = await prov.agent.get(URL.ws(list.rows[0].bookingId));
    expect(ws.status).toBe(200);
    expect(ws.body.access.canWrite).toBe(true);
    expect(ws.body.note).toBe('PENDING');
  });

  it('is scoped to the provider: each sees their own, and asking for someone else\'s is refused', async () => {
    const a = await providerLogin('PROVIDER_NP');
    const b = await providerLogin('PROVIDER_NP');
    const va = await visit({ staffId: a.staff.id, staffRole: 'NURSE_PRACTITIONER' });
    const vb = await visit({ staffId: b.staff.id, staffRole: 'NURSE_PRACTITIONER' });
    expect(ids((await worklist(a)).rows)).toEqual([va.booking.id]);
    expect(ids((await worklist(b)).rows)).toEqual([vb.booking.id]);
    expect(ids((await worklist(a, a.staff.id)).rows)).toEqual([va.booking.id]);                       // naming yourself is fine
    const r = await a.agent.get(WORKLIST(b.staff.id));
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('forbidden');
    expect(JSON.stringify(r.body)).not.toContain(vb.booking.id);
  });

  it('an administrator can read any provider\'s list (choosing from the providers), read only', async () => {
    const prov = await providerLogin('PROVIDER_CHIRO');
    const v = await visit({ staffId: prov.staff.id });
    const admin = await adminLogin();

    const first = await worklist(admin);                                                             // no provider record of their own
    expect(first).toMatchObject({ provider: null, rows: [], reason: 'Choose whose unsigned notes to see.' });
    expect(first.providers.map((p: any) => p.id)).toContain(prov.staff.id);
    expect(first.providers.every((p: any) => ['CHIROPRACTOR', 'NURSE_PRACTITIONER', 'REGISTERED_NURSE'].includes(p.role))).toBe(true);

    const theirs = await worklist(admin, prov.staff.id);
    expect(theirs.provider).toMatchObject({ id: prov.staff.id, own: false });
    expect(ids(theirs.rows)).toEqual([v.booking.id]);
    const ws = (await admin.agent.get(URL.ws(v.booking.id))).body;
    expect(ws.access.canWrite).toBe(false);                                                           // reading is all an admin may do

    expect((await admin.agent.get(WORKLIST('00000000-0000-4000-8000-000000000000'))).status).toBe(404);
    const desk = await basePrisma.staff.create({ data: { name: 'Desk person', role: 'FRONT_DESK' } });
    expect((await admin.agent.get(WORKLIST(desk.id))).status).toBe(404);                              // not a provider
  });

  it('a provider login with no provider record is told why its list is empty, and is not shown anyone else\'s', async () => {
    const acct = await makeAccount({ roles: ['PROVIDER_CHIRO'] });
    const s = await signInFully(acct.email);
    const list = await worklist(s);
    expect(list).toMatchObject({ provider: null, rows: [], providers: null });
    expect(list.reason).toMatch(/not linked to a provider record/);
    expect((await s.agent.get(URL.queue())).body.unsignedNotes).toBeNull();
  });

  it('refuses the front desk, anonymous callers, and a provider who has not set up the authenticator', async () => {
    expect((await request(app).get(WORKLIST())).status).toBe(401);
    expect((await (await frontDeskLogin()).agent.get(WORKLIST())).status).toBe(403);
    const acct = await makeAccount({ roles: ['PROVIDER_NP'], staffId: (await basePrisma.staff.create({ data: { name: 'No MFA', role: 'NURSE_PRACTITIONER' } })).id });
    const r = await (await signIn(acct.email)).agent.get(WORKLIST());
    expect(r.status).toBe(403);
    expect(r.body.needs).toEqual(['mfa_enroll']);
  });

  it('highlights a note pending MORE than 24 hours since check-in — and the threshold is one setting', async () => {
    const prov = await providerLogin('PROVIDER_CHIRO');
    const at = async (msAgo: number) => (await visit({ staffId: prov.staff.id, start: new Date(TUESDAY_1007.getTime() - msAgo + 5 * 60_000), checkedInAt: ago(msAgo) })).booking.id;
    const justUnder = await at(24 * HOUR - 60_000);
    const exactly = await at(24 * HOUR);
    const justOver = await at(24 * HOUR + 60_000);
    const days = await at(72 * HOUR);

    const list = await worklist(prov);
    expect(list.thresholdHours).toBe(24);
    const flag = (id: string) => list.rows.find((r: any) => r.bookingId === id);
    expect([flag(justUnder).overdue, flag(exactly).overdue, flag(justOver).overdue, flag(days).overdue]).toEqual([false, false, true, true]);
    expect([flag(justUnder).hoursPending, flag(justOver).hoursPending, flag(days).hoursPending]).toEqual([23, 24, 72]);
    expect(list.overdue).toBe(2);
    expect(flag(days).pendingSince).toBe(ago(72 * HOUR).toISOString());
    // the Provider page's link to the list carries the same counts, without the names
    expect((await prov.agent.get(URL.queue())).body.unsignedNotes).toEqual({ count: 4, overdue: 2, thresholdHours: 24 });

    const was = config.noteOverdueHours;
    try {
      (config as { noteOverdueHours: number }).noteOverdueHours = 48;
      const again = await worklist(prov);
      expect(again.thresholdHours).toBe(48);
      expect(again.rows.filter((r: any) => r.overdue).map((r: any) => r.bookingId)).toEqual([days]);
      expect((await prov.agent.get(URL.queue())).body.unsignedNotes).toEqual({ count: 4, overdue: 1, thresholdHours: 48 });
    } finally {
      (config as { noteOverdueHours: number }).noteOverdueHours = was;
    }
  });

  it('counts real elapsed hours across the night the clocks go back (2026-11-01): 23½ hours on the wall clock is 24½ real ones', async () => {
    const prov = await providerLogin('PROVIDER_CHIRO');
    const now = local('2026-11-01T09:30:00');                                                          // CST, UTC−6
    const late = await visit({ staffId: prov.staff.id, start: local('2026-10-31T10:00:00'), checkedInAt: local('2026-10-31T10:00:00') });     // CDT
    const fine = await visit({ staffId: prov.staff.id, start: local('2026-10-31T10:45:00'), checkedInAt: local('2026-10-31T10:45:00') });
    setClockForTests(now);
    try {
      const list = await worklist(prov);
      const row = (id: string) => list.rows.find((r: any) => r.bookingId === id);
      expect(row(late.booking.id)).toMatchObject({ localDate: '2026-10-31', localStart: '10:00', hoursPending: 24, overdue: true });
      expect(row(fine.booking.id)).toMatchObject({ localDate: '2026-10-31', localStart: '10:45', hoursPending: 23, overdue: false });
    } finally {
      setClockForTests(TUESDAY_1007);
    }
  });

  it('is audited as a read of that provider\'s list — ids and counts, no names — once per few minutes of viewing, not on every refresh', async () => {
    const prov = await providerLogin('PROVIDER_CHIRO');
    await visit({ staffId: prov.staff.id, patientId: (await makePatient({ firstName: 'Ophelia', lastName: 'Opaque' })).id });
    for (let i = 0; i < 3; i++) await worklist(prov);
    const rows = await auditRows({ resourceType: 'encounter', action: 'READ', actorAccountId: prov.accountId });
    const mine = rows.filter((r) => (r.meta as any)?.scope === 'unsigned_notes');
    expect(mine).toHaveLength(1);
    expect(mine[0]!.meta).toEqual({ scope: 'unsigned_notes', staffId: prov.staff.id, own: true, count: 1 });
    expect(blob(mine)).not.toMatch(/Ophelia|Opaque/);
  });
});

describe('"today" and dates are the clinic\'s calendar (America/Chicago)', () => {
  it('the worklist dates a visit by the clinic day: 23:30 in Chicago is the 13th, though it is already the 14th in UTC', async () => {
    const prov = await providerLogin('PROVIDER_CHIRO');
    const v = await visit({ staffId: prov.staff.id, encounter: 'CHECKED_OUT', start: local('2026-10-12T23:30:00') });
    expect(v.booking.startTime.toISOString()).toBe('2026-10-13T04:30:00.000Z');
    expect((await worklist(prov)).rows.find((r: any) => r.bookingId === v.booking.id)).toMatchObject({ localDate: '2026-10-12', localStart: '23:30' });
  });

  it('a visit checked out at 23:50 with its note pending is on today\'s Ledger until midnight in Chicago, then an earlier visit — still pending, still on the worklist, and signable', async () => {
    const prov = await providerLogin('PROVIDER_CHIRO');
    const fd = await frontDeskLogin();
    const p = await makePatient();
    const v = await visit({ staffId: prov.staff.id, patientId: p.id, start: local('2026-10-13T23:30:00'), checkedInAt: local('2026-10-13T23:25:00') });
    try {
      setClockForTests(local('2026-10-13T23:50:00'));
      await checkOut(fd, v.booking.id);
      let l = await ledgerOf(fd, p.id);
      expect(l.today).toBe('2026-10-13');
      expect(l.todayVisits.map((x: any) => x.id)).toEqual([v.booking.id]);
      expect(ledgerVisit(l, v.booking.id)).toMatchObject({ state: 'checked_out', note: 'PENDING' });

      setClockForTests(local('2026-10-14T00:05:00'));                                                   // 05:05Z — past midnight in Chicago
      l = await ledgerOf(fd, p.id);
      expect(l.today).toBe('2026-10-14');
      expect(l.todayVisits).toEqual([]);
      expect(l.priorVisits.map((x: any) => x.id)).toEqual([v.booking.id]);
      expect(ledgerVisit(l, v.booking.id)).toMatchObject({ state: 'checked_out', note: 'PENDING', localDate: '2026-10-13' });
      expect((await worklist(prov)).rows.find((r: any) => r.bookingId === v.booking.id)).toMatchObject({ localDate: '2026-10-13', overdue: false });

      expect((await sign(prov, v.booking.id)).afterCheckout).toBe(true);
      expect(ledgerVisit(await ledgerOf(fd, p.id), v.booking.id)).toMatchObject({ state: 'checked_out', note: 'SIGNED' });
    } finally {
      setClockForTests(TUESDAY_1007);
    }
  });
});

describe('Configuration → Services: "Requires a signed note"', () => {
  it('is changed by an admin only, validated, listed, and audited from → to', async () => {
    const admin = await adminLogin();
    const fd = await frontDeskLogin();
    const { service } = await makeClinic();
    expect(service.requiresNote).toBe(true);                                                          // a new service needs a note unless told otherwise

    expect((await patch(fd, `/api/admin/services/${service.id}`, { requiresNote: false })).status).toBe(403);
    expect((await patch(admin, `/api/admin/services/${service.id}`, { requiresNote: 'no' })).status).toBe(400);
    const r = await patch(admin, `/api/admin/services/${service.id}`, { requiresNote: false });
    expect(r.status).toBe(200);
    expect(r.body.service.requiresNote).toBe(false);
    const rows = await auditRows({ resourceType: 'service', resourceId: service.id, action: 'UPDATE' });
    expect(rows.map((x) => x.meta)).toEqual([{ fields: ['requiresNote'], from: true, to: false }]);

    await patch(admin, `/api/admin/services/${service.id}`, { requiresNote: false });                  // the same value again is not a change
    expect(await auditRows({ resourceType: 'service', resourceId: service.id, action: 'UPDATE' })).toHaveLength(1);
    const list = (await admin.agent.get('/api/admin/services')).body.services;
    expect(list.find((s: any) => s.id === service.id).requiresNote).toBe(false);
  });
});
