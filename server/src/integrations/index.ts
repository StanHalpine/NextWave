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
    // The app still starts (the rest of it holds no stub-backed PHI), but the one feature that sends
    // audio and transcripts through these — the AI scribe — switches itself off; see scribeAvailability().
    logger.warn('stub_integrations_in_production', {
      kinds: statuses.filter((s) => s.isStub).map((s) => s.kind),
      scribeAvailable: scribeAvailability().available,
    });
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

export type ScribeUnavailable = 'integration_disabled' | 'stub_in_production';

/**
 * Whether the AI scribe may be used right now. It needs both FileStorage and AiScribe enabled; and in
 * production it needs both to be REAL adapters (the stubs keep audio on the server's own disk), unless
 * ALLOW_STUB_INTEGRATIONS says this is a staging deployment with fake patients.
 */
export function scribeAvailability(): { available: boolean; reason: ScribeUnavailable | null } {
  const need = statuses.filter((s) => s.kind === 'FILE_STORAGE' || s.kind === 'AI_SCRIBE');
  if (need.length < 2 || need.some((s) => !s.enabled)) return { available: false, reason: 'integration_disabled' };
  if (config.isProduction && !config.allowStubIntegrations && need.some((s) => s.isStub)) return { available: false, reason: 'stub_in_production' };
  return { available: true, reason: null };
}
