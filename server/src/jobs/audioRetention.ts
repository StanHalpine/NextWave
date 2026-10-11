/**
 * Audio retention: delete a visit's raw recording AUDIO_RETENTION_DAYS (default 30) after its note was signed.
 *
 *   • the clock is the SIGNATURE (NoteSignature.signedAt) — an amendment or addendum does not restart it, and a
 *     visit whose note has not been signed is never purged (its audio is still the only source for the note);
 *   • only the raw AUDIO goes. The transcript and the AI draft stay with the encounter (their keys and the draft
 *     are on the ScribeSession; the transcript object stays in storage);
 *   • every deletion is audited (DELETE on scribe_audio, with the reason and the retention period; never a key);
 *   • idempotent and safe to run every five minutes from jobs:run: a recording is marked purged only AFTER the
 *     storage delete succeeded, so a failed delete is retried on the next run, never forgotten;
 *   • a discarded recording was already deleted by its provider, and is left alone.
 *
 * Note: with the development stub storage, a file lives on the disk of the process that wrote it. A cron job
 * cannot delete what the web service wrote on its own disk; real storage (S3) has no such split.
 */

import { config } from '../config.js';
import { getIntegrations } from '../integrations/index.js';
import type { FileStorage } from '../integrations/types.js';
import { now } from '../lib/clock.js';
import { logger } from '../lib/logger.js';
import { basePrisma } from '../lib/prismaBase.js';
import { staffTransaction } from '../lib/staffTx.js';

export interface AudioRetentionResult {
  /** Recordings whose audio was deleted (or found already gone) and marked purged on this run. */
  purged: number;
  /** Deletes that failed and will be tried again on the next run. */
  failed: number;
  /** The retention period applied, in days. */
  days: number;
}

const BATCH = 200;

export async function runAudioRetention(deps: { storage?: FileStorage; now?: Date; days?: number } = {}): Promise<AudioRetentionResult> {
  const at = deps.now ?? now();
  const days = deps.days ?? config.audioRetentionDays;
  const storage = deps.storage ?? getIntegrations().storage;
  const cutoff = new Date(at.getTime() - days * 86_400_000);
  const result: AudioRetentionResult = { purged: 0, failed: 0, days };

  const due = await basePrisma.scribeSession.findMany({
    where: {
      audioPurgedAt: null,
      status: { not: 'DISCARDED' },
      booking: { noteSignature: { is: { signedAt: { lte: cutoff } } } },
    },
    select: { id: true, audioKey: true },
    orderBy: { createdAt: 'asc' },
    take: BATCH,
  });

  for (const s of due) {
    let existed = false;
    try {
      existed = await storage.exists(s.audioKey);
      if (existed) await storage.delete(s.audioKey);
    } catch (err) {
      // The adapter's own message can quote what it was given: log the class and the session id only.
      logger.warn('audio_retention_delete_failed', { sessionId: s.id, errorClass: err instanceof Error ? err.constructor?.name ?? 'Error' : typeof err });
      result.failed++;
      continue;
    }
    const marked = await staffTransaction(async (tx, rec) => {
      const r = await tx.scribeSession.updateMany({ where: { id: s.id, audioPurgedAt: null }, data: { audioPurgedAt: at } });
      if (r.count !== 1) return false;                              // another runner got there first
      await rec({ action: 'DELETE', resourceType: 'scribe_audio', resourceId: s.id, meta: { reason: 'retention', afterDays: days, existed } });
      return true;
    });
    if (marked) result.purged++;
  }
  if (result.purged || result.failed) logger.info('audio_retention_ran', { ...result });
  return result;
}
