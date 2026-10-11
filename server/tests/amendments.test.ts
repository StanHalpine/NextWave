import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { config } from '../src/config.js';
import { withAddenda } from '../src/lib/addenda.js';
import { isSigner } from '../src/lib/notes.js';
import { prisma } from '../src/lib/prisma.js';
import { basePrisma } from '../src/lib/prismaBase.js';
import { setClockForTests } from '../src/lib/clock.js';
import { app, auditRows, blob, makeAccount, signIn } from './helpers.js';
import { TUESDAY_1007 } from './phase2.js';
import { adminLogin, frontDeskLogin, post, providerLogin, saveSoap, SOAP, URL, visit, type Provider } from './phase4.js';

beforeAll(() => setClockForTests(TUESDAY_1007));
afterAll(() => setClockForTests(null));

const AMEND = (id: string) => `/api/visit-notes/${id}/amend`;
const ADD = (id: string) => `/api/visit-notes/${id}/addendum`;
const notesOf = (bookingId: string) => basePrisma.visitNote.findMany({ where: { bookingId }, orderBy: { createdAt: 'asc' } });
const exec = (sql: string) => basePrisma.$executeRawUnsafe(sql);

/** A signed SOAP note by its own provider. */
async function signedBy(role: 'PROVIDER_CHIRO' | 'PROVIDER_NP' | 'PROVIDER_NURSE' = 'PROVIDER_CHIRO') {
  const signer = await providerLogin(role);
  const v = await visit({ staffId: signer.staff.id, doc: 'SOAP' });
  await post(signer, URL.sign(v.booking.id), { version: await saveSoap(signer, v.booking.id) });
  return { signer, v, id: v.booking.id, notes: await notesOf(v.booking.id) };
}

describe('only the provider who signed a note can amend it', () => {
  it('lets the signer amend — the existing model, unchanged: a new version pointing at the old', async () => {
    const { signer, notes, id } = await signedBy();
    const r = await post(signer, AMEND(notes[0]!.id), { body: 'Corrected.', amendReason: 'Typo' });
    expect(r.status).toBe(201);
    const after = await notesOf(id);
    expect(after).toHaveLength(5);
    expect(after.find((n) => n.id === notes[0]!.id)).toMatchObject({ body: SOAP.subjective, amendsId: null });
    expect(after.find((n) => n.id === r.body.id)).toMatchObject({ body: 'Corrected.', amendsId: notes[0]!.id, amendReason: 'Typo', authorAccountId: signer.accountId });
  });

  it('refuses every other provider — same role or not — writes nothing, says what to do instead, and audits the refusal', async () => {
    const { notes, id } = await signedBy('PROVIDER_CHIRO');
    for (const role of ['PROVIDER_CHIRO', 'PROVIDER_NP', 'PROVIDER_NURSE'] as const) {
      const other = await providerLogin(role);
      const r = await post(other, AMEND(notes[0]!.id), { body: 'Hijacked.', amendReason: 'Because' });
      expect([r.status, r.body.code, r.body.canAddend], role).toEqual([403, 'not_author', true]);
      expect(r.body.error, role).toMatch(/addendum/);
      expect((await auditRows({ action: 'ACCESS_DENIED', resourceType: 'visit_note', resourceId: notes[0]!.id, actorAccountId: other.accountId })).length, role).toBe(1);
    }
    expect(await notesOf(id)).toHaveLength(4);                                               // nothing was written
    expect((await notesOf(id))[0]!.body).toBe(SOAP.subjective);
  });

  it('refuses an administrator who also holds a provider role but did not sign it — and one who holds none', async () => {
    const { notes } = await signedBy();
    const dual = await providerLogin('PROVIDER_NP', ['ADMIN']);
    expect((await post(dual, AMEND(notes[0]!.id), { body: 'x', amendReason: 'y' })).body.code).toBe('not_author');
    const admin = await adminLogin();
    const r = await post(admin, AMEND(notes[0]!.id), { body: 'x', amendReason: 'y' });
    expect([r.status, r.body.code]).toEqual([403, 'read_only']);                            // no write path at all
  });

  it('refuses the front desk and the anonymous, and an unknown note is a 404 for a provider', async () => {
    const { signer, notes } = await signedBy();
    expect((await post(await frontDeskLogin(), AMEND(notes[0]!.id), { body: 'x', amendReason: 'y' })).status).toBe(403);
    expect((await request(app).post(AMEND(notes[0]!.id)).send({ body: 'x', amendReason: 'y' })).status).toBe(401);
    expect((await post(signer, AMEND('no-such-note'), { body: 'x', amendReason: 'y' })).status).toBe(404);
  });

  it('keeps ownership through a chain: only the signer can amend a later version, again and again', async () => {
    const { signer, notes } = await signedBy();
    const other = await providerLogin('PROVIDER_CHIRO');
    const v2 = await post(signer, AMEND(notes[1]!.id), { body: 'Second.', amendReason: 'One' });
    expect((await post(other, AMEND(v2.body.id), { body: 'No.', amendReason: 'Nope' })).body.code).toBe('not_author');
    const v3 = await post(signer, AMEND(v2.body.id), { body: 'Third.', amendReason: 'Two' });
    expect(v3.status).toBe(201);
    expect((await post(other, AMEND(v3.body.id), { body: 'No.', amendReason: 'Nope' })).status).toBe(403);
  });

  it('treats a note written before accounts existed by the provider record the login is linked to', async () => {
    const owner = await providerLogin('PROVIDER_CHIRO');
    const stranger = await providerLogin('PROVIDER_CHIRO');
    const v = await visit({ staffId: owner.staff.id });
    const legacy = await basePrisma.visitNote.create({ data: { bookingId: v.booking.id, authorId: owner.staff.id, kind: 'GENERAL', body: 'Old note.' } });
    expect((await post(stranger, AMEND(legacy.id), { body: 'x', amendReason: 'y' })).body.code).toBe('not_author');
    expect((await post(owner, AMEND(legacy.id), { body: 'Updated.', amendReason: 'y' })).status).toBe(201);
    expect(isSigner({ authorAccountId: null, authorId: 'S1' }, { id: 'A', staffId: 'S1' })).toBe(true);
    expect(isSigner({ authorAccountId: null, authorId: 'S1' }, { id: 'A', staffId: null })).toBe(false);
    expect(isSigner({ authorAccountId: 'A', authorId: 'S1' }, { id: 'B', staffId: 'S1' })).toBe(false);   // the account, not the shared provider record
  });

  it('still needs the authenticator, whatever the sign-in policy says', async () => {
    const { notes } = await signedBy();
    const saved = [...config.mfaRequiredRoles];
    config.mfaRequiredRoles.length = 0;
    try {
      const staff = await prisma.staff.create({ data: { name: 'No Authenticator', role: 'CHIROPRACTOR' } });
      const s = await signIn((await makeAccount({ roles: ['PROVIDER_CHIRO'], staffId: staff.id })).email);
      const r = await post(s as Provider, AMEND(notes[0]!.id), { body: 'x', amendReason: 'y' });
      expect([r.status, r.body.code]).toEqual([403, 'mfa_enrollment_required']);
      expect((await post(s as Provider, ADD(notes[0]!.id), { body: 'x' })).body.code).toBe('mfa_enrollment_required');
    } finally { config.mfaRequiredRoles.push(...saved); }
  });
});

describe('any other provider can add an addendum', () => {
  it('adds a new entry linked to the note, attributed to them and the role they used, and changes nothing else', async () => {
    const { signer, notes, id } = await signedBy('PROVIDER_CHIRO');
    const colleague = await providerLogin('PROVIDER_NP');
    const before = await notesOf(id);
    const r = await post(colleague, ADD(notes[2]!.id), { body: '  Reviewed with the patient; agree with the assessment.  ' });
    expect(r.status).toBe(201);

    const row = await basePrisma.noteAddendum.findUniqueOrThrow({ where: { id: r.body.addendum.id } });
    expect(row).toMatchObject({
      bookingId: id, noteId: notes[2]!.id, body: 'Reviewed with the patient; agree with the assessment.',
      authorAccountId: colleague.accountId, authorStaffId: colleague.staff.id, authorRole: 'PROVIDER_NP',
    });
    expect(row.createdAt).toEqual(TUESDAY_1007);
    expect(await notesOf(id)).toEqual(before);                                              // the original and its chain are untouched
    expect(await prisma.noteSignature.count({ where: { bookingId: id } })).toBe(1);

    // …and shows up under that note for everyone who may read it.
    const ws = (await signer.agent.get(URL.ws(id))).body;
    const assessment = ws.notes.find((n: any) => n.kind === 'ASSESSMENT');
    expect(assessment.addenda).toHaveLength(1);
    expect(assessment.addenda[0]).toMatchObject({ body: 'Reviewed with the patient; agree with the assessment.', author: { name: colleague.staff.name, role: 'PROVIDER_NP' } });
    expect(ws.notes.filter((n: any) => n.kind !== 'ASSESSMENT').every((n: any) => n.addenda.length === 0)).toBe(true);
  });

  it('may be added by the signer too, and by a provider of the same role', async () => {
    const { signer, notes } = await signedBy();
    const sameRole = await providerLogin('PROVIDER_CHIRO');
    expect((await post(signer, ADD(notes[0]!.id), { body: 'Own addendum.' })).status).toBe(201);
    expect((await post(sameRole, ADD(notes[0]!.id), { body: 'Colleague.' })).status).toBe(201);
  });

  it('follows its note through later amendments: attached to the chain, however old the version it names', async () => {
    const { signer, notes, id } = await signedBy();
    const colleague = await providerLogin('PROVIDER_NURSE');
    const v2 = await post(signer, AMEND(notes[0]!.id), { body: 'Subjective, corrected.', amendReason: 'Typo' });
    const onOld = await post(colleague, ADD(notes[0]!.id), { body: 'Written against the first version.' });
    setClockForTests(new Date(TUESDAY_1007.getTime() + 60_000));                              // a minute later, as in life
    const onNew = await post(colleague, ADD(v2.body.id), { body: 'Written against the amended version.' });
    setClockForTests(TUESDAY_1007);
    expect([onOld.status, onNew.status]).toEqual([201, 201]);
    const ws = (await signer.agent.get(URL.ws(id))).body;
    const subjective = ws.notes.find((n: any) => n.kind === 'SUBJECTIVE');
    expect(subjective).toMatchObject({ body: 'Subjective, corrected.', amended: true });
    expect(subjective.addenda.map((a: any) => a.body)).toEqual(['Written against the first version.', 'Written against the amended version.']);
    expect((await basePrisma.visitNote.count({ where: { bookingId: id } }))).toBe(5);       // only the one amendment is a note row
  });

  it('does not stop the signer amending afterwards — the amendment model is untouched by addenda', async () => {
    const { signer, notes } = await signedBy();
    const colleague = await providerLogin('PROVIDER_NP');
    await post(colleague, ADD(notes[3]!.id), { body: 'An addendum first.' });
    const r = await post(signer, AMEND(notes[3]!.id), { body: 'Plan, revised.', amendReason: 'Changed' });
    expect(r.status).toBe(201);
    expect((await post(signer, AMEND(notes[3]!.id), { body: 'again', amendReason: 'x' })).status).toBe(409);   // the one-amendment-per-version rule, as before
  });

  it('is refused to an administrator, the front desk and the anonymous; and validated', async () => {
    const { signer, notes } = await signedBy();
    const admin = await adminLogin();
    const r = await post(admin, ADD(notes[0]!.id), { body: 'x' });
    expect([r.status, r.body.code]).toEqual([403, 'read_only']);
    expect((await post(await frontDeskLogin(), ADD(notes[0]!.id), { body: 'x' })).status).toBe(403);
    expect((await request(app).post(ADD(notes[0]!.id)).send({ body: 'x' })).status).toBe(401);
    expect((await post(signer, ADD('no-such-note'), { body: 'x' })).status).toBe(404);
    for (const bad of [{}, { body: '' }, { body: '   ' }, { body: 'x'.repeat(20001) }, { body: 'ok', extra: 1 }, { body: 5 }]) {
      expect((await post(signer, ADD(notes[0]!.id), bad)).status, JSON.stringify(bad).slice(0, 40)).toBe(400);
    }
    expect((await post(signer, ADD(notes[0]!.id), { body: 'x'.repeat(20000) })).status).toBe(201);
    expect(await basePrisma.noteAddendum.count({ where: { authorAccountId: admin.state.account.id } })).toBe(0);
  });

  it('can never be changed: no route edits or deletes one, and the database refuses to', async () => {
    const { signer, notes } = await signedBy();
    const colleague = await providerLogin('PROVIDER_NP');
    const a = (await post(colleague, ADD(notes[0]!.id), { body: 'Fixed text.' })).body.addendum;
    for (const [m, u] of [['patch', ADD(notes[0]!.id)], ['put', ADD(notes[0]!.id)], ['delete', ADD(notes[0]!.id)], ['patch', `/api/note-addenda/${a.id}`], ['delete', `/api/note-addenda/${a.id}`]] as const) {
      const r = await (colleague.agent as any)[m](u).set('x-csrf-token', colleague.csrf).send({ body: 'changed' });
      expect([404, 405], `${m} ${u}`).toContain(r.status);
    }
    await expect(exec(`UPDATE "NoteAddendum" SET "body" = 'rewritten' WHERE "id" = '${a.id}'`)).rejects.toThrow(/append-only/);
    await expect(exec(`DELETE FROM "NoteAddendum" WHERE "id" = '${a.id}'`)).rejects.toThrow(/append-only/);
    await expect(exec('TRUNCATE "NoteAddendum"')).rejects.toThrow(/append-only/);
    expect((await basePrisma.noteAddendum.findUniqueOrThrow({ where: { id: a.id } })).body).toBe('Fixed text.');
    // the note it hangs from cannot be removed either
    await expect(exec(`DELETE FROM "VisitNote" WHERE "id" = '${notes[0]!.id}'`)).rejects.toThrow(/append-only/);
    // and the shape is enforced: an empty addendum, or one in an admin's name, does not exist
    const base = { bookingId: notes[0]!.bookingId, noteId: notes[0]!.id, authorAccountId: signer.accountId, authorStaffId: signer.staff.id };
    await expect(basePrisma.noteAddendum.create({ data: { ...base, body: '', authorRole: 'provider_chiro' as never } })).rejects.toThrow();
    await expect(basePrisma.noteAddendum.create({ data: { ...base, body: 'x', authorRole: 'admin' as never } })).rejects.toThrow();
  });

  it('is audited when written, by id and role, never the text', async () => {
    const { notes } = await signedBy();
    const colleague = await providerLogin('PROVIDER_NURSE');
    const a = (await post(colleague, ADD(notes[0]!.id), { body: 'ADDENDUM-SECRET-TEXT-42' })).body.addendum;
    const rows = await auditRows({ action: 'CREATE', resourceType: 'note_addendum', resourceId: a.id });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorAccountId: colleague.accountId });
    expect(blob(rows)).not.toContain('ADDENDUM-SECRET');
  });
});

describe('what the screens are told', () => {
  it('says which notes the viewer may amend (only their own) and whether they may add an addendum', async () => {
    const { signer, id } = await signedBy();
    const colleague = await providerLogin('PROVIDER_NP');
    const admin = await adminLogin();
    const dual = await providerLogin('PROVIDER_NURSE', ['ADMIN']);
    const view = async (s: Provider) => (await s.agent.get(URL.ws(id))).body;

    const mine = await view(signer);
    expect(mine.notes.every((n: any) => n.canAmend === true)).toBe(true);
    expect(mine.access.canAddend).toBe(true);
    const theirs = await view(colleague);
    expect(theirs.notes.every((n: any) => n.canAmend === false)).toBe(true);
    expect(theirs.access).toMatchObject({ canAddend: true, canWrite: false });               // a different role: may read and add, not write the note
    const ro = await view(admin as unknown as Provider);
    expect(ro.notes.every((n: any) => n.canAmend === false)).toBe(true);
    expect(ro.access.canAddend).toBe(false);
    expect((await view(dual)).notes.every((n: any) => n.canAmend === false)).toBe(true);
  });

  it('puts addenda in the older visit-notes read for providers and admins, never for the front desk', async () => {
    const { signer, notes, id } = await signedBy();
    const colleague = await providerLogin('PROVIDER_NP');
    await post(colleague, ADD(notes[1]!.id), { body: 'Seen on the legacy route.' });
    for (const s of [signer, await adminLogin()]) {
      const body = (await s.agent.get(`/api/bookings/${id}/notes`)).body;
      expect(body.addenda.map((a: any) => a.body)).toEqual(['Seen on the legacy route.']);
    }
    const fd = (await (await frontDeskLogin()).agent.get(`/api/bookings/${id}/notes`)).body;
    expect(fd).toMatchObject({ restricted: true, notes: [] });
    expect(blob(fd)).not.toContain('legacy route');
  });

  it('attaches addenda to the right chain (pure)', () => {
    const raw = [
      { id: 'n1', authorId: 'S1', authorAccountId: 'A1' }, { id: 'n1b', authorId: 'S1', authorAccountId: 'A1' }, { id: 'n2', authorId: 'S1', authorAccountId: 'A1' },
    ];
    const author = { id: 'x', name: 'N', role: 'r' };
    const notes = [
      { id: 'n1b', kind: 'SUBJECTIVE', body: '', durationMin: null, author, createdAt: '', amended: true, history: [{ id: 'n1', body: '', durationMin: null, author, createdAt: '', amendReason: 'r' }] },
      { id: 'n2', kind: 'PLAN', body: '', durationMin: null, author, createdAt: '', amended: false, history: [] },
    ] as never;
    const addenda = [
      { id: 'a1', noteId: 'n1', body: 'old', author: { name: 'P', role: 'provider_np' }, createdAt: '' },
      { id: 'a2', noteId: 'n2', body: 'plan', author: { name: 'P', role: 'provider_np' }, createdAt: '' },
    ];
    const out = withAddenda(notes, raw, addenda, { id: 'A1', staffId: 'S1' });
    expect(out.map((n) => [n.id, n.addenda.map((a) => a.id), n.canAmend])).toEqual([['n1b', ['a1'], true], ['n2', ['a2'], true]]);
    expect(withAddenda(notes, raw, addenda, { id: 'A9', staffId: 'S9' }).every((n) => !n.canAmend)).toBe(true);
    expect(withAddenda(notes, raw, addenda, null).every((n) => !n.canAmend)).toBe(true);
  });
});
