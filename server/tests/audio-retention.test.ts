import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { getIntegrations, loadIntegrations } from '../src/integrations/index.js';
import type { FileStorage } from '../src/integrations/types.js';
import { runAudioRetention } from '../src/jobs/audioRetention.js';
import { runAllJobsOnce } from '../src/jobs/scheduler.js';
import { prisma } from '../src/lib/prisma.js';
import { basePrisma } from '../src/lib/prismaBase.js';
import { setClockForTests } from '../src/lib/clock.js';
import { auditRows, blob } from './helpers.js';
import { TUESDAY_1007 } from './phase2.js';
import { providerLogin, URL, visit } from './phase4.js';

const NOW = TUESDAY_1007;
const DAY = 86_400_000;
const daysBefore = (n: number) => new Date(NOW.getTime() - n * DAY);

beforeAll(async () => { setClockForTests(NOW); await loadIntegrations(); });
afterAll(() => setClockForTests(null));
afterEach(() => { vi.restoreAllMocks(); });

const storage = () => getIntegrations().storage;

/** A visit with one recording whose audio and transcript are really in storage; its note signed `signedDaysAgo` days ago (null = not signed). */
async function recorded(o: { signedDaysAgo: number | null; status?: 'READY' | 'RECORDING' | 'DISCARDED' | 'FAILED'; audio?: boolean }) {
  const v = await visit({});
  const audioKey = `scribe/audio/${randomUUID()}.webm`;
  const transcriptKey = `transcripts/${randomUUID()}.txt`;
  if (o.audio !== false) await storage().put(audioKey, Buffer.from('RAW-AUDIO-BYTES'));
  await storage().put(transcriptKey, Buffer.from('The transcript that must survive.'));
  const session = await basePrisma.scribeSession.create({
    data: {
      bookingId: v.booking.id, encounterId: v.encounter!.id, status: o.status ?? 'READY', startedByAccountId: 'acct', startedRole: 'PROVIDER_CHIRO',
      audioKey, audioContentType: 'audio/webm', transcriptKey,
      draft: { subjective: 'S', objective: 'O', assessment: 'A', plan: 'P', modelId: 'stub' }, draftModelId: 'stub',
    },
  });
  if (o.signedDaysAgo !== null) {
    await basePrisma.noteSignature.create({
      data: { bookingId: v.booking.id, type: 'SOAP', noteIds: ['n'], signedAt: daysBefore(o.signedDaysAgo), signedByAccountId: 'acct', signedByStaffId: 'staff', signedRole: 'PROVIDER_CHIRO' },
    });
  }
  return { v, session, audioKey, transcriptKey };
}
const reload = (id: string) => basePrisma.scribeSession.findUniqueOrThrow({ where: { id } });

describe('who is purged, and when', () => {
  it('deletes the audio of a note signed 30 or more days ago, and nothing sooner', async () => {
    const old = await recorded({ signedDaysAgo: 31 });
    const exactly = await recorded({ signedDaysAgo: 30 });
    const almost = await recorded({ signedDaysAgo: 29.99 });
    const recent = await recorded({ signedDaysAgo: 1 });
    const r = await runAudioRetention({ now: NOW });
    expect(r.days).toBe(30);
    expect(r.purged).toBeGreaterThanOrEqual(2);
    for (const x of [old, exactly]) {
      expect(await storage().exists(x.audioKey), 'audio of a due recording').toBe(false);
      expect((await reload(x.session.id)).audioPurgedAt).toEqual(NOW);
    }
    for (const x of [almost, recent]) {
      expect(await storage().exists(x.audioKey), 'audio of a recording not yet due').toBe(true);
      expect((await reload(x.session.id)).audioPurgedAt).toBeNull();
    }
  });

  it('never purges a visit whose note is unsigned, however old the recording', async () => {
    const x = await recorded({ signedDaysAgo: null });
    await basePrisma.$executeRawUnsafe(`UPDATE "ScribeSession" SET "createdAt" = (now() AT TIME ZONE 'UTC') - interval '400 days' WHERE id = '${x.session.id}'`);
    await runAudioRetention({ now: NOW });
    expect(await storage().exists(x.audioKey)).toBe(true);
    expect((await reload(x.session.id)).audioPurgedAt).toBeNull();
  });

  it('runs from the SIGNATURE: an amendment or addendum afterwards does not restart the clock', async () => {
    const x = await recorded({ signedDaysAgo: 40 });
    const staff = await prisma.staff.create({ data: { name: 'Amender', role: 'CHIROPRACTOR' } });
    const note = await basePrisma.visitNote.create({ data: { bookingId: x.v.booking.id, authorId: staff.id, kind: 'SUBJECTIVE', body: 'x', createdAt: daysBefore(2) } });
    await basePrisma.visitNote.create({ data: { bookingId: x.v.booking.id, authorId: staff.id, kind: 'SUBJECTIVE', body: 'amended', amendsId: note.id, amendReason: 'r', createdAt: daysBefore(1) } });
    await basePrisma.noteAddendum.create({ data: { bookingId: x.v.booking.id, noteId: note.id, body: 'addendum', authorAccountId: 'a', authorStaffId: staff.id, authorRole: 'PROVIDER_NP', createdAt: daysBefore(1) } });
    await runAudioRetention({ now: NOW });
    expect(await storage().exists(x.audioKey)).toBe(false);
  });

  it('leaves a recording its provider already discarded alone (it was deleted then)', async () => {
    const x = await recorded({ signedDaysAgo: 90, status: 'DISCARDED' });
    await runAudioRetention({ now: NOW });
    expect((await reload(x.session.id)).audioPurgedAt).toBeNull();
    expect((await auditRows({ resourceType: 'scribe_audio', resourceId: x.session.id }, 0, 100)).length).toBe(0);
  });

  it('handles every recording of a visit, and one whose audio never arrived', async () => {
    const a = await recorded({ signedDaysAgo: 45 });
    const second = await basePrisma.scribeSession.create({
      data: { bookingId: a.v.booking.id, encounterId: a.v.encounter!.id, status: 'RECORDING', startedByAccountId: 'acct', startedRole: 'PROVIDER_CHIRO', audioKey: `scribe/audio/${randomUUID()}.webm`, audioContentType: 'audio/webm' },
    });
    await runAudioRetention({ now: NOW });
    expect((await reload(a.session.id)).audioPurgedAt).not.toBeNull();
    expect((await reload(second.id)).audioPurgedAt).not.toBeNull();                      // nothing to delete, and it is recorded as handled
    const rows = await auditRows({ resourceType: 'scribe_audio', resourceId: second.id, action: 'DELETE' });
    expect((rows[0]!.meta as any).existed).toBe(false);
  });
});

describe('what stays', () => {
  it('keeps the transcript (in storage) and the draft (on the session) — only the raw audio goes', async () => {
    const x = await recorded({ signedDaysAgo: 31 });
    await runAudioRetention({ now: NOW });
    expect(await storage().exists(x.audioKey)).toBe(false);
    expect((await storage().get(x.transcriptKey)).toString()).toBe('The transcript that must survive.');
    const s = await reload(x.session.id);
    expect(s).toMatchObject({ transcriptKey: x.transcriptKey, status: 'READY', draftModelId: 'stub' });
    expect(s.draft).toMatchObject({ subjective: 'S', plan: 'P' });
  });
});

describe('every deletion is audited', () => {
  it('writes one DELETE per recording, by the system, with the reason and the period — never a key', async () => {
    const x = await recorded({ signedDaysAgo: 33 });
    await runAudioRetention({ now: NOW, days: 30 });
    const rows = await auditRows({ resourceType: 'scribe_audio', resourceId: x.session.id, action: 'DELETE' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorAccountId: null, success: true });
    expect(rows[0]!.meta).toEqual({ reason: 'retention', afterDays: 30, existed: true });
    expect(blob(rows)).not.toContain(x.audioKey);
  });

  it('is idempotent: a second run deletes and audits nothing more', async () => {
    const x = await recorded({ signedDaysAgo: 33 });
    await runAudioRetention({ now: NOW });
    const second = await runAudioRetention({ now: NOW });
    expect(second.purged).toBe(0);
    expect((await auditRows({ resourceType: 'scribe_audio', resourceId: x.session.id, action: 'DELETE' })).length).toBe(1);
  });

  it('two runners at once purge a recording once', async () => {
    const x = await recorded({ signedDaysAgo: 33 });
    await Promise.all([runAudioRetention({ now: NOW }), runAudioRetention({ now: NOW }), runAudioRetention({ now: NOW })]);
    expect((await auditRows({ resourceType: 'scribe_audio', resourceId: x.session.id, action: 'DELETE' })).length).toBe(1);
    expect((await reload(x.session.id)).audioPurgedAt).toEqual(NOW);
  });
});

describe('when storage fails', () => {
  it('does not mark the recording purged, logs the class and not the message, and succeeds on the next run', async () => {
    const x = await recorded({ signedDaysAgo: 40 });
    let failing = true;
    const real = storage();
    const flaky: FileStorage = {
      exists: (k) => real.exists(k),
      delete: async (k) => { if (failing) throw new Error('S3 says bucket nextwave-patient-audio denied for Ingrid'); return real.delete(k); },
      put: (k, b, o) => real.put(k, b, o), get: (k) => real.get(k), getUploadTarget: (k, o) => real.getUploadTarget(k, o),
    };
    const lines: string[] = [];
    for (const m of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
    const first = await runAudioRetention({ now: NOW, storage: flaky });
    expect(first.failed).toBeGreaterThanOrEqual(1);
    const log = lines.join('\n');
    expect(log).toContain('audio_retention_delete_failed');
    expect(log).not.toMatch(/Ingrid|nextwave-patient-audio|denied/);
    expect(await real.exists(x.audioKey)).toBe(true);
    expect((await reload(x.session.id)).audioPurgedAt).toBeNull();
    expect(await auditRows({ resourceType: 'scribe_audio', resourceId: x.session.id }, 0, 100)).toHaveLength(0);   // nothing was deleted, so nothing is recorded as deleted

    failing = false;
    vi.restoreAllMocks();
    const second = await runAudioRetention({ now: NOW, storage: flaky });
    expect(second.failed).toBe(0);
    expect(await real.exists(x.audioKey)).toBe(false);
    expect((await reload(x.session.id)).audioPurgedAt).toEqual(NOW);
  });
});

describe('the setting and the job', () => {
  it('defaults to 30 days, and the period comes from AUDIO_RETENTION_DAYS', async () => {
    expect(config.audioRetentionDays).toBe(30);
    const x = await recorded({ signedDaysAgo: 8 });
    await runAudioRetention({ now: NOW });                                               // default 30: not yet
    expect(await storage().exists(x.audioKey)).toBe(true);
    const r = await runAudioRetention({ now: NOW, days: 7 });                            // what AUDIO_RETENTION_DAYS=7 would do
    expect(r.days).toBe(7);
    expect(await storage().exists(x.audioKey)).toBe(false);
  });

  it('runs inside jobs:run (runAllJobsOnce) and reports what it did', async () => {
    const x = await recorded({ signedDaysAgo: 35 });
    const r = await runAllJobsOnce();
    expect(r.audioRetention).not.toBeNull();
    expect(r.audioRetention!.purged).toBeGreaterThanOrEqual(1);
    expect(await storage().exists(x.audioKey)).toBe(false);
  });

  it('is told to the workspace: which recordings have lost their audio, and for how long it is kept', async () => {
    const p = await providerLogin('PROVIDER_CHIRO');
    const v = await visit({ staffId: p.staff.id });
    const audioKey = `scribe/audio/${randomUUID()}.webm`;
    await storage().put(audioKey, Buffer.from('x'));
    const s = await basePrisma.scribeSession.create({
      data: { bookingId: v.booking.id, encounterId: v.encounter!.id, status: 'READY', startedByAccountId: p.accountId, startedRole: 'PROVIDER_CHIRO', audioKey, audioContentType: 'audio/webm', transcriptKey: `transcripts/${randomUUID()}.txt`, draft: { subjective: 'a', objective: 'b', assessment: 'c', plan: 'd', modelId: 'stub' } },
    });
    await basePrisma.noteSignature.create({ data: { bookingId: v.booking.id, type: 'SOAP', noteIds: ['n'], signedAt: daysBefore(40), signedByAccountId: p.accountId, signedByStaffId: p.staff.id, signedRole: 'PROVIDER_CHIRO' } });
    await runAudioRetention({ now: NOW });
    const ws = (await p.agent.get(URL.ws(v.booking.id))).body;
    expect(ws.scribe.audioRetentionDays).toBe(30);
    expect(ws.scribe.sessions.find((x: any) => x.id === s.id)).toMatchObject({ status: 'READY', audioPurged: true });
  });
});
