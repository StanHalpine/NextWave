/**
 * The development stand-in for an S3 presigned PUT: where the browser uploads a visit recording
 * when FileStorage is the local stub.
 *
 * Authority is the URL's own signature (integrations/uploadToken.ts), exactly as with S3: the
 * browser sends no cookie and no custom header, and the server issued the URL to an authenticated
 * provider for ONE key, ONE content type and a short time. Beyond the signature the key must belong
 * to a recording that is still waiting for its audio.
 *
 * Absent entirely (404) unless the active storage is the stub, and in production unless
 * ALLOW_STUB_INTEGRATIONS says this is a staging deployment with fake patients.
 */

import express, { Router } from 'express';
import { config } from '../config.js';
import { integrationStatuses, getIntegrations } from '../integrations/index.js';
import { verifyUpload } from '../integrations/uploadToken.js';
import { audit } from '../lib/audit.js';
import { MAX_AUDIO_BYTES, audioExtension } from '../lib/scribe.js';
import { basePrisma } from '../lib/prismaBase.js';

export const devStorageRouter = Router();

devStorageRouter.put('/dev-storage/*', express.raw({ type: () => true, limit: MAX_AUDIO_BYTES }), async (req, res) => {
  const stub = integrationStatuses().find((s) => s.kind === 'FILE_STORAGE')?.isStub === true;
  if (!stub || (config.isProduction && !config.allowStubIntegrations)) return res.status(404).json({ error: 'Not found.' });

  const key = String((req.params as Record<string, string>)[0] ?? '');
  const contentType = req.get('content-type') ?? '';
  const exp = Number(req.query.exp);
  const sig = typeof req.query.sig === 'string' ? req.query.sig : '';
  if (!verifyUpload(key, contentType, exp, sig)) return res.status(403).json({ error: 'This upload link is not valid or has expired.', code: 'bad_signature' });
  if (!audioExtension(contentType)) return res.status(400).json({ error: 'Unsupported recording format.', code: 'bad_audio_type' });

  const session = await basePrisma.scribeSession.findUnique({ where: { audioKey: key } });
  if (!session || session.status !== 'RECORDING') return res.status(404).json({ error: 'Not found.' });
  const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (bytes.length === 0) return res.status(400).json({ error: 'The recording is empty.', code: 'empty' });

  await getIntegrations().storage.put(key, bytes, { contentType });
  audit.record({ action: 'CREATE', resourceType: 'scribe_audio', resourceId: session.id, meta: { bytes: bytes.length, via: 'signed_upload_url', account: session.startedByAccountId } });
  res.status(200).json({ ok: true, bytes: bytes.length });
});
