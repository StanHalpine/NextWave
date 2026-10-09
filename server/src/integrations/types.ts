/**
 * Service interfaces for everything that leaves this application's boundary.
 *
 * The rest of the codebase depends on THESE, never on a vendor SDK, so that
 * (a) development and tests run with no cloud credentials, (b) a vendor can be
 * swapped without touching feature code, and (c) every place PHI could leave
 * the system is a short, reviewable list.
 *
 * Phase 1 ships interfaces and local stubs only. Real adapters are written in
 * the phase that first needs them, against real credentials and a signed BAA.
 *
 * Contract for implementers and for stubs: NEVER log a key's contents, a phone
 * number, a message body, a transcript, or a template variable. Log opaque ids
 * and sizes only.
 */

/** Object storage for audio recordings and documents (S3 in production). */
export interface FileStorage {
  put(key: string, body: Buffer, opts?: { contentType?: string }): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /**
   * Where a browser should upload directly (a presigned PUT in S3). The stub
   * returns a path on this server instead.
   */
  getUploadTarget(key: string, opts: { contentType: string; ttlSeconds: number }): Promise<UploadTarget>;
}

export interface UploadTarget {
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface SoapDraft {
  subjective: string;
  objective: string;
  assessment: string;
  plan: string;
  /** Which model produced it — recorded so a note can be traced to its source. */
  modelId: string;
}

/**
 * Speech-to-text (AWS Transcribe Medical) and note drafting (AWS Bedrock,
 * Claude). A draft is NEVER a signed note: a provider must review, edit and
 * sign it, and the UI marks it as AI-generated until they do.
 */
export interface AiScribe {
  /** Transcribe audio already in FileStorage; returns the key of the transcript. */
  transcribe(input: { audioKey: string }): Promise<{ transcriptKey: string }>;
  /** Draft S/O/A/P from a stored transcript. */
  draftSoap(input: { transcriptKey: string }): Promise<SoapDraft>;
}

/** Outbound SMS/voice (Twilio). Twilio is used for messaging ONLY — not storage, not notes. */
export interface Messaging {
  sendSms(input: {
    /** E.164 recipient. Never logged. */
    to: string;
    /** Which pre-approved template; the only thing safe to log. */
    templateId: string;
    /** Values substituted into the template. Never logged. */
    variables: Record<string, string>;
  }): Promise<{ providerMessageId: string }>;
}

export type IntegrationKindName = 'AI_SCRIBE' | 'FILE_STORAGE' | 'MESSAGING';

export class NotConfiguredError extends Error {
  constructor(kind: string, provider: string) {
    super(`${kind} provider "${provider}" is not implemented yet — only "stub" exists in Phase 1.`);
    this.name = 'NotConfiguredError';
  }
}
