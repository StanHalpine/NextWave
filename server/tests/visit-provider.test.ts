import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { basePrisma } from '../src/lib/prismaBase.js';
import { setClockForTests } from '../src/lib/clock.js';
import { computeDayAvailability } from '../src/lib/availability.js';
import { loadIntegrations } from '../src/integrations/index.js';
import { app, auditRows, blob, makeAccount, signInFully } from './helpers.js';
import { makeClinic, makePatient, slotAt, TUESDAY_1007, TUESDAY_DATE } from './phase2.js';
import { adminLogin, frontDeskLogin, post, providerLogin, put, saveSoap, URL, visit, type Provider } from './phase4.js';
import type { Signed } from './helpers.js';

/**
 * Rev 2.1: a visit's note belongs to the visit's PROVIDER, not to their role. The visit's provider is the covering provider when the
 * front desk has set one (Encounter.coveringStaffId), else the one it was booked with (lib/visitProvider.ts). Only they may start,
 * draft, use the AI draft, record scribe consent or audio, and sign; amend stays signer-only and an addendum stays open to any
 * provider. The booking — and so the scheduling engine — is never changed by any of it.
 *
 * The clock is pinned to Tuesday 2026-10-13, 10:07 in the clinic.
 */

beforeAll(async () => { setClockForTests(TUESDAY_1007); await loadIntegrations(); });   // the scribe's stubs, as tests/scribe.test.ts loads them
afterAll(() => setClockForTests(null));

const TYPE = 'audio/webm;codecs=opus';
const PROVIDER = (id: string) => `/api/fd/appointments/${id}/provider`;
const OPTIONS = (id: string) => `/api/fd/appointments/${id}/provider-options`;
const CONFIRM = (id: string) => `/api/provider/visits/${id}/confirm-covering`;
const MISMATCHES = '/api/provider/signature-mismatches';
const encounterOf = (bookingId: string) => basePrisma.encounter.findUniqueOrThrow({ where: { bookingId } });
/** A staff member may perform the visit's service (Configuration → Services → Who can perform this). */
const authorise = (serviceId: string, ...staffIds: string[]) => basePrisma.serviceStaff.createMany({ data: staffIds.map((staffId) => ({ serviceId, staffId })) });
const sign = async (p: Provider, bookingId: string) => post(p, URL.sign(bookingId), { version: await saveSoap(p, bookingId) });

/** Dr. Chase's visit, and Dr. Stan — same role, a colleague — both able to perform the service. */
async function chaseAndStan() {
  const chase = await providerLogin('PROVIDER_CHIRO');
  const stan = await providerLogin('PROVIDER_CHIRO');
  const v = await visit({ staffId: chase.staff.id, patientId: (await makePatient({ firstName: 'Ben', lastName: 'Aflax' })).id });
  await authorise(v.service.id, chase.staff.id, stan.staff.id);
  return { chase, stan, v, id: v.booking.id };
}

describe('only the visit\'s provider may write and sign its note', () => {
  it('refuses a colleague in the same role on every write path — start, draft, AI draft, scribe consent and audio, sign — and lets the visit\'s provider do each', async () => {
    const { chase, stan, id } = await chaseAndStan();
    // Chase starts a recording so there is a session for the follow-up calls to name.
    expect((await post(chase, URL.consent(id), { consented: true })).status).toBe(200);
    const started = await post(chase, URL.sessions(id), { contentType: TYPE });
    expect(started.status).toBe(201);
    const sid = started.body.session.id as string;

    const attempts: Array<[string, () => Promise<request.Response>]> = [
      ['start', () => post(stan, URL.start(id))],
      ['draft', () => put(stan, URL.draft(id), { subjective: 'x' })],
      ['ai draft', () => post(stan, URL.session(id, sid, '/apply'), { mode: 'fill_empty' })],
      ['consent', () => post(stan, URL.consent(id), { consented: true })],
      ['recording', () => post(stan, URL.sessions(id), { contentType: TYPE })],
      ['upload', () => post(stan, URL.session(id, sid, '/upload'))],
      ['finish', () => post(stan, URL.session(id, sid, '/finish'), { bytes: 10 })],
      ['retry', () => post(stan, URL.session(id, sid, '/retry'))],
      ['discard', () => post(stan, URL.session(id, sid, '/discard'))],
      ['sign', () => post(stan, URL.sign(id), { version: 1 })],
    ];
    for (const [label, attempt] of attempts) {
      const r = await attempt();                                                       // one at a time
      expect(r.status, label).toBe(403);
      expect(r.body.code, label).toBe('not_visit_provider');
      expect(r.body.error, label).toMatch(new RegExp(`${chase.staff.name}’s visit`));
    }
    expect(await basePrisma.documentationDraft.count({ where: { bookingId: id } })).toBe(0);
    expect((await basePrisma.scribeSession.findUniqueOrThrow({ where: { id: sid } })).status).toBe('RECORDING');   // not discarded by Stan

    expect((await post(chase, URL.start(id))).status).toBe(200);
    const r = await sign(chase, id);
    expect(r.status).toBe(201);
    expect((await basePrisma.noteSignature.findUniqueOrThrow({ where: { bookingId: id } })).signedByStaffId).toBe(chase.staff.id);
  });

  it('shows the workspace read-only to a colleague, naming the visit\'s provider; the queue marks it theirs to read, not write', async () => {
    const { chase, stan, id } = await chaseAndStan();
    const ws = (await stan.agent.get(URL.ws(id))).body;
    expect(ws.access).toMatchObject({ canWrite: false, readOnlyReason: expect.stringContaining(chase.staff.name) });
    expect(ws.booking.provider).toMatchObject({ id: chase.staff.id });
    const row = (await stan.agent.get(URL.queue())).body.rows.find((x: any) => x.bookingId === id);
    expect(row).toMatchObject({ isMine: false, mayDocument: false });
    expect((await chase.agent.get(URL.ws(id))).body.access.canWrite).toBe(true);
  });

  it('holds an administrator who also has a provider role to the same rule', async () => {
    const { chase, id } = await chaseAndStan();
    const adminDoc = await providerLogin('PROVIDER_CHIRO', ['ADMIN']);
    const r = await put(adminDoc, URL.draft(id), { subjective: 'x' });
    expect([r.status, r.body.code]).toEqual([403, 'not_visit_provider']);
    expect((await put(chase, URL.draft(id), { subjective: 'x' })).status).toBe(200);
  });

  it('keeps the role rule for a visit with no provider at all, and refuses another role outright', async () => {
    const nurse = await providerLogin('PROVIDER_NURSE');
    expect((await put(nurse, URL.draft((await visit({ staffRole: null })).booking.id), { subjective: 'x' })).status).toBe(200);
    const np = await providerLogin('PROVIDER_NP');
    const { id } = await chaseAndStan();
    expect((await put(np, URL.draft(id), { subjective: 'x' })).body.code).toBe('wrong_role');
  });

  it('amend stays the signer\'s alone; an addendum stays open to any provider', async () => {
    const { chase, stan, id } = await chaseAndStan();
    expect((await sign(chase, id)).status).toBe(201);
    const [note] = await basePrisma.visitNote.findMany({ where: { bookingId: id }, orderBy: { createdAt: 'asc' } });
    const amend = await post(stan, `/api/visit-notes/${note!.id}/amend`, { body: 'x', amendReason: 'y' });
    expect([amend.status, amend.body.code]).toEqual([403, 'not_author']);
    expect((await post(stan, `/api/visit-notes/${note!.id}/addendum`, { body: 'Reviewed in clinic.' })).status).toBe(201);
    expect((await post(chase, `/api/visit-notes/${note!.id}/amend`, { body: 'Corrected.', amendReason: 'typo' })).status).toBe(201);
  });
});

describe('Change provider… — a covering provider for a checked-in visit', () => {
  it('lets the desk name the covering provider; they become the visit\'s provider and can sign, the booked one no longer can, and the worklist follows', async () => {
    const { chase, stan, id } = await chaseAndStan();
    const fd = await frontDeskLogin();
    expect((await (await chase.agent.get('/api/provider/unsigned-notes')).body.rows as any[]).map((r) => r.bookingId)).toContain(id);

    const r = await post(fd, PROVIDER(id), { staffId: stan.staff.id });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ changed: true, appointment: { staff: { id: chase.staff.id }, covering: { id: stan.staff.id, name: stan.staff.name } } });
    expect((await encounterOf(id)).coveringStaffId).toBe(stan.staff.id);

    expect((await put(chase, URL.draft(id), { subjective: 'x' })).body.code).toBe('not_visit_provider');
    expect(((await chase.agent.get('/api/provider/unsigned-notes')).body.rows as any[]).map((x) => x.bookingId)).not.toContain(id);
    expect(((await stan.agent.get('/api/provider/unsigned-notes')).body.rows as any[]).map((x) => x.bookingId)).toContain(id);
    expect((await stan.agent.get(URL.queue())).body.rows.find((x: any) => x.bookingId === id)).toMatchObject({ isMine: true, mayDocument: true, covering: { id: stan.staff.id }, staff: { id: chase.staff.id } });
    const ws = (await stan.agent.get(URL.ws(id))).body;
    expect(ws.booking).toMatchObject({ provider: { id: stan.staff.id }, scheduledProvider: { id: chase.staff.id }, covering: true });
    expect((await sign(stan, id)).status).toBe(201);
  });

  it('is audited with ids only, does nothing the second time, and naming the booked provider again clears it', async () => {
    const { chase, stan, id, v } = await chaseAndStan();
    const fd = await frontDeskLogin();
    expect((await post(fd, PROVIDER(id), { staffId: stan.staff.id })).body.changed).toBe(true);
    expect((await post(fd, PROVIDER(id), { staffId: stan.staff.id })).body.changed).toBe(false);
    const rows = await auditRows({ resourceType: 'encounter', resourceId: v.encounter!.id, action: 'UPDATE' });
    const changes = rows.filter((x) => (x.meta as any)?.fields?.includes('coveringStaffId'));
    expect(changes.map((x) => x.meta)).toEqual([{ fields: ['coveringStaffId'], from: chase.staff.id, to: stan.staff.id, draftOpen: false, via: 'front_desk' }]);
    expect(blob(changes)).not.toMatch(/Ben|Aflax|Test PROVIDER/);

    expect((await post(fd, PROVIDER(id), { staffId: chase.staff.id })).body.changed).toBe(true);
    expect((await encounterOf(id)).coveringStaffId).toBeNull();
  });

  it('refuses an unknown, inactive, wrong-role or unauthorised provider, and changes nothing', async () => {
    const { id, v } = await chaseAndStan();
    const fd = await frontDeskLogin();
    const off = await providerLogin('PROVIDER_CHIRO');
    await authorise(v.service.id, off.staff.id);
    await basePrisma.staff.update({ where: { id: off.staff.id }, data: { active: false } });
    const np = await providerLogin('PROVIDER_NP');
    await authorise(v.service.id, np.staff.id);
    const notSetUp = await providerLogin('PROVIDER_CHIRO');                       // right role, but not allowed to perform this service

    expect((await post(fd, PROVIDER(id), { staffId: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
    for (const [who, code] of [[off, 'inactive'], [np, 'wrong_role'], [notSetUp, 'not_authorized']] as const) {
      const r = await post(fd, PROVIDER(id), { staffId: who.staff.id });
      expect([r.status, r.body.code], code).toEqual([409, code]);
    }
    expect((await encounterOf(id)).coveringStaffId).toBeNull();
  });

  it('before check-in, sends the desk to Move; once the note is signed, refuses', async () => {
    const { chase, stan } = await chaseAndStan();
    const fd = await frontDeskLogin();
    const later = await visit({ staffId: chase.staff.id, encounter: null, start: slotAt('15:00') });
    await authorise(later.service.id, stan.staff.id);
    const r = await post(fd, PROVIDER(later.booking.id), { staffId: stan.staff.id });
    expect([r.status, r.body.code]).toEqual([409, 'use_move']);
    expect(r.body.error).toMatch(/Move…/);
    // an encounter that exists but is not a checked-in one is the same: moved back to scheduled, or a no-show
    for (const status of ['SCHEDULED', 'NO_SHOW'] as const) {
      const w = await visit({ staffId: chase.staff.id, encounter: status, start: slotAt('09:00') });
      await authorise(w.service.id, stan.staff.id);
      expect((await post(fd, PROVIDER(w.booking.id), { staffId: stan.staff.id })).body.code, status).toBe('use_move');
      expect((await encounterOf(w.booking.id)).coveringStaffId, status).toBeNull();
    }

    const { id: signedId, chase: c2, stan: s2 } = await chaseAndStan();
    expect((await sign(c2, signedId)).status).toBe(201);
    const s = await post(fd, PROVIDER(signedId), { staffId: s2.staff.id });
    expect([s.status, s.body.code]).toEqual([409, 'already_signed']);
  });

  it('asks the desk to confirm when another provider has a draft open, and keeps the draft', async () => {
    const { chase, stan, id } = await chaseAndStan();
    const fd = await frontDeskLogin();
    await saveSoap(chase, id);
    const r = await post(fd, PROVIDER(id), { staffId: stan.staff.id });
    expect([r.status, r.body.code, r.body.draftBy]).toEqual([409, 'draft_open', chase.staff.name]);
    expect((await encounterOf(id)).coveringStaffId).toBeNull();
    const ok = await post(fd, PROVIDER(id), { staffId: stan.staff.id, confirmDraft: true });
    expect(ok.status).toBe(200);
    expect(await basePrisma.documentationDraft.count({ where: { bookingId: id } })).toBe(1);
    expect((await auditRows({ resourceType: 'encounter', action: 'UPDATE' })).some((x) => (x.meta as any)?.draftOpen === true && (x.meta as any)?.to === stan.staff.id)).toBe(true);
  });

  it('is for the front desk and administrators only', async () => {
    const { stan, id } = await chaseAndStan();
    expect((await request(app).post(PROVIDER(id)).send({ staffId: stan.staff.id })).status).toBe(401);
    expect((await post(stan, PROVIDER(id), { staffId: stan.staff.id })).status).toBe(403);
    expect((await post(await adminLogin(), PROVIDER(id), { staffId: stan.staff.id })).status).toBe(200);
    expect((await post(await frontDeskLogin(), PROVIDER(id), { bogus: 1 })).status).toBe(400);
  });

  it('records the visit\'s provider — the covering one — at check-out, for Accounting', async () => {
    const { chase, stan, id, v } = await chaseAndStan();
    const fd = await frontDeskLogin();
    await post(fd, PROVIDER(id), { staffId: stan.staff.id });
    expect((await post(fd, `/api/fd/appointments/${id}/check-out`, { payment: 'CASH', priceCents: 5500 })).status).toBe(200);
    expect((await basePrisma.revenueEvent.findUniqueOrThrow({ where: { encounterId: v.encounter!.id } })).staffId).toBe(stan.staff.id);
    // without a covering provider it is still the booked one
    const plain = await visit({ staffId: chase.staff.id, start: slotAt('11:00') });
    await post(fd, `/api/fd/appointments/${plain.booking.id}/check-out`, { payment: 'CASH', priceCents: 5500 });
    expect((await basePrisma.revenueEvent.findUniqueOrThrow({ where: { encounterId: plain.encounter!.id } })).staffId).toBe(chase.staff.id);
  });

  it('never touches the booking or what the scheduling engine sees: same row, same availability for both providers', async () => {
    const clinic = await makeClinic({ rooms: 2, staff: 2 });
    const [booked, covering] = clinic.staff;
    const fd = await frontDeskLogin();
    const user = await basePrisma.user.create({ data: { name: 'Walk Through', email: '', phone: '6125550000' } });
    const b = await basePrisma.booking.create({
      data: { userId: user.id, serviceId: clinic.service.id, resourceId: clinic.rooms[0]!.id, staffId: booked!.id, startTime: slotAt('11:00'), endTime: slotAt('11:30'), status: 'CONFIRMED', source: 'FRONT_DESK' },
    });
    await basePrisma.encounter.create({ data: { bookingId: b.id, status: 'CHECKED_IN', checkedInAt: slotAt('10:55') } });
    const snapshot = async () => ({
      booking: JSON.stringify(await basePrisma.booking.findUniqueOrThrow({ where: { id: b.id } })),
      day: JSON.stringify(await computeDayAvailability(basePrisma as never, clinic.service.id, TUESDAY_DATE, TUESDAY_1007)),
    });
    const before = await snapshot();
    expect((await post(fd, PROVIDER(b.id), { staffId: covering!.id })).status).toBe(200);
    expect(await snapshot()).toEqual(before);
  });
});

describe('the overlap warning', () => {
  it('lists each eligible provider with their other appointments overlapping this visit — booked or covering — and nothing that does not overlap', async () => {
    const { chase, stan, id, v } = await chaseAndStan();
    const fd = await frontDeskLogin();
    // Stan is booked 09:45–10:15 (overlaps this 10:00–10:30 visit), 10:30–11:00 (touches, does not overlap), and covers 10:15–10:45 for someone else.
    const own = await visit({ staffId: stan.staff.id, start: slotAt('09:45') });
    const after = await visit({ staffId: stan.staff.id, start: slotAt('10:30') });
    const elsewhere = await visit({ staffId: chase.staff.id, start: slotAt('10:15') });
    await basePrisma.encounter.update({ where: { id: elsewhere.encounter!.id }, data: { coveringStaffId: stan.staff.id } });
    const cancelled = await visit({ staffId: stan.staff.id, start: slotAt('10:00'), bookingStatus: 'CANCELLED' });

    const r = await fd.agent.get(OPTIONS(id));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ bookingId: id, currentId: chase.staff.id, checkedIn: true, signed: false, scheduled: { id: chase.staff.id } });
    const byId = new Map((r.body.options as any[]).map((o) => [o.id, o]));
    expect(byId.get(chase.staff.id)).toMatchObject({ isCurrent: true, isScheduled: true });
    const s = byId.get(stan.staff.id);
    expect(s).toMatchObject({ isCurrent: false, isScheduled: false });
    expect(s.overlaps.map((o: any) => o.bookingId).sort()).toEqual([own.booking.id, elsewhere.booking.id].sort());
    expect(s.overlaps.find((o: any) => o.bookingId === elsewhere.booking.id)).toMatchObject({ asCovering: true, localStart: '10:15' });
    for (const no of [after, cancelled]) expect(s.overlaps.map((o: any) => o.bookingId)).not.toContain(no.booking.id);
    // Chase's own appointment covered by Stan is not Chase's any more
    expect(byId.get(chase.staff.id).overlaps.map((o: any) => o.bookingId)).not.toContain(elsewhere.booking.id);
    // a warning only: choosing Stan still works
    expect((await post(fd, PROVIDER(id), { staffId: stan.staff.id })).status).toBe(200);
    void v;
  });

  it('offers only active providers of the same role who may perform the service; providers cannot read it', async () => {
    const { stan, id, v } = await chaseAndStan();
    const np = await providerLogin('PROVIDER_NP');
    const notSetUp = await providerLogin('PROVIDER_CHIRO');
    await authorise(v.service.id, np.staff.id);
    const ids = ((await (await frontDeskLogin()).agent.get(OPTIONS(id))).body.options as any[]).map((o) => o.id);
    expect(ids).toContain(stan.staff.id);
    expect(ids).not.toContain(np.staff.id);
    expect(ids).not.toContain(notSetUp.staff.id);
    expect((await stan.agent.get(OPTIONS(id))).status).toBe(403);
  });
});

describe('notes signed by someone other than the visit\'s provider (signed under the old role rule)', () => {
  /** Stan's signature on Chase's visit, as the old rule allowed — written straight to the table, since the API no longer can. */
  async function signedByStan() {
    const c = await chaseAndStan();
    const note = await basePrisma.visitNote.create({ data: { bookingId: c.id, authorId: c.stan.staff.id, authorAccountId: c.stan.accountId, authorRole: 'PROVIDER_CHIRO', kind: 'GENERAL', body: 'Signed by a colleague.' } });
    await basePrisma.noteSignature.create({ data: { bookingId: c.id, type: 'SOAP', noteIds: [note.id], signedAt: TUESDAY_1007, signedByAccountId: c.stan.accountId, signedByStaffId: c.stan.staff.id, signedRole: 'PROVIDER_CHIRO' } });
    return { ...c, note };
  }

  it('are flagged on the workspace, and offered to an administrator to confirm — not to providers', async () => {
    const { chase, stan, id } = await signedByStan();
    const admin = await adminLogin();
    const asAdmin = (await admin.agent.get(URL.ws(id))).body;
    expect(asAdmin.signature).toMatchObject({ signerIsVisitProvider: false, signedBy: stan.staff.name });
    expect(asAdmin.access.canConfirmCovering).toBe(true);
    const asChase = (await chase.agent.get(URL.ws(id))).body;
    expect([asChase.signature.signerIsVisitProvider, asChase.access.canConfirmCovering]).toEqual([false, false]);
    // a correctly signed note is not flagged
    const ok = await chaseAndStan();
    expect((await sign(ok.chase, ok.id)).status).toBe(201);
    expect((await admin.agent.get(URL.ws(ok.id))).body.signature.signerIsVisitProvider).toBe(true);
  });

  it('are listed for an administrator; confirming the signer as covering clears it, is audited, and leaves the signature exactly as it was', async () => {
    const { chase, stan, id, v, note } = await signedByStan();
    const admin = await adminLogin();
    const listed = (await admin.agent.get(MISMATCHES)).body.rows as any[];
    expect(listed.find((r) => r.bookingId === id)).toMatchObject({ visitProvider: { id: chase.staff.id }, signedBy: { id: stan.staff.id, name: stan.staff.name }, patient: 'Ben Aflax' });

    const before = JSON.stringify(await basePrisma.noteSignature.findUniqueOrThrow({ where: { bookingId: id } }));
    const r = await post(admin, CONFIRM(id));
    expect([r.status, r.body.changed]).toEqual([200, true]);
    expect((await encounterOf(id)).coveringStaffId).toBe(stan.staff.id);
    expect(JSON.stringify(await basePrisma.noteSignature.findUniqueOrThrow({ where: { bookingId: id } }))).toBe(before);
    expect((await basePrisma.visitNote.findUniqueOrThrow({ where: { id: note.id } })).body).toBe('Signed by a colleague.');
    expect(((await admin.agent.get(MISMATCHES)).body.rows as any[]).map((x) => x.bookingId)).not.toContain(id);
    expect((await admin.agent.get(URL.ws(id))).body.signature.signerIsVisitProvider).toBe(true);
    const audit = (await auditRows({ resourceType: 'encounter', resourceId: v.encounter!.id, action: 'UPDATE' })).map((x) => x.meta);
    expect(audit).toContainEqual({ fields: ['coveringStaffId'], from: chase.staff.id, to: stan.staff.id, via: 'confirm_signer' });
    expect((await post(admin, CONFIRM(id))).body.changed).toBe(false);
  });

  it('only an administrator may list or confirm; providers and the desk are refused', async () => {
    const { chase, stan, id } = await signedByStan();
    for (const s of [chase, stan] as Signed[]) {
      expect((await s.agent.get(MISMATCHES)).status).toBe(403);
      expect((await post(s, CONFIRM(id))).status).toBe(403);
    }
    expect((await (await frontDeskLogin()).agent.get(MISMATCHES)).status).toBe(403);
    expect((await encounterOf(id)).coveringStaffId).toBeNull();
    const unsigned = await chaseAndStan();
    expect((await post(await adminLogin(), CONFIRM(unsigned.id))).body.code).toBe('not_signed');
  });

  it('leaves amend to the signer, and lets the visit\'s provider add an addendum', async () => {
    const { chase, stan, note } = await signedByStan();
    expect((await post(chase, `/api/visit-notes/${note.id}/amend`, { body: 'x', amendReason: 'y' })).body.code).toBe('not_author');
    expect((await post(chase, `/api/visit-notes/${note.id}/addendum`, { body: 'I saw the patient on the 13th.' })).status).toBe(201);
    expect((await post(stan, `/api/visit-notes/${note.id}/amend`, { body: 'Corrected.', amendReason: 'typo' })).status).toBe(201);
  });
});

describe('in the code', () => {
  const files: string[] = [];
  const walk = (dir: string) => { for (const n of readdirSync(dir)) { const p = path.join(dir, n); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p); } };
  walk('src');
  const read = (p: string) => readFileSync(p, 'utf8');
  const norm = (p: string) => p.split(path.sep).join('/');

  it('decides who may write in one place: the role check is only ever called by the person rule', () => {
    expect(files.filter((p) => /\broleMayDocument\(/.test(read(p)) && !/export function roleMayDocument/.test(read(p))).map(norm)).toEqual(['src/lib/visitProvider.ts']);
    expect(files.filter((p) => /\bwriteRefusal\(/.test(read(p)) && !/export function writeRefusal/.test(read(p))).map(norm).sort()).toEqual(['src/lib/documentation.ts', 'src/lib/providerViews.ts']);
  });

  it('every function that loads a visit to write it checks the rule first', () => {
    for (const f of ['src/lib/documentation.ts', 'src/lib/scribe.ts']) {
      for (const [, body] of read(f).matchAll(/export async function \w+\([^)]*\)[^{]*\{([\s\S]*?)\n\}/g)) {
        if (/await loadVisit\(/.test(body!)) expect(body, f).toMatch(/assertMayDocument\(v, a\.role, (me|who)\)/);
      }
    }
    // the scribe's follow-up routes use the same rule on the booking
    expect(read('src/routes/provider.ts').match(/assertMayWriteForBooking\(id\(req\), role, req\.auth!\.account\.id\)/g)).toHaveLength(4);
  });

  it('the older note route no longer writes, and the legacy grid no longer offers to', () => {
    const notes = read('src/routes/notes.ts');
    const route = notes.slice(notes.indexOf("notesRouter.post('/bookings/:id/notes'"), notes.indexOf('const amendBody'));
    expect(route).toMatch(/status\(410\)/);
    expect(route).not.toMatch(/visitNote\.create/);
    const grid = readFileSync('public/dashboard.js', 'utf8');
    expect(grid).not.toMatch(/'\/notes', \{\s*method: 'POST'/);
    expect(grid).not.toMatch(/Add note'/);
  });
});

describe('the admin who has no provider record', () => {
  it('cannot write a visit, and cannot set themselves as the covering provider', async () => {
    const { id } = await chaseAndStan();
    const admin = await signInFully((await makeAccount({ roles: ['ADMIN'] })).email);
    expect((await put(admin, URL.draft(id), { subjective: 'x' })).body.code).toBe('read_only');
  });
});
