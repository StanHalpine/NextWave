/**
 * Development stubs. They log opaque facts to the console and write payloads to
 * local disk under server/.devdata/ (git-ignored). They exist so the whole
 * feature can be built and tested with zero cloud credentials.
 *
 * NOT FOR PRODUCTION PHI: they write to the application server's own disk, which
 * is not encrypted, backed up, or access-controlled. src/integrations/index.ts
 * warns loudly if a stub is active when NODE_ENV=production.
 */

import { mkdir, readFile, rm, stat, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { logger } from '../lib/logger.js';
import type { AiScribe, FileStorage, Messaging, SoapDraft, UploadTarget } from './types.js';

export const DEV_DATA_DIR = path.resolve(process.cwd(), '.devdata');

/** Keys are opaque ids and paths, never user text. Anything else is refused. */
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9/_.-]{0,200}$/;

function resolveKey(root: string, key: string): string {
  if (!SAFE_KEY.test(key) || key.includes('..')) throw new Error('Invalid storage key.');
  const full = path.resolve(root, key);
  if (!full.startsWith(root + path.sep)) throw new Error('Invalid storage key.'); // belt and braces vs traversal
  return full;
}

export class StubFileStorage implements FileStorage {
  private readonly root = path.join(DEV_DATA_DIR, 'storage');

  async put(key: string, body: Buffer): Promise<void> {
    const file = resolveKey(this.root, key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body);
    logger.info('stub_storage_put', { bytes: body.length });
  }
  async get(key: string): Promise<Buffer> {
    return readFile(resolveKey(this.root, key));
  }
  async delete(key: string): Promise<void> {
    await rm(resolveKey(this.root, key), { force: true });
    logger.info('stub_storage_delete');
  }
  async exists(key: string): Promise<boolean> {
    try { await stat(resolveKey(this.root, key)); return true; } catch { return false; }
  }
  async getUploadTarget(key: string, opts: { contentType: string; ttlSeconds: number }): Promise<UploadTarget> {
    resolveKey(this.root, key); // validate now rather than at upload time
    return {
      // A real adapter returns a presigned S3 URL. The stub points at a route
      // that will be added with the first feature that uploads (Phase 4).
      url: `/api/dev-storage/${key}`,
      method: 'PUT',
      headers: { 'content-type': opts.contentType },
      expiresAt: new Date(Date.now() + opts.ttlSeconds * 1000),
    };
  }
}

export class StubAiScribe implements AiScribe {
  constructor(private readonly storage: FileStorage) {}

  async transcribe({ audioKey }: { audioKey: string }): Promise<{ transcriptKey: string }> {
    if (!(await this.storage.exists(audioKey))) throw new Error('Audio not found.');
    const transcriptKey = `transcripts/${randomUUID()}.txt`;
    await this.storage.put(transcriptKey, Buffer.from('[STUB TRANSCRIPT] This is placeholder text, not a real transcription.'));
    logger.info('stub_transcribe');
    return { transcriptKey };
  }

  async draftSoap({ transcriptKey }: { transcriptKey: string }): Promise<SoapDraft> {
    await this.storage.get(transcriptKey);
    logger.info('stub_draft_soap');
    return {
      subjective: '[STUB DRAFT] Patient-reported history would appear here.',
      objective: '[STUB DRAFT] Examination findings would appear here.',
      assessment: '[STUB DRAFT] Clinical impression would appear here.',
      plan: '[STUB DRAFT] Treatment plan would appear here.',
      modelId: 'stub',
    };
  }
}

export class StubMessaging implements Messaging {
  async sendSms(input: { to: string; templateId: string; variables: Record<string, string> }): Promise<{ providerMessageId: string }> {
    const providerMessageId = `stub-${randomUUID()}`;
    // The recipient and variables go to the LOCAL outbox file so a developer can
    // see what would have been sent — never to the console/log stream.
    await mkdir(DEV_DATA_DIR, { recursive: true });
    await appendFile(
      path.join(DEV_DATA_DIR, 'sms-outbox.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), providerMessageId, ...input }) + '\n',
    );
    logger.info('stub_sms_queued', { templateId: input.templateId, providerMessageId });
    return { providerMessageId };
  }
}
