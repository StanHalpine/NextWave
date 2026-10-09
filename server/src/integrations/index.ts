/**
 * Resolves which implementation backs each interface.
 *
 * Selection is read from the IntegrationConfig table (seeded to "stub" by the
 * Phase 1 migration) so an administrator can see what is active. Non-secret
 * settings live there too; CREDENTIALS never do — they come from the
 * environment or an IAM role.
 */

import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';
import { StubAiScribe, StubFileStorage, StubMessaging } from './stubs.js';
import { NotConfiguredError, type AiScribe, type FileStorage, type IntegrationKindName, type Messaging } from './types.js';

export interface Integrations {
  storage: FileStorage;
  aiScribe: AiScribe;
  messaging: Messaging;
}

export interface IntegrationStatus {
  kind: IntegrationKindName;
  provider: string;
  enabled: boolean;
  isStub: boolean;
}

function build(kind: IntegrationKindName, provider: string, storage?: FileStorage) {
  if (provider !== 'stub') throw new NotConfiguredError(kind, provider);
  switch (kind) {
    case 'FILE_STORAGE': return new StubFileStorage();
    case 'AI_SCRIBE': return new StubAiScribe(storage ?? new StubFileStorage());
    case 'MESSAGING': return new StubMessaging();
  }
}

let cached: Integrations | null = null;
let statuses: IntegrationStatus[] = [];

export async function loadIntegrations(): Promise<Integrations> {
  const rows = await prisma.integrationConfig.findMany();
  const provider = (k: IntegrationKindName) => rows.find((r) => r.kind === k)?.provider ?? 'stub';

  const storage = build('FILE_STORAGE', provider('FILE_STORAGE')) as FileStorage;
  cached = {
    storage,
    aiScribe: build('AI_SCRIBE', provider('AI_SCRIBE'), storage) as AiScribe,
    messaging: build('MESSAGING', provider('MESSAGING')) as Messaging,
  };
  statuses = (['AI_SCRIBE', 'FILE_STORAGE', 'MESSAGING'] as const).map((kind) => ({
    kind,
    provider: provider(kind),
    enabled: rows.find((r) => r.kind === kind)?.enabled ?? true,
    isStub: provider(kind) === 'stub',
  }));

  if (config.isProduction && statuses.some((s) => s.isStub)) {
    // Phase 1 has no feature that routes PHI through these, so this is a
    // warning, not a refusal. It becomes a refusal in Phase 4, the first phase
    // that sends audio and transcripts through them.
    logger.warn('stub_integrations_in_production', { kinds: statuses.filter((s) => s.isStub).map((s) => s.kind) });
  }
  return cached;
}

export function getIntegrations(): Integrations {
  if (!cached) throw new Error('Integrations not loaded — call loadIntegrations() at startup.');
  return cached;
}

export function integrationStatuses(): IntegrationStatus[] {
  return statuses;
}
