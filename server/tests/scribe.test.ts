import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { config } from '../src/config.js';
import { getIntegrations, loadIntegrations, scribeAvailability } from '../src/integrations/index.js';
import { DEMO_SOAP, DEMO_TRANSCRIPT } from '../src/integrations/stubs.js';
import type { AiScribe, SoapDraft } from '../src/integrations/types.js';
import { signUpload, verifyUpload } from '../src/integrations/uploadToken.js';
import { prisma } from '../src/lib/prisma.js';
import { basePrisma } from '../src/lib/prismaBase.js';
import { setClockForTests } from '../src/lib/clock.js';
import { audioExtension, processSession } from '../src/lib/scribe.js';
import { app, auditRows, blob } from './helpers.js';
import { TUESDAY_1007 } from './phase2.js';
import { adminLogin, frontDeskLogin, post, providerLogin, put, saveSoap, URL, visit, type Provider } from './phase4.js';

beforeAll(async () => { setClockForTests(TUESDAY_1007); await loadIntegrations(); });
afterAll(() => setClockForTests(null));

const AUDIO = Buffer.from('FAKE-AUDIO-BYTES-do-not-log');
const TYPE = 'audio/webm;codecs=opus';

/** A provider and a visit booked with them, ready to document. */
async function setup(doc: 'SOAP' | 'SESSION_LOG' = 'SOAP') {
  const p = await providerLogin('PROVIDER_CHIRO');
  const v = await visit({ staffId: p.staff.id, doc });
  return { p, v, id: v.booking.id };
}

async function consent(p: Provider, id: string) {
  const r = await post(p, URL.consent(id), { consented: true });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

/** consent → start → signed upload URL → PUT the audio with NO cookie → finish. Returns the session id. */
async function record(p: Provider, id: string, bytes: Buffer = AUDIO) {
  await consent(p, id);
  const start = await post(p, URL.sessions(id), { contentType: TYPE });
  expect(start.status, JSON.stringify(start.body)).toBe(201);
  const sid = start.body.session.id as string;
  const target = (await post(p, URL.session(id, sid, '/upload'))).body.upload;
  const up = await request(app).put(target.url).set(target.headers).send(bytes);       // as a browser would: no cookie, no CSRF header
  expect(up.status, JSON.stringify(up.body)).toBe(200);
  const fin = await post(p, URL.session(id, sid, '/finish'), { bytes: bytes.length });
  expect(fin.status, JSON.stringify(fin.body)).toBe(202);
  return sid;
}

async function untilStatus(p: Provider, id: string, sid: string, want: string) {
  let last = '';
  await vi.waitFor(async () => {
    last = (await p.agent.get(URL.session(id, sid))).body.session.status;
    if (last !== want) throw new Error(`status is ${last}, waiting for ${want}`);
  }, { timeout: 8000, interval: 25 });
  return last;
}

/** Everything the app writes to its logs while `fn` runs. */
async function logged<T>(fn: () => Promise<T>): Promise<{ result: T; text: string }> {
  const lines: string[] = [];
  const spies = (['log', 'info', 'warn', 'error'] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); }));
  try { return { result: await fn(), text: lines.join('\n') }; } finally { spies.forEach((s) => s.mockRestore()); }
}

const realScribe = () => getIntegrations().aiScribe;
const swapScribe = (s: AiScribe) => { const ig = getIntegrations(); const saved = ig.aiScribe; ig.aiScribe = s; return () => { ig.aiScribe = saved; }; };
afterEach(() => { vi.restoreAllMocks(); });

describe('the recording needs the patient\'s consent first', () => {
  it('refuses to start without it, and records the provider\'s attestation (audited) once given', async () => {
    const { p, id } = await setup();
    const early = await post(p, URL.sessions(id), { contentType: TYPE });
    expect([early.status, early.body.code]).toEqual([409, 'consent_required']);
    expect(await prisma.scribeSession.count({ where: { bookingId: id } })).toBe(0);

    await consent(p, id);
    const enc = await prisma.encounter.findUniqueOrThrow({ where: { bookingId: id } });
    expect(enc.scribeConsentAt).toEqual(TUESDAY_1007);
    const rows = await auditRows({ action: 'UPDATE', resourceType: 'encounter', resourceId: enc.id, actorAccountId: p.accountId });
    expect(blob(rows)).toContain('scribeConsentAt');

    expect((await post(p, URL.sessions(id), { contentType: TYPE })).status).toBe(201);
  });

  it('is only recorded when the provider says the patient agreed — not as a default', async () => {
    const { p, id } = await setup();
    for (const bad of [{}, { consented: false }, { consented: 'yes' }, { consented: true, extra: 1 }]) {
      expect((await post(p, URL.consent(id), bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await prisma.encounter.findUniqueOrThrow({ where: { bookingId: id } })).scribeConsentAt).toBeNull();
  });

  it('is idempotent: a second attestation keeps the first time', async () => {
    const { p, id } = await setup();
    await consent(p, id);
    setClockForTests(new Date(TUESDAY_1007.getTime() + 600_000));
    try { await consent(p, id); } finally { setClockForTests(TUESDAY_1007); }
    expect((await prisma.encounter.findUniqueOrThrow({ where: { bookingId: id } })).scribeConsentAt).toEqual(TUESDAY_1007);
  });
});

describe('record → upload → transcribe → draft, with the stub', () => {
  it('goes from a recording to a transcript and a SOAP draft, and stops there: nothing is signed', async () => {
    const { p, v, id } = await setup();
    const sid = await record(p, id);
    await untilStatus(p, id, sid, 'READY');

    const s = await prisma.scribeSession.findUniqueOrThrow({ where: { id: sid } });
    expect(s).toMatchObject({ status: 'READY', bookingId: id, encounterId: v.encounter!.id, startedByAccountId: p.accountId, startedRole: 'PROVIDER_CHIRO', draftModelId: 'stub', failureCode: null, audioBytes: AUDIO.length });
    expect(s.audioKey).toMatch(/^scribe\/audio\/[0-9a-f-]{36}\.webm$/);
    expect(s.transcriptKey).toMatch(/^transcripts\/[0-9a-f-]{36}\.txt$/);

    // The audio and the transcript are in storage; the database holds only their keys.
    const { storage } = getIntegrations();
    expect((await storage.get(s.audioKey)).equals(AUDIO)).toBe(true);
    expect((await storage.get(s.transcriptKey!)).toString()).toBe(DEMO_TRANSCRIPT);

    // The draft is AI output waiting for a provider — not a note.
    expect(await prisma.documentationDraft.count({ where: { bookingId: id } })).toBe(0);
    expect(await prisma.visitNote.count({ where: { bookingId: id } })).toBe(0);
    expect(await prisma.noteSignature.count({ where: { bookingId: id } })).toBe(0);
    expect((await prisma.encounter.findUniqueOrThrow({ where: { bookingId: id } })).status).toBe('IN_PROGRESS');
  });

  it('serves the transcript and the draft to the provider (and an administrator), each read audited', async () => {
    const { p, id } = await setup();
    const sid = await record(p, id);
    await untilStatus(p, id, sid, 'READY');

    const t = await p.agent.get(URL.session(id, sid, '/transcript'));
    expect(t.body.transcript).toBe(DEMO_TRANSCRIPT);
    const d = await p.agent.get(URL.session(id, sid, '/draft'));
    expect(d.body).toMatchObject({ draft: DEMO_SOAP, modelId: 'stub', applied: false });

    const admin = await adminLogin();
    expect((await admin.agent.get(URL.session(id, sid, '/transcript'))).status).toBe(200);
    expect((await (await frontDeskLogin()).agent.get(URL.session(id, sid, '/transcript'))).status).toBe(403);

    const tr = await auditRows({ action: 'READ', resourceType: 'scribe_transcript', resourceId: sid }, 2);
    expect(tr.map((r) => r.actorAccountId)).toEqual(expect.arrayContaining([p.accountId, admin.state.account.id]));
    expect((await auditRows({ action: 'READ', resourceType: 'scribe_draft', resourceId: sid, actorAccountId: p.accountId })).length).toBe(1);
    expect(blob(await prisma.auditLog.findMany({ where: { resourceId: sid } }))).not.toMatch(/lumbar|stiff|DEMO/);
  });

  it('audits the whole life of the recording: session, audio, transcript and draft', async () => {
    const { p, id } = await setup();
    const sid = await record(p, id);
    await untilStatus(p, id, sid, 'READY');
    const rows = await auditRows({ resourceId: sid }, 5);
    const have = new Set(rows.map((r) => `${r.action}:${r.resourceType}`));
    for (const want of ['CREATE:scribe_session', 'CREATE:scribe_audio', 'CREATE:scribe_transcript', 'CREATE:scribe_draft']) expect(have, want).toContain(want);
    expect(rows.filter((r) => r.resourceType === 'scribe_audio').length).toBeGreaterThanOrEqual(2);   // the upload, and the hand-off to transcription
  });

  it('is offered only for SOAP services, to the booked role, and not to the front desk or an administrator', async () => {
    const { p } = await setup();
    const log = await visit({ doc: 'SESSION_LOG', staffId: p.staff.id });
    await consent(p, log.booking.id);
    expect((await post(p, URL.sessions(log.booking.id), { contentType: TYPE })).body.code).toBe('not_soap');

    const np = await providerLogin('PROVIDER_NP');
    const chiroVisit = await visit({ staffRole: 'CHIROPRACTOR' });
    expect((await post(np, URL.consent(chiroVisit.booking.id), { consented: true })).body.code).toBe('wrong_role');

    const { id } = await setup();
    for (const s of [await frontDeskLogin(), await adminLogin()]) {
      expect((await post(s, URL.consent(id), { consented: true })).status).toBe(403);
      expect((await post(s, URL.sessions(id), { contentType: TYPE })).status).toBe(403);
    }
  });

  it('refuses unsupported recording formats and too many open recordings', async () => {
    const { p, id } = await setup();
    await consent(p, id);
    for (const bad of ['video/mp4', 'text/plain', 'application/octet-stream', 'audio/x-unknown']) {
      expect((await post(p, URL.sessions(id), { contentType: bad })).body.code, bad).toBe('bad_audio_type');
    }
    expect(audioExtension('audio/webm;codecs=opus')).toBe('webm');
    expect(audioExtension('audio/mp4')).toBe('m4a');
    for (let i = 0; i < 3; i++) expect((await post(p, URL.sessions(id), { contentType: TYPE })).status).toBe(201);
    expect((await post(p, URL.sessions(id), { contentType: TYPE })).body.code).toBe('too_many_recordings');
  });
});

describe('finishing', () => {
  it('refuses when the audio never arrived, and is idempotent when it did', async () => {
    const { p, id } = await setup();
    await consent(p, id);
    const sid = (await post(p, URL.sessions(id), { contentType: TYPE })).body.session.id;
    const missing = await post(p, URL.session(id, sid, '/finish'));
    expect([missing.status, missing.body.code]).toEqual([409, 'upload_missing']);

    const target = (await post(p, URL.session(id, sid, '/upload'))).body.upload;
    await request(app).put(target.url).set(target.headers).send(AUDIO);
    const first = await post(p, URL.session(id, sid, '/finish'));
    const second = await post(p, URL.session(id, sid, '/finish'));
    expect([first.body.queued, second.body.queued]).toEqual([true, false]);
    await untilStatus(p, id, sid, 'READY');
    expect(await prisma.auditLog.count({ where: { resourceType: 'scribe_transcript', resourceId: sid, action: 'CREATE' } })).toBe(1);   // transcribed once
  });

  it('will not issue an upload target for a recording that already has its audio', async () => {
    const { p, id } = await setup();
    const sid = await record(p, id);
    expect((await post(p, URL.session(id, sid, '/upload'))).body.code).toBe('not_recording');
  });

  it('does not let one provider\'s session be driven through another visit\'s URL', async () => {
    const { p, id } = await setup();
    const other = await visit({ staffId: p.staff.id });
    await consent(p, id);
    const sid = (await post(p, URL.sessions(id), { contentType: TYPE })).body.session.id;
    expect((await post(p, URL.session(other.booking.id, sid, '/upload'))).status).toBe(404);
    expect((await p.agent.get(URL.session(other.booking.id, sid))).status).toBe(404);
    expect((await p.agent.get(URL.session(other.booking.id, sid, '/transcript'))).status).toBe(404);
  });
});

describe('the draft is for a provider to review, never signed on its own', () => {
  async function ready() {
    const s = await setup();
    const sid = await record(s.p, s.id);
    await untilStatus(s.p, s.id, sid, 'READY');
    return { ...s, sid };
  }

  it('is put into the note only when the provider chooses, filling the empty sections or replacing them all', async () => {
    const { p, id, sid } = await ready();
    const v1 = await saveSoap(p, id, { subjective: 'Written by hand.', objective: '', assessment: '', plan: '' });

    const fill = await post(p, URL.session(id, sid, '/apply'), { mode: 'fill_empty', version: v1 });
    expect(fill.status).toBe(200);
    let draft = await prisma.documentationDraft.findUniqueOrThrow({ where: { bookingId: id } });
    expect(draft).toMatchObject({ subjective: 'Written by hand.', objective: DEMO_SOAP.objective, assessment: DEMO_SOAP.assessment, plan: DEMO_SOAP.plan, scribeSessionId: sid, version: v1 + 1 });
    expect(draft.aiAppliedAt).not.toBeNull();
    expect((await prisma.scribeSession.findUniqueOrThrow({ where: { id: sid } })).appliedAt).not.toBeNull();

    await post(p, URL.session(id, sid, '/apply'), { mode: 'replace_all', version: draft.version });
    draft = await prisma.documentationDraft.findUniqueOrThrow({ where: { bookingId: id } });
    expect(draft.subjective).toBe(DEMO_SOAP.subjective);
    expect(await prisma.visitNote.count({ where: { bookingId: id } })).toBe(0);
  });

  it('can start a note from nothing, and refuses a stale version or an unknown mode', async () => {
    const { p, id, sid } = await ready();
    expect((await post(p, URL.session(id, sid, '/apply'), { mode: 'merge' })).status).toBe(400);
    const r = await post(p, URL.session(id, sid, '/apply'), { mode: 'fill_empty' });
    expect(r.status).toBe(200);
    expect(r.body.version).toBe(1);
    const stale = await post(p, URL.session(id, sid, '/apply'), { mode: 'replace_all', version: 99 });
    expect([stale.status, stale.body.code, stale.body.currentVersion]).toEqual([409, 'stale_draft', 1]);
  });

  it('cannot be signed without the provider\'s explicit review, and not while it still holds demonstration text', async () => {
    const { p, id, sid } = await ready();
    const applied = await post(p, URL.session(id, sid, '/apply'), { mode: 'fill_empty' });
    const flagged = (await p.agent.get(URL.ws(id))).body.draft;
    expect(flagged.aiDrafted).toBe(true);

    // 1. the review attestation is required…
    const unreviewed = await post(p, URL.sign(id), { version: applied.body.version });
    expect([unreviewed.status, unreviewed.body.code]).toEqual([409, 'ai_review_required']);
    expect((await post(p, URL.sign(id), { version: applied.body.version, reviewedAiDraft: false })).body.code).toBe('ai_review_required');
    // 2. …and even with it, the stub's demonstration text cannot be signed as it stands.
    const reviewed = await post(p, URL.sign(id), { version: applied.body.version, reviewedAiDraft: true });
    expect([reviewed.status, reviewed.body.code]).toEqual([409, 'demo_text_present']);
    expect(await prisma.noteSignature.count({ where: { bookingId: id } })).toBe(0);
    expect(await prisma.visitNote.count({ where: { bookingId: id } })).toBe(0);
  });

  it('is signed after the provider has edited it and confirmed the review — and the signature says an AI draft was the starting point', async () => {
    const { p, id, sid } = await ready();
    const applied = await post(p, URL.session(id, sid, '/apply'), { mode: 'fill_empty' });
    const v2 = await saveSoap(p, id, {
      subjective: 'Edited by the provider: two weeks of morning stiffness.', objective: 'Edited objective findings.',
      assessment: 'Edited assessment.', plan: 'Edited plan.',
    }, applied.body.version);

    const r = await post(p, URL.sign(id), { version: v2, reviewedAiDraft: true });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.signed).toMatchObject({ aiAssisted: true, aiDraftUnchanged: false, role: 'PROVIDER_CHIRO' });
    const sig = await prisma.noteSignature.findUniqueOrThrow({ where: { bookingId: id } });
    expect(sig).toMatchObject({ aiAssisted: true, aiDraftUnchanged: false, scribeSessionId: sid, signedByAccountId: p.accountId });
    expect((await prisma.visitNote.findMany({ where: { bookingId: id } })).map((n) => n.body)).not.toContainEqual(expect.stringContaining('DEMO'));
    expect((await p.agent.get(URL.ws(id))).body.signature).toMatchObject({ aiAssisted: true, aiDraftUnchanged: false });
  });

  it('records when a provider signed an AI draft exactly as it came (allowed, but visible)', async () => {
    const { p, id } = await setup();
    const clean: SoapDraft = { subjective: 'S text.', objective: 'O text.', assessment: 'A text.', plan: 'P text.', modelId: 'fake-model' };
    const restore = swapScribe({ transcribe: realScribe().transcribe.bind(realScribe()), draftSoap: async () => clean });
    try {
      const sid = await record(p, id);
      await untilStatus(p, id, sid, 'READY');
      const applied = await post(p, URL.session(id, sid, '/apply'), { mode: 'replace_all' });
      const r = await post(p, URL.sign(id), { version: applied.body.version, reviewedAiDraft: true });
      expect(r.status).toBe(201);
      expect(r.body.signed).toMatchObject({ aiAssisted: true, aiDraftUnchanged: true });
      expect((await prisma.scribeSession.findUniqueOrThrow({ where: { id: sid } })).draftModelId).toBe('fake-model');
    } finally { restore(); }
  });

  it('needs no attestation for a note the provider wrote themselves', async () => {
    const { p, id } = await setup();
    expect((await post(p, URL.sign(id), { version: await saveSoap(p, id) })).status).toBe(201);
  });

  it('refuses a draft that is not ready, a session from another visit, and use after signing', async () => {
    const { p, id } = await setup();
    await consent(p, id);
    const sid = (await post(p, URL.sessions(id), { contentType: TYPE })).body.session.id;
    expect((await post(p, URL.session(id, sid, '/apply'), { mode: 'fill_empty' })).body.code).toBe('draft_not_ready');
    expect((await p.agent.get(URL.session(id, sid, '/draft'))).status).toBe(404);
    expect((await post(p, URL.session(id, 'nope', '/apply'), { mode: 'fill_empty' })).body.code).toBe('unknown_session');

    const s2 = await ready();
    await post(s2.p, URL.sign(s2.id), { version: await saveSoap(s2.p, s2.id) });
    expect((await post(s2.p, URL.session(s2.id, s2.sid, '/apply'), { mode: 'fill_empty' })).body.code).toBe('already_signed');
  });
});

describe('when processing fails', () => {
  const failing = (over: Partial<AiScribe>): AiScribe => ({
    transcribe: realScribe().transcribe.bind(realScribe()),
    draftSoap: realScribe().draftSoap.bind(realScribe()),
    ...over,
  });

  it('marks the recording failed with a category — never the provider\'s message — and can be retried to success', async () => {
    const { p, id } = await setup();
    const restore = swapScribe(failing({ transcribe: async () => { throw new Error('Transcribe says patient Ingrid Holloway 612-555-0100 is unclear'); } }));
    let sid = '';
    const { text } = await logged(async () => {
      sid = await record(p, id);
      await untilStatus(p, id, sid, 'FAILED');
    });
    restore();

    const s = await prisma.scribeSession.findUniqueOrThrow({ where: { id: sid } });
    expect(s).toMatchObject({ status: 'FAILED', failureCode: 'transcribe_failed', transcriptKey: null });
    expect(blob(s)).not.toMatch(/Ingrid|555-0100/);
    expect(text).not.toMatch(/Ingrid|Holloway|555-0100/);                                  // the adapter's message never reaches the log
    expect(text).toContain('scribe_failed');
    expect(text).toContain('transcribe_failed');                                              // …but the stage and class are there to debug with

    expect((await post(p, URL.session(id, sid, '/retry'))).status).toBe(202);
    await untilStatus(p, id, sid, 'READY');
    expect((await prisma.scribeSession.findUniqueOrThrow({ where: { id: sid } })).failureCode).toBeNull();
  });

  it('keeps the transcript when only the drafting failed, and retries just that step', async () => {
    const { p, id } = await setup();
    let transcribed = 0;
    const real = realScribe();
    const restore = swapScribe({
      transcribe: async (i) => { transcribed++; return real.transcribe(i); },
      draftSoap: async () => { throw new Error('model unavailable'); },
    });
    let sid = '';
    try {
      sid = await record(p, id);
      await untilStatus(p, id, sid, 'FAILED');
    } finally { restore(); }
    const s = await prisma.scribeSession.findUniqueOrThrow({ where: { id: sid } });
    expect([s.failureCode, s.transcriptKey !== null, transcribed]).toEqual(['draft_failed', true, 1]);

    await post(p, URL.session(id, sid, '/retry'));
    await untilStatus(p, id, sid, 'READY');
    expect(transcribed).toBe(1);                                                            // not transcribed again
  });

  it('only retries a failed recording', async () => {
    const { p, id } = await setup();
    const sid = await record(p, id);
    await untilStatus(p, id, sid, 'READY');
    expect((await post(p, URL.session(id, sid, '/retry'))).body.code).toBe('not_failed');
  });

  it('reports a recording stuck mid-processing as timed out, so it can be retried', async () => {
    const { p, id } = await setup();
    await consent(p, id);
    const sid = (await post(p, URL.sessions(id), { contentType: TYPE })).body.session.id;
    await basePrisma.$executeRawUnsafe(`UPDATE "ScribeSession" SET "status" = 'TRANSCRIBING', "updatedAt" = now() - interval '2 hours' WHERE "id" = '${sid}'`);
    const s = (await p.agent.get(URL.session(id, sid))).body.session;
    expect([s.status, s.failureCode]).toEqual(['FAILED', 'timed_out']);
    // …and a fresh one is left alone.
    const fresh = (await post(p, URL.sessions(id), { contentType: TYPE })).body.session.id;
    await basePrisma.$executeRawUnsafe(`UPDATE "ScribeSession" SET "status" = 'TRANSCRIBING' WHERE "id" = '${fresh}'`);
    expect((await p.agent.get(URL.session(id, fresh))).body.session.status).toBe('TRANSCRIBING');
  });

  it('processing a session twice at once transcribes it once', async () => {
    const { p, id } = await setup();
    await consent(p, id);
    const sid = (await post(p, URL.sessions(id), { contentType: TYPE })).body.session.id;
    const target = (await post(p, URL.session(id, sid, '/upload'))).body.upload;
    await request(app).put(target.url).set(target.headers).send(AUDIO);
    await basePrisma.scribeSession.update({ where: { id: sid }, data: { status: 'UPLOADED' } });
    let calls = 0;
    const real = realScribe();
    const restore = swapScribe({ transcribe: async (i) => { calls++; return real.transcribe(i); }, draftSoap: real.draftSoap.bind(real) });
    try { await Promise.all([processSession(sid), processSession(sid), processSession(sid)]); } finally { restore(); }
    expect(calls).toBe(1);
    expect((await prisma.scribeSession.findUniqueOrThrow({ where: { id: sid } })).status).toBe('READY');
  });
});

describe('throwing a recording away', () => {
  it('deletes the audio, the transcript and the draft text, keeps a record that it happened, and audits it', async () => {
    const { p, id } = await setup();
    const sid = await record(p, id);
    await untilStatus(p, id, sid, 'READY');
    const before = await prisma.scribeSession.findUniqueOrThrow({ where: { id: sid } });

    const r = await post(p, URL.session(id, sid, '/discard'));
    expect(r.body.session.status).toBe('DISCARDED');
    const { storage } = getIntegrations();
    expect(await storage.exists(before.audioKey)).toBe(false);
    expect(await storage.exists(before.transcriptKey!)).toBe(false);
    const after = await prisma.scribeSession.findUniqueOrThrow({ where: { id: sid } });
    expect(after).toMatchObject({ status: 'DISCARDED', draft: null, draftModelId: null });
    expect(after.discardedAt).not.toBeNull();
    expect((await auditRows({ action: 'DELETE', resourceType: 'scribe_audio', resourceId: sid })).length).toBe(1);
    expect((await auditRows({ action: 'DELETE', resourceType: 'scribe_transcript', resourceId: sid })).length).toBe(1);

    expect((await p.agent.get(URL.session(id, sid, '/transcript'))).status).toBe(409);
    expect((await p.agent.get(URL.session(id, sid, '/draft'))).status).toBe(404);
    expect((await post(p, URL.session(id, sid, '/apply'), { mode: 'fill_empty' })).body.code).toBe('draft_not_ready');
    expect((await post(p, URL.session(id, sid, '/discard'))).body.session.status).toBe('DISCARDED');            // idempotent
    expect((await p.agent.get(URL.ws(id))).body.scribe.sessions.map((s: any) => s.id)).not.toContain(sid);      // gone from the workspace
  });

  it('is refused once the draft is part of the note', async () => {
    const { p, id } = await setup();
    const sid = await record(p, id);
    await untilStatus(p, id, sid, 'READY');
    await post(p, URL.session(id, sid, '/apply'), { mode: 'fill_empty' });
    const r = await post(p, URL.session(id, sid, '/discard'));
    expect([r.status, r.body.code]).toEqual([409, 'already_used']);
    expect(await getIntegrations().storage.exists((await prisma.scribeSession.findUniqueOrThrow({ where: { id: sid } })).audioKey)).toBe(true);
  });
});

describe('the upload link', () => {
  async function target() {
    const { p, id } = await setup();
    await consent(p, id);
    const sid = (await post(p, URL.sessions(id), { contentType: TYPE })).body.session.id;
    const up = (await post(p, URL.session(id, sid, '/upload'))).body.upload;
    const session = await prisma.scribeSession.findUniqueOrThrow({ where: { id: sid } });
    return { p, id, sid, up, key: session.audioKey };
  }
  const put2 = (url: string, type = TYPE, body: Buffer = AUDIO) => request(app).put(url).set('content-type', type).send(body);

  it('is a signed, expiring URL that needs no cookie — like a presigned S3 PUT', async () => {
    const { up, key } = await target();
    expect(up.method).toBe('PUT');
    expect(up.headers).toEqual({ 'content-type': TYPE });
    expect(up.url).toMatch(new RegExp(`^/api/dev-storage/${key.replace(/[/.]/g, '\\$&')}\\?exp=\\d+&sig=[\\w-]+$`));
    expect(new Date(up.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect((await put2(up.url)).status).toBe(200);
  });

  it('refuses a tampered signature, a different key, a different content type, and an expired link', async () => {
    const a = await target();
    const b = await target();
    expect((await put2(a.up.url.replace(/sig=./, 'sig=X'))).status).toBe(403);
    expect((await put2(a.up.url.replace(a.key, b.key))).status).toBe(403);                  // a's signature on b's key
    expect((await put2(a.up.url, 'audio/ogg')).status).toBe(403);                           // signed for webm, sent as ogg
    const expired = signUpload(a.key, TYPE, new Date(Date.now() - 1000));
    expect((await put2(`/api/dev-storage/${a.key}?exp=${expired.exp}&sig=${expired.sig}`)).status).toBe(403);
    expect(verifyUpload(a.key, TYPE, expired.exp, expired.sig)).toBe(false);
    expect((await put2(`/api/dev-storage/${a.key}`)).status).toBe(403);                     // no signature at all
    expect(await getIntegrations().storage.exists(a.key)).toBe(false);
  });

  it('cannot write an arbitrary key, even with a valid signature for it', async () => {
    const { up } = await target();
    for (const key of ['../../etc/passwd.webm', 'scribe/audio/not-a-session.webm', 'transcripts/x.webm']) {
      const sig = signUpload(key, TYPE, new Date(Date.now() + 60_000));
      const r = await put2(`/api/dev-storage/${key}?exp=${sig.exp}&sig=${sig.sig}`);
      expect(r.status, key).toBeGreaterThanOrEqual(400);
      expect(await getIntegrations().storage.exists(key).catch(() => false), key).toBe(false);
    }
    expect(up.url).toBeTruthy();
  });

  it('takes one upload per recording, and nothing empty or unsupported', async () => {
    const { up, p, id, sid } = await target();
    expect((await put2(up.url, TYPE, Buffer.alloc(0))).status).toBe(400);
    expect((await put2(up.url)).status).toBe(200);
    await post(p, URL.session(id, sid, '/finish'));
    expect((await put2(up.url)).status).toBe(404);                                          // no longer waiting for audio
  });

  it('is absent when real storage is in use, and in production unless this is a staging deployment with fake patients', async () => {
    const { up } = await target();
    const prod = config.isProduction;
    const allow = config.allowStubIntegrations;
    try {
      (config as { isProduction: boolean }).isProduction = true;
      (config as { allowStubIntegrations: boolean }).allowStubIntegrations = false;
      expect((await put2(up.url)).status).toBe(404);
      (config as { allowStubIntegrations: boolean }).allowStubIntegrations = true;
      expect((await put2(up.url)).status).toBe(200);
    } finally {
      (config as { isProduction: boolean }).isProduction = prod;
      (config as { allowStubIntegrations: boolean }).allowStubIntegrations = allow;
    }
  });
});

describe('the scribe is off in production while a stub backs it', () => {
  async function withConfig(isProduction: boolean, allow: boolean, fn: () => Promise<void>) {
    const prod = config.isProduction; const a = config.allowStubIntegrations;
    (config as { isProduction: boolean }).isProduction = isProduction;
    (config as { allowStubIntegrations: boolean }).allowStubIntegrations = allow;
    try { await fn(); } finally {
      (config as { isProduction: boolean }).isProduction = prod;
      (config as { allowStubIntegrations: boolean }).allowStubIntegrations = a;
    }
  }

  it('reports its availability honestly', async () => {
    await withConfig(false, false, async () => expect(scribeAvailability()).toEqual({ available: true, reason: null }));
    await withConfig(true, false, async () => expect(scribeAvailability()).toEqual({ available: false, reason: 'stub_in_production' }));
    await withConfig(true, true, async () => expect(scribeAvailability()).toEqual({ available: true, reason: null }));
  });

  it('refuses every scribe call in production with stubs, tells the workspace why, and leaves the rest of documentation working', async () => {
    const { p, id } = await setup();
    await withConfig(true, false, async () => {
      for (const [label, r] of [
        ['consent', await post(p, URL.consent(id), { consented: true })],
        ['start', await post(p, URL.sessions(id), { contentType: TYPE })],
        ['upload', await post(p, URL.session(id, 'x', '/upload'))],
        ['finish', await post(p, URL.session(id, 'x', '/finish'))],
        ['retry', await post(p, URL.session(id, 'x', '/retry'))],
      ] as const) {
        expect([r.status, r.body.code, r.body.reason], label).toEqual([503, 'scribe_unavailable', 'stub_in_production']);
      }
      const ws = (await p.agent.get(URL.ws(id))).body;
      expect(ws.scribe).toMatchObject({ applicable: true, available: false, unavailableReason: 'stub_in_production' });
      expect((await put(p, URL.draft(id), { subjective: 'Typed by hand.', objective: 'o', assessment: 'a', plan: 'p' })).status).toBe(200);   // macros, SOAP and signing still work
    });
    expect(await prisma.scribeSession.count({ where: { bookingId: id } })).toBe(0);
  });

  it('is off when an integration is disabled by an administrator', async () => {
    const saved = await basePrisma.integrationConfig.findUniqueOrThrow({ where: { kind: 'AI_SCRIBE' } });
    await basePrisma.integrationConfig.update({ where: { kind: 'AI_SCRIBE' }, data: { enabled: false } });
    try {
      await loadIntegrations();
      expect(scribeAvailability()).toEqual({ available: false, reason: 'integration_disabled' });
      const { p, id } = await setup();
      expect((await post(p, URL.consent(id), { consented: true })).body.reason).toBe('integration_disabled');
    } finally {
      await basePrisma.integrationConfig.update({ where: { kind: 'AI_SCRIBE' }, data: { enabled: saved.enabled } });
      await loadIntegrations();
    }
    expect(scribeAvailability().available).toBe(true);
  });
});

describe('no clinical content in logs', () => {
  it('writes nothing of the audio, transcript, draft or their storage keys to the logs across the whole flow', async () => {
    const { p, id } = await setup();
    let sid = '';
    const { text } = await logged(async () => {
      sid = await record(p, id);
      await untilStatus(p, id, sid, 'READY');
      await p.agent.get(URL.session(id, sid, '/transcript'));
      await p.agent.get(URL.session(id, sid, '/draft'));
      const applied = await post(p, URL.session(id, sid, '/apply'), { mode: 'fill_empty' });
      await post(p, URL.sign(id), { version: applied.body.version });                      // refused (demo text) — an error path
      await post(p, URL.session(id, sid, '/retry'));                                       // refused (not failed)
    });
    const s = await prisma.scribeSession.findUniqueOrThrow({ where: { id: sid } });
    expect(text.length).toBeGreaterThan(0);                                                // the flow does log: ids, counts, status names
    for (const secret of [DEMO_TRANSCRIPT.slice(20, 60), 'lumbar', 'stiffness', 'FAKE-AUDIO', s.audioKey, s.transcriptKey!, s.audioKey.split('/').pop()!, DEMO_SOAP.plan.slice(15, 40)]) {
      expect(text, secret).not.toContain(secret);
    }
  });
});

describe('stub transcript and draft are plainly demonstration text', () => {
  it('marks every canned section so it cannot be mistaken for, or signed as, a real note', () => {
    expect(DEMO_TRANSCRIPT).toMatch(/\[DEMO TRANSCRIPT\]/);
    for (const section of Object.values(DEMO_SOAP)) expect(section).toMatch(/\[DEMO DRAFT\]/);
  });
});
