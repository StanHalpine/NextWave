/**
 * ALL outbound text wording lives in this file — and nowhere else. It is the one place to
 * copy from when filling in the A2P campaign form (a generated, always-current copy is
 * docs/SMS_TEMPLATES.md; `npm run sms:templates` rewrites it, and a test fails if it is stale).
 *
 * THE RULE (from the owner): a text may contain the patient's FIRST NAME, the appointment
 * DAY and the appointment TIME — and nothing else about their care. No service names, no
 * provider names, no room, no clinical context. A text sits on a lock screen and in a
 * carrier's records; the less it says, the less it can leak.
 *
 * The rule is enforced in code rather than left to whoever writes the next template:
 *   • a template is plain text with {placeholders}; the allowed placeholders are listed in
 *     ALLOWED_VARIABLES, and this module REFUSES TO LOAD if any template uses another;
 *   • renderTemplate() REJECTS a variable the template does not use, and a missing one,
 *     instead of ignoring it — so an attempt to pass `service` fails loudly;
 *   • values are sanitised, so a first name cannot smuggle a link or a number in.
 *
 * Replies to a patient's own inbound message (STOP, START, HELP, C) are held to the same rule;
 * the only extra placeholder they may carry is the CLINIC's phone number, which is not
 * patient data.
 */

/** What a patient-facing text may say about the patient and the visit — nothing more. */
export const ALLOWED_VARIABLES = ['first', 'day', 'time'] as const;
/** Clinic facts (not patient data) that a reply may carry. */
const CLINIC_VARIABLES = ['phone'] as const;

export type TemplateVariable = (typeof ALLOWED_VARIABLES)[number] | (typeof CLINIC_VARIABLES)[number];

interface Def {
  /** The exact text, with {placeholders}. Handed to the A2P campaign form verbatim. */
  text: string;
  /** When it is sent — for the campaign form and the generated doc. */
  when: string;
}

/** Sent by the appointment-texts job (src/jobs/appointmentTexts.ts). */
export const TEMPLATES = {
  appt_confirmation_v2: {
    when: 'When an appointment is confirmed, to a patient who consented to texts',
    text: "NextWave Wellness: Hi {first}, you're confirmed for {day} at {time}. Reply C to confirm or call us to change. Reply STOP to opt out.",
  },
  appt_reminder_24h_v3: {
    when: 'The day before the appointment (within 24 hours of it), to a patient who consented to texts',
    text: 'NextWave Wellness: Reminder for {first}: see you tomorrow at {time}. Reply STOP to opt out.',
  },
} as const satisfies Record<string, Def>;

/** Automatic answers to a patient's own inbound text (src/routes/smsInbound.ts). */
export const REPLIES = {
  reply_stop_v2: {
    when: 'Once, when a patient texts STOP (not repeated if they text it again)',
    text: "NextWave Wellness: You're unsubscribed from appointment texts. Reply START to resubscribe.",
  },
  reply_start_v2: {
    when: 'When a patient who had opted out texts START',
    text: "NextWave Wellness: You're resubscribed to appointment texts. Reply STOP to opt out.",
  },
  reply_help_v2: {
    when: 'When a patient texts HELP (also the answer to "C" when the patient has no upcoming appointment)',
    text: 'NextWave Wellness: This number sends appointment texts only. Call {phone} for help. Reply STOP to opt out.',
  },
  reply_confirmed_v2: {
    when: 'When a patient replies C to a confirmation text',
    text: 'NextWave Wellness: Thanks {first}, your appointment is confirmed.',
  },
} as const satisfies Record<string, Def>;

/**
 * The words next to the checkbox on the public booking widget. The widget renders the label it
 * is given by the server and sends it back; the server stores exactly that string with the
 * time (Booking.smsConsentAt / smsConsentLabel), and refuses anything that is not one of these.
 * If the wording ever changes, ADD the new text here and keep the old one in ACCEPTED so a
 * page that was already open still records what its patient actually saw.
 */
export const SMS_CONSENT_LABEL = 'Text me appointment confirmations and reminders. Msg & data rates may apply. Reply STOP to opt out.';
export const ACCEPTED_SMS_CONSENT_LABELS: readonly string[] = [SMS_CONSENT_LABEL];

/** The inbound keywords the webhook acts on. Whole-message, case-insensitive (carrier rules). */
export const KEYWORDS = {
  STOP: ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'],
  START: ['START', 'UNSTOP'],
  HELP: ['HELP', 'INFO'],
  CONFIRM: ['C'],
} as const;

export type TemplateId = keyof typeof TEMPLATES;
export type ReplyId = keyof typeof REPLIES;
export type AnyTemplateId = TemplateId | ReplyId;

const ALL: Record<string, Def> = { ...TEMPLATES, ...REPLIES };

const PLACEHOLDER = /\{([a-z]+)\}/g;
export function placeholdersOf(id: string): string[] {
  const def = ALL[id];
  if (!def) throw new TemplateError(`Unknown message template "${id}".`);
  return [...new Set([...def.text.matchAll(PLACEHOLDER)].map((m) => m[1]!))].sort();
}

/** Letters (any script), combining marks, space, apostrophes, hyphen, period — nothing that can be a link or a number. */
export function sanitizeFirstName(raw: string): string {
  const cleaned = raw.normalize('NFC').replace(/[^\p{L}\p{M} '’.-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 30);
  return cleaned || 'there';
}

export class TemplateError extends Error {}

// ---- the rule, enforced at load time ------------------------------------------------------
for (const [id, def] of Object.entries(TEMPLATES)) {
  for (const v of [...def.text.matchAll(PLACEHOLDER)].map((m) => m[1]!)) {
    if (!(ALLOWED_VARIABLES as readonly string[]).includes(v)) {
      throw new TemplateError(`Template ${id} uses {${v}}; a patient-facing text may only use ${ALLOWED_VARIABLES.join(', ')}.`);
    }
  }
}
for (const [id, def] of Object.entries(REPLIES)) {
  for (const v of [...def.text.matchAll(PLACEHOLDER)].map((m) => m[1]!)) {
    if (![...ALLOWED_VARIABLES, ...CLINIC_VARIABLES].includes(v as TemplateVariable)) {
      throw new TemplateError(`Reply ${id} uses {${v}}; allowed: ${[...ALLOWED_VARIABLES, ...CLINIC_VARIABLES].join(', ')}.`);
    }
  }
}

const VALUE_OK = /^[^\r\n\u0000-\u001f]{1,40}$/;

/** The text with its placeholders filled in. Throws unless EXACTLY the template's own variables are given. */
export function renderTemplate(id: string, variables: Record<string, string>): string {
  const def = ALL[id];
  if (!def) throw new TemplateError(`Unknown message template "${id}".`);

  const wanted = placeholdersOf(id);
  const given = Object.keys(variables).sort();
  if (wanted.length !== given.length || wanted.some((k, i) => k !== given[i])) {
    // Catches a MISSING field and — the case that matters — an EXTRA one.
    throw new TemplateError(`${id} takes exactly ${wanted.join(', ') || 'no variables'}; got ${given.join(', ') || 'nothing'}.`);
  }
  for (const k of wanted) {
    const v = variables[k];
    if (typeof v !== 'string' || !VALUE_OK.test(v)) throw new TemplateError(`Invalid value for "${k}".`);
  }
  return def.text.replace(PLACEHOLDER, (_m, k: string) => variables[k]!);
}

/** Every message, for the generated campaign document. */
export function allMessages(): Array<{ id: string; kind: 'outbound' | 'reply'; when: string; text: string; variables: string[] }> {
  return [
    ...Object.entries(TEMPLATES).map(([id, d]) => ({ id, kind: 'outbound' as const, when: d.when, text: d.text, variables: placeholdersOf(id) })),
    ...Object.entries(REPLIES).map(([id, d]) => ({ id, kind: 'reply' as const, when: d.when, text: d.text, variables: placeholdersOf(id) })),
  ];
}
