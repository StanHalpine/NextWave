import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { config } from '../src/config.js';
import { prisma } from '../src/lib/prisma.js';
import { basePrisma } from '../src/lib/prismaBase.js';
import { setClockForTests } from '../src/lib/clock.js';
import { requireMfa } from '../src/middleware/clinical.js';
import { app, auditRows, blob, makeAccount, signIn, signInFully } from './helpers.js';
import { makePatient, TUESDAY_1007 } from './phase2.js';
import { adminLogin, frontDeskLogin, post, providerLogin, put, saveSoap, SOAP, URL, visit } from './phase4.js';

beforeAll(() => setClockForTests(TUESDAY_1007));
afterAll(() => setClockForTests(null));

const notesOf = (bookingId: string) => basePrisma.visitNote.findMany({ where: { bookingId }, orderBy: { createdAt: 'asc' } });
const exec = (sql: string) => basePrisma.$executeRawUnsafe(sql);

describe('access to the workspace', () => {
  it('is closed to anonymous callers and to the front desk — every route', async () => {
    const v = await visit({});
    const fd = await frontDeskLogin();
    for (const [m, u] of [['get', URL.ws(v.booking.id)], ['put', URL.draft(v.booking.id)], ['post', URL.sign(v.booking.id)], ['post', URL.start(v.booking.id)]] as const) {
      expect((await (request(app) as any)[m](u).send({})).status, `anon ${m} ${u}`).toBe(401);
      const r = await (fd.agent as any)[m](u).set('x-csrf-token', fd.csrf).send({});
      expect(r.status, `fd ${m} ${u}`).toBe(403);
    }
  });

  it('lets an administrator READ but not write: the workspace loads, every write is refused as read-only', async () => {
    const p = await providerLogin('PROVIDER_CHIRO');
    const v = await visit({ staffId: p.staff.id });
    await saveSoap(p, v.booking.id);
    const admin = await adminLogin();
    const ws = await admin.agent.get(URL.ws(v.booking.id));
    expect(ws.status).toBe(200);
    expect(ws.body.access).toMatchObject({ canWrite: false, role: null });
    expect(ws.body.draft.subjective).toBe(SOAP.subjective);
    for (const [fn, r] of [
      ['draft', await put(admin, URL.draft(v.booking.id), { subjective: 'x' })],
      ['sign', await post(admin, URL.sign(v.booking.id), { version: 1 })],
      ['start', await post(admin, URL.start(v.booking.id))],
      ['consent', await post(admin, URL.consent(v.booking.id), { consented: true })],
    ] as const) {
      expect(r.status, fn).toBe(403);
      expect(r.body.code, fn).toBe('read_only');
    }
  });

  it('lets an administrator who also holds a provider role write — as that role', async () => {
    const p = await providerLogin('PROVIDER_CHIRO', ['ADMIN']);
    const v = await visit({ staffId: p.staff.id });
    const version = await saveSoap(p, v.booking.id);
    const r = await post(p, URL.sign(v.booking.id), { version });
    expect(r.status).toBe(201);
    expect(r.body.signed.role).toBe('PROVIDER_CHIRO');
    expect((await notesOf(v.booking.id)).every((n) => n.authorRole === 'PROVIDER_CHIRO')).toBe(true);
  });

  it('lets any provider READ a visit but only the booked role write it', async () => {
    const owner = await providerLogin('PROVIDER_CHIRO');
    const other = await providerLogin('PROVIDER_NP');
    const v = await visit({ staffId: owner.staff.id });
    await saveSoap(owner, v.booking.id);

    const ws = (await other.agent.get(URL.ws(v.booking.id))).body;
    expect(ws.access.canWrite).toBe(false);
    expect(ws.access.readOnlyReason).toMatch(/different provider role/);
    for (const r of [await put(other, URL.draft(v.booking.id), { subjective: 'x' }), await post(other, URL.sign(v.booking.id), { version: 1 }), await post(other, URL.start(v.booking.id))]) {
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('wrong_role');
    }
    expect((await prisma.documentationDraft.findUniqueOrThrow({ where: { bookingId: v.booking.id } })).subjective).toBe(SOAP.subjective);
  });

  it('lets any provider role document a visit with no provider assigned', async () => {
    for (const role of ['PROVIDER_CHIRO', 'PROVIDER_NP', 'PROVIDER_NURSE'] as const) {
      const p = await providerLogin(role);
      const v = await visit({ staffRole: null });
      expect((await put(p, URL.draft(v.booking.id), SOAP)).status, role).toBe(200);
    }
  });

  it('refuses a provider account that is not linked to an active provider record', async () => {
    const unlinked = await makeAccount({ roles: ['PROVIDER_CHIRO'] });
    const s = await signInFully(unlinked.email);
    const v = await visit({});
    const r = await put(s, URL.draft(v.booking.id), SOAP);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('no_provider_identity');

    const p = await providerLogin('PROVIDER_CHIRO');
    await prisma.staff.update({ where: { id: p.staff.id }, data: { active: false } });
    expect((await put(p, URL.draft(v.booking.id), SOAP)).body.code).toBe('no_provider_identity');
  });

  it('takes the provider role from what the account holds: naming one it does not hold is refused', async () => {
    const p = await providerLogin('PROVIDER_CHIRO');
    const v = await visit({});
    const r = await put(p, URL.draft(v.booking.id), { ...SOAP, role: 'PROVIDER_NP' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('role_required');
  });
});

describe('MFA gates the workspace', () => {
  it('asks a provider with no authenticator to enrol, and refuses every clinical route until they have — even if the sign-in policy were switched off', async () => {
    const saved = [...config.mfaRequiredRoles];
    config.mfaRequiredRoles.length = 0;                       // a misconfigured deployment: nobody is forced to enrol at sign-in
    try {
      const staff = await prisma.staff.create({ data: { name: 'No Authenticator', role: 'CHIROPRACTOR' } });
      const acct = await makeAccount({ roles: ['PROVIDER_CHIRO'], staffId: staff.id });
      const s = await signIn(acct.email);
      expect(s.state.needs).toEqual([]);                      // sign-in lets them straight in…
      const v = await visit({});
      for (const [label, r] of [
        ['queue', await s.agent.get(URL.queue())],
        ['workspace', await s.agent.get(URL.ws(v.booking.id))],
        ['draft', await put(s, URL.draft(v.booking.id), SOAP)],
        ['sign', await post(s, URL.sign(v.booking.id), { version: 1 })],
        ['macros', await s.agent.get('/api/provider/macros')],
      ] as const) {
        expect(r.status, label).toBe(403);                    // …but the clinical routes do not
        expect(r.body, label).toMatchObject({ code: 'mfa_enrollment_required', needs: ['mfa_enroll'] });
      }
      expect(await prisma.documentationDraft.count({ where: { bookingId: v.booking.id } })).toBe(0);
      expect((await auditRows({ action: 'ACCESS_DENIED', actorAccountId: acct.id })).length).toBeGreaterThanOrEqual(5);

      // Once they enrol, the same session can open it.
      const { currentTotp } = await import('../src/lib/totp.js');
      const start = await post(s, '/api/auth/mfa/enroll/start');
      expect(start.status).toBe(200);
      const conf = await post(s, '/api/auth/mfa/enroll/confirm', { code: currentTotp(start.body.secret) });
      expect(conf.status).toBe(200);
      expect((await s.agent.get(URL.ws(v.booking.id))).status).toBe(200);
    } finally {
      config.mfaRequiredRoles.push(...saved);
    }
  });

  it('refuses an enrolled provider who has not used the authenticator in this session', async () => {
    // Policy and the gate agree: an enrolled account that has not verified is held at "step up".
    const p = await providerLogin('PROVIDER_CHIRO');
    const fresh = await signIn(p.email);
    expect(fresh.state.needs).toEqual(['mfa_verify']);
    expect((await fresh.agent.get(URL.queue())).status).toBe(403);
    expect((await fresh.agent.get(URL.queue())).body.code).toBe('step_up_required');
  });

  it('checks the authenticator itself, whatever the sign-in step said (middleware unit)', () => {
    const run = (account: object, session: object) => {
      let status = 0; let body: any; let nexted = false;
      const res: any = { status(c: number) { status = c; return this; }, json(b: unknown) { body = b; return this; } };
      requireMfa({ auth: { account, session }, method: 'GET', originalUrl: '/x' } as any, res, () => { nexted = true; });
      return { status, body, nexted };
    };
    expect(run({ mfaEnabledAt: null }, { mfaVerifiedAt: null })).toMatchObject({ status: 403, body: { code: 'mfa_enrollment_required' } });
    expect(run({ mfaEnabledAt: new Date() }, { mfaVerifiedAt: null })).toMatchObject({ status: 403, body: { code: 'mfa_verification_required' } });
    expect(run({ mfaEnabledAt: new Date() }, { mfaVerifiedAt: new Date() })).toMatchObject({ nexted: true });
  });
});

describe('the working draft', () => {
  it('is created by the first save, then needs the version it read; a stale save is refused and changes nothing', async () => {
    const p = await providerLogin('PROVIDER_CHIRO');
    const v = await visit({ staffId: p.staff.id });
    const first = await put(p, URL.draft(v.booking.id), { subjective: 'one' });
    expect(first.status).toBe(200);
    expect(first.body.version).toBe(1);

    const second = await put(p, URL.draft(v.booking.id), { version: 1, objective: 'two' });
    expect(second.body.version).toBe(2);

    const stale = await put(p, URL.draft(v.booking.id), { version: 1, plan: 'from another tab' });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'stale_draft', currentVersion: 2 });
    const row = await prisma.documentationDraft.findUniqueOrThrow({ where: { bookingId: v.booking.id } });
    expect(row).toMatchObject({ subjective: 'one', objective: 'two', plan: '', version: 2 });

    const missing = await put(p, URL.draft(v.booking.id), { objective: 'no version sent' });
    expect(missing.body.code).toBe('stale_draft');
  });

  it('saves only the fields it is sent, leaving the rest as they were', async () => {
    const p = await providerLogin('PROVIDER_CHIRO');
    const v = await visit({ staffId: p.staff.id });
    const v1 = await saveSoap(p, v.booking.id);
    await put(p, URL.draft(v.booking.id), { version: v1, assessment: 'changed' });
    expect(await prisma.documentationDraft.findUniqueOrThrow({ where: { bookingId: v.booking.id } })).toMatchObject({ subjective: SOAP.subjective, assessment: 'changed', plan: SOAP.plan });
  });

  it('is shaped by the service: a SOAP service takes four sections, a session log takes a duration and notes', async () => {
    const p = await providerLogin('PROVIDER_CHIRO');
    const soap = await visit({ staffId: p.staff.id, doc: 'SOAP' });
    const log = await visit({ staffId: p.staff.id, doc: 'SESSION_LOG' });
    for (const bad of [{ notes: 'x' }, { durationMin: 20 }]) {
      const r = await put(p, URL.draft(soap.booking.id), bad);
      expect([r.status, r.body.code], JSON.stringify(bad)).toEqual([400, 'wrong_fields']);
    }
    for (const bad of [{ subjective: 'x' }, { plan: 'x' }]) {
      const r = await put(p, URL.draft(log.booking.id), bad);
      expect([r.status, r.body.code], JSON.stringify(bad)).toEqual([400, 'wrong_fields']);
    }
    expect((await put(p, URL.draft(log.booking.id), { notes: 'Tolerated well.', durationMin: 20 })).status).toBe(200);
  });

  it('validates what it is sent: unknown fields, oversize text, a duration out of range', async () => {
    const p = await providerLogin('PROVIDER_CHIRO');
    const soap = await visit({ staffId: p.staff.id, doc: 'SOAP' });
    const log = await visit({ staffId: p.staff.id, doc: 'SESSION_LOG' });
    expect((await put(p, URL.draft(soap.booking.id), { subjective: 'x'.repeat(20001) })).status).toBe(400);
    expect((await put(p, URL.draft(soap.booking.id), { subjective: 'ok', extra: 1 })).status).toBe(400);
    for (const d of [0, -5, 1441, 12.5, '20']) expect((await put(p, URL.draft(log.booking.id), { durationMin: d })).status, String(d)).toBe(400);
    expect((await put(p, URL.draft(soap.booking.id), { subjective: 'x'.repeat(20000) })).status).toBe(200);
  });

  it('can only be written for a patient who has been checked in, on a confirmed appointment', async () => {
    const p = await providerLogin('PROVIDER_CHIRO');
    for (const encounter of ['SCHEDULED', 'NO_SHOW', null] as const) {
      const v = await visit({ staffId: p.staff.id, encounter });
      const r = await put(p, URL.draft(v.booking.id), SOAP);
      expect([r.status, r.body.code], String(encounter)).toEqual([409, 'not_checked_in']);
    }
    const pending = await visit({ staffId: p.staff.id, bookingStatus: 'PENDING_REVIEW' });
    expect((await put(p, URL.draft(pending.booking.id), SOAP)).body.code).toBe('not_confirmed');
    expect((await put(p, URL.draft('no-such-booking'), SOAP)).status).toBe(404);
    for (const encounter of ['CHECKED_IN', 'IN_PROGRESS', 'SEEN', 'CHECKED_OUT'] as const) {
      const v = await visit({ staffId: p.staff.id, encounter });
      expect((await put(p, URL.draft(v.booking.id), SOAP)).status, encounter).toBe(200);
    }
  });

  it('moves the visit to IN_PROGRESS on first work, recording who started it — and the start call is idempotent', async () => {
    const p = await providerLogin('PROVIDER_CHIRO');
    const a = await visit({ staffId: p.staff.id });
    expect((await put(p, URL.draft(a.booking.id), SOAP)).status).toBe(200);
    expect(await prisma.encounter.findUniqueOrThrow({ where: { bookingId: a.booking.id } })).toMatchObject({ status: 'IN_PROGRESS', startedById: p.accountId });
    expect((await prisma.encounter.findUniqueOrThrow({ where: { bookingId: a.booking.id } })).startedAt).not.toBeNull();

    const b = await visit({ staffId: p.staff.id });
    const first = await post(p, URL.start(b.booking.id));
    const startedAt = (await prisma.encounter.findUniqueOrThrow({ where: { bookingId: b.booking.id } })).startedAt;
    const again = await post(p, URL.start(b.booking.id));
    expect([first.body.status, again.body.status]).toEqual(['IN_PROGRESS', 'IN_PROGRESS']);
    expect((await prisma.encounter.findUniqueOrThrow({ where: { bookingId: b.booking.id } })).startedAt).toEqual(startedAt);   // not restarted

    const done = await visit({ staffId: p.staff.id, encounter: 'SEEN' });
    expect((await post(p, URL.start(done.booking.id))).body.status).toBe('SEEN');                                              // never moved backwards
  });

  it('audits every save with the field NAMES touched and never the text', async () => {
    const p = await providerLogin('PROVIDER_CHIRO');
    const v = await visit({ staffId: p.staff.id });
    const v1 = await saveSoap(p, v.booking.id, { subjective: 'SECRET-PHRASE-AAA' });
    await put(p, URL.draft(v.booking.id), { version: v1, plan: 'SECRET-PHRASE-BBB' });
    const rows = await auditRows({ resourceType: 'clinical_draft', actorAccountId: p.accountId }, 2);
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(['CREATE', 'UPDATE']));
    expect(blob(rows)).toContain('subjective');
    expect(blob(rows)).not.toContain('SECRET-PHRASE');
  });
});

describe('signing a SOAP note', () => {
  it('turns the draft into four attributed notes, a signature, a SEEN visit — and removes the draft', async () => {
    const p = await providerLogin('PROVIDER_NP');
    const v = await visit({ staffId: p.staff.id, staffRole: 'NURSE_PRACTITIONER' });
    const version = await saveSoap(p, v.booking.id);

    const r = await post(p, URL.sign(v.booking.id), { version });
    expect(r.status).toBe(201);
    expect(r.body.signed).toMatchObject({ role: 'PROVIDER_NP', aiAssisted: false, aiDraftUnchanged: null });

    const notes = await notesOf(v.booking.id);
    expect(notes.map((n) => n.kind)).toEqual(['SUBJECTIVE', 'OBJECTIVE', 'ASSESSMENT', 'PLAN']);
    expect(notes.map((n) => n.body)).toEqual([SOAP.subjective, SOAP.objective, SOAP.assessment, SOAP.plan]);
    // Strictly increasing creation times, so the order survives an amendment of any section.
    expect(notes.map((n) => n.createdAt.getTime())).toEqual([0, 1, 2, 3].map((i) => TUESDAY_1007.getTime() + i));
    for (const n of notes) {
      expect(n).toMatchObject({ authorId: p.staff.id, authorAccountId: p.accountId, authorRole: 'PROVIDER_NP', amendsId: null, durationMin: null });
    }

    const sig = await prisma.noteSignature.findUniqueOrThrow({ where: { bookingId: v.booking.id } });
    expect(sig).toMatchObject({ type: 'SOAP', signedByAccountId: p.accountId, signedByStaffId: p.staff.id, signedRole: 'PROVIDER_NP', aiAssisted: false });
    expect(sig.noteIds).toEqual(notes.map((n) => n.id));
    expect(sig.signedAt).toEqual(TUESDAY_1007);

    expect(await prisma.documentationDraft.count({ where: { bookingId: v.booking.id } })).toBe(0);
    expect(await prisma.encounter.findUniqueOrThrow({ where: { bookingId: v.booking.id } })).toMatchObject({ status: 'SEEN', seenAt: TUESDAY_1007 });
  });

  it('records the provider role USED when one person holds several hats', async () => {
    const p = await providerLogin('PROVIDER_NURSE', ['ADMIN', 'FRONT_DESK']);
    const v = await visit({ staffId: p.staff.id, staffRole: 'REGISTERED_NURSE' });
    const version = await saveSoap(p, v.booking.id);
    expect((await post(p, URL.sign(v.booking.id), { version, role: 'PROVIDER_NURSE' })).status).toBe(201);
    expect((await prisma.noteSignature.findUniqueOrThrow({ where: { bookingId: v.booking.id } })).signedRole).toBe('PROVIDER_NURSE');
  });

  it('refuses an incomplete note, naming the missing sections, and signs nothing', async () => {
    const p = await providerLogin('PROVIDER_CHIRO');
    const v = await visit({ staffId: p.staff.id });
    const version = await saveSoap(p, v.booking.id, { objective: '   ', plan: '' });
    const r = await post(p, URL.sign(v.booking.id), { version });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'incomplete', missing: ['objective', 'plan'] });
    expect(await notesOf(v.booking.id)).toHaveLength(0);
    expect(await prisma.noteSignature.count({ where: { bookingId: v.booking.id } })).toBe(0);
    expect(await prisma.documentationDraft.count({ where: { bookingId: v.booking.id } })).toBe(1);
  });

  it('refuses when there is no draft, and when the draft changed since the provider read it', async () => {
    const p = await providerLogin('PROVIDER_CHIRO');
    const v = await visit({ staffId: p.staff.id });
    expect((await post(p, URL.sign(v.booking.id), { version: 1 })).body.code).toBe('no_draft');
    const version = await saveSoap(p, v.booking.id);
    await put(p, URL.draft(v.booking.id), { version, plan: 'edited elsewhere' });
    const stale = await post(p, URL.sign(v.booking.id), { version });
    expect([stale.status, stale.body.code, stale.body.currentVersion]).toEqual([409, 'stale_draft', 2]);
    expect(await notesOf(v.booking.id)).toHaveLength(0);
  });

  it('validates the request', async () => {
    const p = await providerLogin('PROVIDER_CHIRO');
    const v = await visit({});
    for (const bad of [{}, { version: 0 }, { version: '1' }, { version: 1, extra: true }, { version: 1, reviewedAiDraft: 'yes' }]) {
      expect((await post(p, URL.sign(v.booking.id), bad)).status, JSON.stringify(bad)).toBe(400);
    }
  });

  it('can be done once: a second sign, and any later draft save, are refused', async () => {
    const p = await providerLogin('PROVIDER_CHIRO');
    const v = await visit({ staffId: p.staff.id });
    const version = await saveSoap(p, v.booking.id);
    expect((await post(p, URL.sign(v.booking.id), { version })).status).toBe(201);
    expect((await post(p, URL.sign(v.booking.id), { version })).body.code).toBe('already_signed');
    expect((await put(p, URL.draft(v.booking.id), { version, plan: 'late edit' })).body.code).toBe('already_signed');
    expect(await notesOf(v.booking.id)).toHaveLength(4);
  });

  it('works for a visit the patient has already been checked out of (late documentation)', async () => {
    const p = await providerLogin('PROVIDER_CHIRO');
    const v = await visit({ staffId: p.staff.id, encounter: 'CHECKED_OUT' });
    const version = await saveSoap(p, v.booking.id);
    expect((await post(p, URL.sign(v.booking.id), { version })).status).toBe(201);
    expect((await prisma.encounter.findUniqueOrThrow({ where: { bookingId: v.booking.id } })).status).toBe('CHECKED_OUT');   // not pulled back to SEEN
  });

  it('refuses to sign text left over from the demonstration scribe', async () => {
    const p = await providerLogin('PROVIDER_CHIRO');
    const v = await visit({ staffId: p.staff.id });
    const version = await saveSoap(p, v.booking.id, { assessment: '[DEMO DRAFT] Low back stiffness.' });
    const r = await post(p, URL.sign(v.booking.id), { version });
    expect([r.status, r.body.code]).toEqual([409, 'demo_text_present']);
    expect(await notesOf(v.booking.id)).toHaveLength(0);
  });

  it('audits each record it creates and the draft it removes, without the text', async () => {
    const p = await providerLogin('PROVIDER_CHIRO');
    const v = await visit({ staffId: p.staff.id });
    const version = await saveSoap(p, v.booking.id, { subjective: 'SIGNED-SECRET-QQQ' });
    await post(p, URL.sign(v.booking.id), { version });
    const notes = await notesOf(v.booking.id);
    const created = await auditRows({ resourceType: 'visit_note', action: 'CREATE', actorAccountId: p.accountId }, 4);
    for (const n of notes) expect(created.map((r) => r.resourceId)).toContain(n.id);
    const sig = await prisma.noteSignature.findUniqueOrThrow({ where: { bookingId: v.booking.id } });
    expect((await auditRows({ resourceType: 'note_signature', resourceId: sig.id }))[0]).toMatchObject({ action: 'CREATE', actorAccountId: p.accountId });
    expect((await auditRows({ resourceType: 'clinical_draft', action: 'DELETE', actorAccountId: p.accountId })).length).toBeGreaterThan(0);
    expect(blob(await prisma.auditLog.findMany({ where: { actorAccountId: p.accountId } }))).not.toContain('SIGNED-SECRET-QQQ');
  });
});

describe('signing a session log', () => {
  it('needs the duration and the notes, and records both as one note carrying the duration', async () => {
    const p = await providerLogin('PROVIDER_NURSE');
    const v = await visit({ staffId: p.staff.id, doc: 'SESSION_LOG', staffRole: 'REGISTERED_NURSE' });
    const a = await put(p, URL.draft(v.booking.id), { notes: 'Session tolerated well.' });
    const noDuration = await post(p, URL.sign(v.booking.id), { version: a.body.version });
    expect([noDuration.status, noDuration.body.code, noDuration.body.missing]).toEqual([409, 'incomplete', ['durationMin']]);
    const b = await put(p, URL.draft(v.booking.id), { version: a.body.version, durationMin: 25, notes: '  ' });
    expect((await post(p, URL.sign(v.booking.id), { version: b.body.version })).body.missing).toEqual(['notes']);
    const c = await put(p, URL.draft(v.booking.id), { version: b.body.version, notes: 'Session tolerated well.' });

    expect((await post(p, URL.sign(v.booking.id), { version: c.body.version })).status).toBe(201);
    const notes = await notesOf(v.booking.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: 'GENERAL', body: 'Session tolerated well.', durationMin: 25, authorId: p.staff.id, authorRole: 'PROVIDER_NURSE' });
    expect(await prisma.noteSignature.findUniqueOrThrow({ where: { bookingId: v.booking.id } })).toMatchObject({ type: 'SESSION_LOG', signedRole: 'PROVIDER_NURSE' });
  });
});

describe('amending after signing (the existing model, unchanged)', () => {
  async function signed(doc: 'SOAP' | 'SESSION_LOG' = 'SOAP') {
    const p = await providerLogin('PROVIDER_CHIRO');
    const v = await visit({ staffId: p.staff.id, doc });
    if (doc === 'SOAP') {
      await post(p, URL.sign(v.booking.id), { version: await saveSoap(p, v.booking.id) });
    } else {
      const d = await put(p, URL.draft(v.booking.id), { notes: 'Original log.', durationMin: 30 });
      await post(p, URL.sign(v.booking.id), { version: d.body.version });
    }
    return { p, v, notes: await notesOf(v.booking.id) };
  }

  it('is a new row pointing at the one it replaces; the signed original is untouched and still what the signature names', async () => {
    const { p, v, notes } = await signed();
    const subjective = notes[0]!;
    const r = await post(p, `/api/visit-notes/${subjective.id}/amend`, { body: 'Corrected subjective.', amendReason: 'Typo' });
    expect(r.status).toBe(201);

    const after = await notesOf(v.booking.id);
    expect(after).toHaveLength(5);
    expect(after.find((n) => n.id === subjective.id)).toMatchObject({ body: SOAP.subjective, amendsId: null });
    expect(after.find((n) => n.id === r.body.id)).toMatchObject({ body: 'Corrected subjective.', amendsId: subjective.id, amendReason: 'Typo', authorAccountId: p.accountId, authorRole: 'PROVIDER_CHIRO' });
    expect((await prisma.noteSignature.findUniqueOrThrow({ where: { bookingId: v.booking.id } })).noteIds).toContain(subjective.id);

    // Amending the FIRST section must not move it: notes keep their place in the record.
    await post(p, `/api/visit-notes/${notes[3]!.id}/amend`, { body: 'Corrected plan.', amendReason: 'Wording' });
    const ws = (await p.agent.get(URL.ws(v.booking.id))).body;
    expect(ws.notes.map((n: any) => n.kind)).toEqual(['SUBJECTIVE', 'OBJECTIVE', 'ASSESSMENT', 'PLAN']);
    expect(ws.signature.amended).toBe(true);
    const current = ws.notes.find((n: any) => n.kind === 'SUBJECTIVE');
    expect(current).toMatchObject({ body: 'Corrected subjective.', amended: true });
    expect(current.history).toHaveLength(1);
    expect(current.history[0]).toMatchObject({ body: SOAP.subjective, amendReason: 'Typo' });   // the reason is shown against the version it replaced
  });

  it('keeps the existing rules: a reason is required, and only the current version can be amended', async () => {
    const { p, notes } = await signed();
    const n = notes[1]!;
    expect((await post(p, `/api/visit-notes/${n.id}/amend`, { body: 'x' })).status).toBe(400);
    expect((await post(p, `/api/visit-notes/${n.id}/amend`, { body: 'x', amendReason: '' })).status).toBe(400);
    expect((await post(p, `/api/visit-notes/${n.id}/amend`, { body: 'one', amendReason: 'r' })).status).toBe(201);
    expect((await post(p, `/api/visit-notes/${n.id}/amend`, { body: 'two', amendReason: 'r' })).status).toBe(409);
  });

  it('is available to providers only: the front desk and an administrator cannot amend', async () => {
    const { notes } = await signed();
    for (const s of [await frontDeskLogin(), await adminLogin()]) {
      expect((await post(s, `/api/visit-notes/${notes[0]!.id}/amend`, { body: 'x', amendReason: 'y' })).status).toBe(403);
    }
  });

  it('carries a session log\'s duration through an amendment, or corrects it — the old figure staying in the chain', async () => {
    const { p, v, notes } = await signed('SESSION_LOG');
    const orig = notes[0]!;
    expect(orig.durationMin).toBe(30);

    const keep = await post(p, `/api/visit-notes/${orig.id}/amend`, { body: 'Original log, reworded.', amendReason: 'Wording' });
    expect(keep.body.durationMin).toBe(30);
    const fix = await post(p, `/api/visit-notes/${keep.body.id}/amend`, { body: 'Original log, reworded.', amendReason: 'Wrong duration', durationMin: 45 });
    expect(fix.body.durationMin).toBe(45);

    const ws = (await p.agent.get(URL.ws(v.booking.id))).body;
    expect(ws.notes).toHaveLength(1);
    expect(ws.notes[0]).toMatchObject({ durationMin: 45 });
    expect(ws.notes[0].history.map((h: any) => h.durationMin)).toEqual([30, 30]);
    expect((await prisma.visitNote.findUniqueOrThrow({ where: { id: orig.id } })).durationMin).toBe(30);
    expect((await post(p, `/api/visit-notes/${fix.body.id}/amend`, { body: 'x', amendReason: 'y', durationMin: 0 })).status).toBe(400);
  });
});

describe('a signed record cannot be rewritten at the database', () => {
  it('rejects UPDATE, DELETE and TRUNCATE on VisitNote and NoteSignature', async () => {
    const p = await providerLogin('PROVIDER_CHIRO');
    const v = await visit({ staffId: p.staff.id });
    await post(p, URL.sign(v.booking.id), { version: await saveSoap(p, v.booking.id) });
    const n = (await notesOf(v.booking.id))[0]!;
    await expect(exec(`UPDATE "VisitNote" SET "body" = 'rewritten' WHERE "id" = '${n.id}'`)).rejects.toThrow(/append-only/);
    await expect(exec(`DELETE FROM "VisitNote" WHERE "id" = '${n.id}'`)).rejects.toThrow(/append-only/);
    await expect(exec('TRUNCATE "VisitNote" CASCADE')).rejects.toThrow(/append-only/);
    await expect(exec(`UPDATE "NoteSignature" SET "signedRole" = 'provider_np' WHERE "bookingId" = '${v.booking.id}'`)).rejects.toThrow(/append-only/);
    await expect(exec(`DELETE FROM "NoteSignature" WHERE "bookingId" = '${v.booking.id}'`)).rejects.toThrow(/append-only/);
    await expect(exec('TRUNCATE "NoteSignature"')).rejects.toThrow(/append-only/);
    expect((await notesOf(v.booking.id))[0]!.body).toBe(SOAP.subjective);
  });

  it('refuses a self-contradictory signature or duration', async () => {
    const p = await providerLogin('PROVIDER_CHIRO');
    const v = await visit({});
    const base = { bookingId: v.booking.id, type: 'SOAP' as const, signedAt: new Date(), signedByAccountId: p.accountId, signedByStaffId: p.staff.id };
    for (const bad of [
      { noteIds: ['a'], signedRole: 'admin' as const },                                      // not a provider role
      { noteIds: [], signedRole: 'provider_chiro' as const },                                 // signs nothing
      { noteIds: ['a'], signedRole: 'provider_chiro' as const, aiAssisted: false, aiDraftUnchanged: true },   // AI facts without AI
    ]) {
      await expect(basePrisma.noteSignature.create({ data: { ...base, ...bad } as never }), JSON.stringify(bad)).rejects.toThrow();
    }
    await expect(basePrisma.visitNote.create({ data: { bookingId: v.booking.id, authorId: p.staff.id, kind: 'SUBJECTIVE', body: 'x', durationMin: 10 } })).rejects.toThrow();   // a duration belongs to a GENERAL note
    await expect(basePrisma.visitNote.create({ data: { bookingId: v.booking.id, authorId: p.staff.id, kind: 'GENERAL', body: 'x', durationMin: 0 } })).rejects.toThrow();
  });
});

describe('races', () => {
  it('signing twice at once signs once: one 201, one 409, four notes, one signature', async () => {
    const p = await providerLogin('PROVIDER_CHIRO');
    const v = await visit({ staffId: p.staff.id });
    const version = await saveSoap(p, v.booking.id);
    const results = await Promise.all([post(p, URL.sign(v.booking.id), { version }), post(p, URL.sign(v.booking.id), { version }), post(p, URL.sign(v.booking.id), { version })]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect(await notesOf(v.booking.id)).toHaveLength(4);
    expect(await prisma.noteSignature.count({ where: { bookingId: v.booking.id } })).toBe(1);
    expect(await prisma.documentationDraft.count({ where: { bookingId: v.booking.id } })).toBe(0);
  });

  it('saving while signing never leaves a stray draft or an unsigned edit in a signed note: what is signed is what was saved', async () => {
    for (let i = 0; i < 4; i++) {
      const p = await providerLogin('PROVIDER_CHIRO');
      const v = await visit({ staffId: p.staff.id });
      const version = await saveSoap(p, v.booking.id);
      const [save, sign] = await Promise.all([put(p, URL.draft(v.booking.id), { version, plan: 'RACED EDIT' }), post(p, URL.sign(v.booking.id), { version })]);
      const notes = await notesOf(v.booking.id);
      const drafts = await prisma.documentationDraft.count({ where: { bookingId: v.booking.id } });
      if (sign.status === 201) {
        expect(drafts, 'a signed visit keeps no draft').toBe(0);
        expect(notes).toHaveLength(4);
        const plan = notes.find((n) => n.kind === 'PLAN')!.body;
        expect(plan === SOAP.plan || plan === 'RACED EDIT').toBe(true);
        if (save.status !== 200) expect(plan).toBe(SOAP.plan);                              // an edit that was refused is not in the record
      } else {
        expect(sign.status).toBe(409);                                                      // the save went first, so the version the provider read is stale
        expect(save.status).toBe(200);
        expect(notes).toHaveLength(0);
        expect(drafts).toBe(1);
      }
    }
  });

  it('two tabs saving the same version: exactly one wins', async () => {
    const p = await providerLogin('PROVIDER_CHIRO');
    const v = await visit({ staffId: p.staff.id });
    const version = await saveSoap(p, v.booking.id);
    const rs = await Promise.all([1, 2, 3, 4].map((i) => put(p, URL.draft(v.booking.id), { version, plan: `tab ${i}` })));
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409, 409, 409]);
    expect((await prisma.documentationDraft.findUniqueOrThrow({ where: { bookingId: v.booking.id } })).version).toBe(version + 1);
  });
});

describe('the workspace read', () => {
  it('describes the visit, what the patient wrote when booking, the draft, and what the scribe can do', async () => {
    const p = await providerLogin('PROVIDER_CHIRO');
    const patient = await makePatient({ firstName: 'Ingrid', lastName: 'Holloway' });
    const v = await visit({ patientId: patient.id, patientNote: 'Knee surgery in March', staffId: p.staff.id });
    await saveSoap(p, v.booking.id);
    const ws = (await p.agent.get(URL.ws(v.booking.id))).body;
    expect(ws.booking).toMatchObject({ id: v.booking.id, patientNote: 'Knee surgery in March', patient: { id: patient.id, name: 'Ingrid Holloway' }, provider: { id: p.staff.id }, service: { documentationType: 'SOAP' } });
    expect(ws.access).toEqual({ canWrite: true, role: 'PROVIDER_CHIRO', signsAs: p.staff.name, readOnlyReason: null, canAddend: true, canConfirmCovering: false });
    expect(ws.encounter.status).toBe('IN_PROGRESS');
    expect(ws.documentation).toEqual({ status: 'DRAFT', type: 'SOAP' });
    expect(ws.draft).toMatchObject({ version: 1, subjective: SOAP.subjective, aiDrafted: false });
    expect(ws.signature).toBeNull();
    expect(ws.notes).toEqual([]);
    expect(ws.scribe).toMatchObject({ applicable: true, consentAt: null, sessions: [] });
  });

  it('shows a signed visit: the notes, who signed, in what role, and no draft', async () => {
    const p = await providerLogin('PROVIDER_CHIRO');
    const v = await visit({ staffId: p.staff.id });
    await post(p, URL.sign(v.booking.id), { version: await saveSoap(p, v.booking.id) });
    const ws = (await p.agent.get(URL.ws(v.booking.id))).body;
    expect(ws.documentation.status).toBe('SIGNED');
    expect(ws.draft).toBeNull();
    expect(ws.signature).toMatchObject({ signedBy: p.staff.name, signedRole: 'PROVIDER_CHIRO', aiAssisted: false, amended: false });
    expect(ws.notes.map((n: any) => n.kind)).toEqual(['SUBJECTIVE', 'OBJECTIVE', 'ASSESSMENT', 'PLAN']);
  });

  it('says a session-log service has no scribe, and 404s an unknown visit', async () => {
    const p = await providerLogin('PROVIDER_CHIRO');
    const log = await visit({ doc: 'SESSION_LOG' });
    expect((await p.agent.get(URL.ws(log.booking.id))).body.scribe.applicable).toBe(false);
    expect((await p.agent.get(URL.ws('nope'))).status).toBe(404);
  });

  it('audits the read — the visit, its draft and its notes — and the patient history read of note text', async () => {
    const p = await providerLogin('PROVIDER_CHIRO');
    const v = await visit({ staffId: p.staff.id });
    const signedV = await visit({ staffId: p.staff.id });
    await saveSoap(p, v.booking.id);
    await post(p, URL.sign(signedV.booking.id), { version: await saveSoap(p, signedV.booking.id) });
    await p.agent.get(URL.ws(v.booking.id));
    await p.agent.get(URL.ws(signedV.booking.id));
    const read = (type: string, id: string) => auditRows({ action: 'READ', resourceType: type, resourceId: id, actorAccountId: p.accountId });
    expect((await read('encounter', v.booking.id)).length).toBe(1);
    expect((await read('clinical_draft', v.booking.id)).length).toBe(1);
    expect((await read('visit_note', signedV.booking.id)).length).toBe(1);

    // The older patient-history route returns the same text, so it is audited as a read of notes too.
    const hist = await p.agent.get(`/api/patients/${signedV.user.id}/history`);
    expect(hist.status).toBe(200);
    expect((await auditRows({ action: 'READ', resourceType: 'visit_note', resourceId: signedV.user.id, actorAccountId: p.accountId })).length).toBe(1);
    const fd = await frontDeskLogin();
    await fd.agent.get(`/api/patients/${signedV.user.id}/history`);
    expect(await prisma.auditLog.count({ where: { action: 'READ', resourceType: 'visit_note', resourceId: signedV.user.id, actorAccountId: fd.state.account.id } })).toBe(0);   // front desk gets no note text, so no note read
  });
});

describe('what the front desk sees as a visit is documented', () => {
  it('moves from nothing, to a draft, to signed — the status only', async () => {
    const fd = await frontDeskLogin();
    const p = await providerLogin('PROVIDER_CHIRO');
    const v = await visit({ staffId: p.staff.id });
    const status = async () => {
      const d = (await fd.agent.get('/api/fd/dashboard?date=2026-10-13')).body;
      return [...d.checkedIn, ...d.done].find((a: any) => a.id === v.booking.id).documentation.status;
    };
    expect(await status()).toBe('NONE');
    const version = await saveSoap(p, v.booking.id, { subjective: 'FRONT-DESK-MUST-NOT-SEE' });
    expect(await status()).toBe('DRAFT');
    await post(p, URL.sign(v.booking.id), { version });
    expect(await status()).toBe('SIGNED');
    expect(blob((await fd.agent.get('/api/fd/dashboard?date=2026-10-13')).body)).not.toContain('FRONT-DESK-MUST-NOT-SEE');
  });
});
