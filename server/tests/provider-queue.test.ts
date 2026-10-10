import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '../src/lib/prisma.js';
import { basePrisma } from '../src/lib/prismaBase.js';
import { setClockForTests } from '../src/lib/clock.js';
import { app, auditRows, blob, makeAccount, signIn } from './helpers.js';
import { makePatient, slotAt, TUESDAY_1007 } from './phase2.js';
import { adminLogin, frontDeskLogin, providerLogin, URL, visit } from './phase4.js';

beforeAll(() => setClockForTests(TUESDAY_1007));
afterAll(() => setClockForTests(null));

const ids = (rows: Array<{ bookingId: string }>) => rows.map((r) => r.bookingId);

describe('access', () => {
  it('is closed to anonymous callers and the front desk, and open to providers and admins', async () => {
    expect((await request(app).get(URL.queue())).status).toBe(401);
    expect((await (await frontDeskLogin()).agent.get(URL.queue('PROVIDER_NP'))).status).toBe(403);
    expect((await (await providerLogin('PROVIDER_NP')).agent.get(URL.queue())).status).toBe(200);
    expect((await (await adminLogin()).agent.get(URL.queue('PROVIDER_NP'))).status).toBe(200);
  });

  it('records the front desk\'s refused attempt', async () => {
    const fd = await frontDeskLogin();
    await fd.agent.get(URL.queue('PROVIDER_NP'));
    const rows = await auditRows({ action: 'ACCESS_DENIED', actorAccountId: fd.state.account.id });
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe('role filtering', () => {
  it('shows a provider only the checked-in patients booked with their role (plus visits with no provider assigned)', async () => {
    const chiro = await visit({ staffRole: 'CHIROPRACTOR' });
    const np = await visit({ staffRole: 'NURSE_PRACTITIONER' });
    const nurse = await visit({ staffRole: 'REGISTERED_NURSE' });
    const unassigned = await visit({ staffRole: null });

    const want: Array<[Parameters<typeof providerLogin>[0], string[], string[]]> = [
      ['PROVIDER_CHIRO', [chiro.booking.id, unassigned.booking.id], [np.booking.id, nurse.booking.id]],
      ['PROVIDER_NP', [np.booking.id, unassigned.booking.id], [chiro.booking.id, nurse.booking.id]],
      ['PROVIDER_NURSE', [nurse.booking.id, unassigned.booking.id], [chiro.booking.id, np.booking.id]],
    ];
    for (const [role, shown, hidden] of want) {
      const p = await providerLogin(role);
      const body = (await p.agent.get(URL.queue())).body;
      expect(body.role, role).toBe(role);
      for (const id of shown) expect(ids(body.rows), `${role} should see ${id}`).toContain(id);
      for (const id of hidden) expect(ids(body.rows), `${role} should not see ${id}`).not.toContain(id);
    }
  });

  it('marks the visits booked with the signed-in provider personally, and room-only visits as unassigned', async () => {
    const p = await providerLogin('PROVIDER_CHIRO');
    const mine = await visit({ staffId: p.staff.id });
    const colleague = await visit({ staffRole: 'CHIROPRACTOR' });
    const none = await visit({ staffRole: null });
    const rows = (await p.agent.get(URL.queue())).body.rows as any[];
    expect(rows.find((r) => r.bookingId === mine.booking.id)).toMatchObject({ isMine: true, unassigned: false, mayDocument: true });
    expect(rows.find((r) => r.bookingId === colleague.booking.id)).toMatchObject({ isMine: false, unassigned: false, mayDocument: true });
    expect(rows.find((r) => r.bookingId === none.booking.id)).toMatchObject({ isMine: false, unassigned: true, mayDocument: true });
  });
});

describe('who is in the queue', () => {
  it('lists only patients who have been checked in, on a confirmed appointment, today', async () => {
    const p = await providerLogin('PROVIDER_CHIRO');
    const checkedIn = await visit({ encounter: 'CHECKED_IN' });
    const inProgress = await visit({ encounter: 'IN_PROGRESS' });
    const seen = await visit({ encounter: 'SEEN' });
    const out = await visit({ encounter: 'CHECKED_OUT' });
    const scheduled = await visit({ encounter: 'SCHEDULED' });
    const noShow = await visit({ encounter: 'NO_SHOW' });
    const noEncounter = await visit({ encounter: null });
    const cancelled = await visit({ bookingStatus: 'CANCELLED' });
    const tomorrow = await visit({ start: slotAt('10:00', '2026-10-14') });

    const body = (await p.agent.get(URL.queue())).body;
    for (const v of [checkedIn, inProgress, seen, out]) expect(ids(body.rows)).toContain(v.booking.id);
    for (const v of [scheduled, noShow, noEncounter, cancelled, tomorrow]) {
      expect(ids(body.rows)).not.toContain(v.booking.id);
      expect(ids(body.backlog)).not.toContain(v.booking.id);
    }
  });

  it('puts the longest-waiting patient first and says how long they have waited', async () => {
    const p = await providerLogin('PROVIDER_NURSE');
    const later = await visit({ staffRole: 'REGISTERED_NURSE', checkedInAt: new Date('2026-10-13T15:05:00Z') });
    const earlier = await visit({ staffRole: 'REGISTERED_NURSE', checkedInAt: new Date('2026-10-13T14:30:00Z') });
    const rows = (await p.agent.get(URL.queue())).body.rows as any[];
    expect(rows.findIndex((r) => r.bookingId === earlier.booking.id)).toBeLessThan(rows.findIndex((r) => r.bookingId === later.booking.id));
    expect(rows.find((r) => r.bookingId === earlier.booking.id).waitingMinutes).toBe(37);   // 14:30Z → 15:07Z
    expect(rows.find((r) => r.bookingId === later.booking.id).waitingMinutes).toBe(2);
  });

  it('shows the patient name — the linked patient record, else the name the booking was made under', async () => {
    const p = await providerLogin('PROVIDER_CHIRO');
    const patient = await makePatient({ firstName: 'Ingrid', lastName: 'Holloway' });
    const linked = await visit({ patientId: patient.id });
    const unlinked = await visit({ contactName: 'Walk Upon' });
    const rows = (await p.agent.get(URL.queue())).body.rows as any[];
    expect(rows.find((r) => r.bookingId === linked.booking.id).patient).toEqual({ id: patient.id, name: 'Ingrid Holloway' });
    expect(rows.find((r) => r.bookingId === unlinked.booking.id).patient).toEqual({ id: null, name: 'Walk Upon' });
  });
});

describe('pending documentation, per encounter', () => {
  it('says whether each visit has no note, a draft, or a signed note — and who signed it', async () => {
    const p = await providerLogin('PROVIDER_CHIRO');
    const none = await visit({});
    const draft = await visit({});
    const signed = await visit({ encounter: 'SEEN' });
    await prisma.documentationDraft.create({ data: { bookingId: draft.booking.id, type: 'SOAP', createdByAccountId: p.accountId, createdByRole: 'PROVIDER_CHIRO', updatedByAccountId: p.accountId } });
    await prisma.noteSignature.create({
      data: { bookingId: signed.booking.id, type: 'SOAP', noteIds: ['x'], signedAt: new Date('2026-10-13T15:20:00Z'), signedByAccountId: p.accountId, signedByStaffId: p.staff.id, signedRole: 'PROVIDER_CHIRO' },
    });

    const body = (await p.agent.get(URL.queue())).body;
    const by = (id: string) => body.rows.find((r: any) => r.bookingId === id).documentation;
    expect(by(none.booking.id)).toMatchObject({ status: 'NONE', signedAt: null, signedBy: null });
    expect(by(draft.booking.id)).toMatchObject({ status: 'DRAFT', signedAt: null });
    expect(by(signed.booking.id)).toMatchObject({ status: 'SIGNED', signedBy: p.staff.name });
    expect(by(signed.booking.id).signedAt).toBe('2026-10-13T15:20:00.000Z');
    expect(body.pending).toBeGreaterThanOrEqual(2);                                   // none + draft are still to do
  });

  it('carries each visit\'s documentation type, so the queue can tell a SOAP note from a session log', async () => {
    const p = await providerLogin('PROVIDER_CHIRO');
    const soap = await visit({ doc: 'SOAP' });
    const log = await visit({ doc: 'SESSION_LOG' });
    const rows = (await p.agent.get(URL.queue())).body.rows as any[];
    expect(rows.find((r) => r.bookingId === soap.booking.id).documentation.type).toBe('SOAP');
    expect(rows.find((r) => r.bookingId === log.booking.id).documentation.type).toBe('SESSION_LOG');
  });

  it('lists earlier visits still waiting for a signature apart from today\'s, newest first, within 30 days', async () => {
    const p = await providerLogin('PROVIDER_CHIRO');
    const yesterday = await visit({ encounter: 'CHECKED_OUT', start: slotAt('10:00', '2026-10-12') });
    const lastWeek = await visit({ encounter: 'CHECKED_OUT', start: slotAt('10:00', '2026-10-06') });
    const signedEarlier = await visit({ encounter: 'CHECKED_OUT', start: slotAt('10:00', '2026-10-12') });
    const ancient = await visit({ encounter: 'CHECKED_OUT', start: slotAt('10:00', '2026-08-01') });
    await prisma.noteSignature.create({
      data: { bookingId: signedEarlier.booking.id, type: 'SOAP', noteIds: ['x'], signedAt: new Date('2026-10-12T16:00:00Z'), signedByAccountId: p.accountId, signedByStaffId: p.staff.id, signedRole: 'PROVIDER_CHIRO' },
    });
    const body = (await p.agent.get(URL.queue())).body;
    const backlog = ids(body.backlog);
    expect(backlog).toContain(yesterday.booking.id);
    expect(backlog).toContain(lastWeek.booking.id);
    expect(backlog.indexOf(yesterday.booking.id)).toBeLessThan(backlog.indexOf(lastWeek.booking.id));
    expect(backlog).not.toContain(signedEarlier.booking.id);                           // signed: nothing pending
    expect(backlog).not.toContain(ancient.booking.id);                                 // beyond the window
    expect(ids(body.rows)).not.toContain(yesterday.booking.id);                        // earlier days are not "today"
  });
});

describe('switching roles', () => {
  it('defaults to the provider\'s own role and only offers that one', async () => {
    const p = await providerLogin('PROVIDER_NP');
    const body = (await p.agent.get(URL.queue())).body;
    expect(body.role).toBe('PROVIDER_NP');
    expect(body.roles).toEqual([{ role: 'PROVIDER_NP', own: true }]);
  });

  it('refuses a provider another role\'s queue', async () => {
    const p = await providerLogin('PROVIDER_NP');
    expect((await p.agent.get(URL.queue('PROVIDER_CHIRO'))).status).toBe(403);
    expect((await p.agent.get(URL.queue('PROVIDER_NP'))).status).toBe(200);
    expect((await p.agent.get(URL.queue('NOT_A_ROLE'))).status).toBe(400);
  });

  it('lets a provider who is also an admin switch to the other roles\' queues, which are theirs to read but not to write', async () => {
    const p = await providerLogin('PROVIDER_NP', ['ADMIN']);
    const chiro = await visit({ staffRole: 'CHIROPRACTOR' });
    const own = (await p.agent.get(URL.queue())).body;
    expect(own.role).toBe('PROVIDER_NP');
    expect(own.roles).toEqual([
      { role: 'PROVIDER_NP', own: true }, { role: 'PROVIDER_CHIRO', own: false }, { role: 'PROVIDER_NURSE', own: false },
    ]);
    const other = (await p.agent.get(URL.queue('PROVIDER_CHIRO'))).body;
    expect(other.role).toBe('PROVIDER_CHIRO');
    expect(ids(other.rows)).toContain(chiro.booking.id);
  });

  it('makes an admin with no provider role choose, and lets them look at any', async () => {
    const admin = await adminLogin();
    expect((await admin.agent.get(URL.queue())).status).toBe(400);
    expect((await admin.agent.get(URL.queue())).body.code).toBe('role_required');
    for (const role of ['PROVIDER_CHIRO', 'PROVIDER_NP', 'PROVIDER_NURSE']) {
      const r = await admin.agent.get(URL.queue(role));
      expect(r.status, role).toBe(200);
      expect(r.body.roles.every((x: any) => x.own === false)).toBe(true);
    }
  });

  it('gives a provider who also works the front desk their own role\'s queue and nothing wider', async () => {
    const p = await providerLogin('PROVIDER_CHIRO', ['FRONT_DESK']);
    expect((await p.agent.get(URL.queue())).body.role).toBe('PROVIDER_CHIRO');
    expect((await p.agent.get(URL.queue('PROVIDER_NURSE'))).status).toBe(403);
  });
});

describe('audit', () => {
  it('records a read of the queue, with a count and the role but no names', async () => {
    const p = await providerLogin('PROVIDER_CHIRO');
    await visit({ contactName: 'Zephyrine Quillon' });
    await p.agent.get(URL.queue());
    const rows = await auditRows({ action: 'READ', resourceType: 'encounter', actorAccountId: p.accountId });
    expect(rows.length).toBeGreaterThan(0);
    expect(blob(rows)).toContain('provider_queue');
    expect(blob(rows)).not.toContain('Zephyrine');
  });
});

describe('what the front desk sees of the clinical record', () => {
  it('is whether a note exists and is signed — and nothing else — on every appointment view', async () => {
    const fd = await frontDeskLogin();
    const p = await providerLogin('PROVIDER_CHIRO');
    const patient = await makePatient();
    const v = await visit({ patientId: patient.id, encounter: 'SEEN' });
    await prisma.visitNote.create({ data: { bookingId: v.booking.id, authorId: p.staff.id, kind: 'SUBJECTIVE', body: 'CONFIDENTIAL-CLINICAL-TEXT-7731' } });
    await prisma.noteSignature.create({
      data: { bookingId: v.booking.id, type: 'SOAP', noteIds: ['x'], signedAt: new Date('2026-10-13T15:20:00Z'), signedByAccountId: p.accountId, signedByStaffId: p.staff.id, signedRole: 'PROVIDER_CHIRO' },
    });

    const dash = (await fd.agent.get('/api/fd/dashboard?date=2026-10-13')).body;
    const appt = [...dash.checkedIn, ...dash.done].find((a: any) => a.id === v.booking.id);
    expect(appt.documentation).toEqual({ status: 'SIGNED', signedAt: '2026-10-13T15:20:00.000Z' });
    expect(blob(dash)).not.toContain('CONFIDENTIAL-CLINICAL-TEXT-7731');

    // The older notes route keeps telling the front desk THAT notes exist, never what they say.
    const notes = (await fd.agent.get(`/api/bookings/${v.booking.id}/notes`)).body;
    expect(notes).toMatchObject({ restricted: true, noteCount: 1, notes: [] });
    expect(blob(notes)).not.toContain('CONFIDENTIAL-CLINICAL-TEXT-7731');
    // …and the new provider routes are closed to it outright.
    expect((await fd.agent.get(URL.ws(v.booking.id))).status).toBe(403);
  });

  it('shows no-note and draft states as such', async () => {
    const fd = await frontDeskLogin();
    const p = await providerLogin('PROVIDER_CHIRO');
    const none = await visit({});
    const draft = await visit({});
    await prisma.documentationDraft.create({ data: { bookingId: draft.booking.id, type: 'SOAP', subjective: 'DRAFT-TEXT-5512', createdByAccountId: p.accountId, createdByRole: 'PROVIDER_CHIRO', updatedByAccountId: p.accountId } });
    const dash = (await fd.agent.get('/api/fd/dashboard?date=2026-10-13')).body;
    const find = (id: string) => dash.checkedIn.find((a: any) => a.id === id);
    expect(find(none.booking.id).documentation).toEqual({ status: 'NONE', signedAt: null });
    expect(find(draft.booking.id).documentation).toEqual({ status: 'DRAFT', signedAt: null });
    expect(blob(dash)).not.toContain('DRAFT-TEXT-5512');
  });
});

describe('MFA before the queue', () => {
  it('sends a provider who has not enrolled an authenticator to set one up, whatever they ask for', async () => {
    const acct = await makeAccount({ roles: ['PROVIDER_NP'], staffId: (await prisma.staff.create({ data: { name: 'No MFA', role: 'NURSE_PRACTITIONER' } })).id });
    const s = await signIn(acct.email);
    expect(s.state.needs).toContain('mfa_enroll');
    const r = await s.agent.get(URL.queue());
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: 'step_up_required', needs: ['mfa_enroll'] });
    expect(await basePrisma.account.count({ where: { id: acct.id, mfaEnabledAt: null } })).toBe(1);
  });
});
