/**
 * Appointment text templates.
 *
 * THE RULE (from the owner): a text may contain the patient's FIRST NAME, the
 * appointment DATE and the appointment TIME — and nothing else about their care.
 * No service names, no provider names, no room, no clinical context. A text sits
 * on a lock screen and in a carrier's records; the less it says, the less it can leak.
 *
 * The rule is enforced here in code rather than left to whoever writes the next
 * template:
 *   • templates are plain functions of exactly three fields, so there is no way to
 *     interpolate a fourth;
 *   • renderTemplate() REJECTS any variable outside that set instead of ignoring
 *     it, so an attempt to pass `service` fails loudly in development;
 *   • values are sanitised, so a first name cannot smuggle a link or a number in.
 *
 * The practice name is included so the message is identifiable (and carrier
 * registration requires brand identification). It is the one fixed string beyond
 * the three fields; whether to keep it is the owner's call — see PHASE2_NOTES.
 */

export const ALLOWED_VARIABLES = ['firstName', 'date', 'time'] as const;
export type TemplateVariables = Record<(typeof ALLOWED_VARIABLES)[number], string>;

const BRAND = 'NextWave Wellness';

export const TEMPLATES = {
  appt_confirmation_v1: (v: TemplateVariables) =>
    `${BRAND}: Hi ${v.firstName}, your appointment on ${v.date} at ${v.time} is confirmed. Reply STOP to opt out.`,
  appt_reminder_24h_v1: (v: TemplateVariables) =>
    `${BRAND}: Hi ${v.firstName}, a reminder of your appointment on ${v.date} at ${v.time}. Reply STOP to opt out.`,
} as const;

export type TemplateId = keyof typeof TEMPLATES;

/** Letters (any script), combining marks, space, apostrophes, hyphen, period — nothing that can be a link or a number. */
export function sanitizeFirstName(raw: string): string {
  const cleaned = raw.normalize('NFC').replace(/[^\p{L}\p{M} '’.-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 30);
  return cleaned || 'there';
}

export class TemplateError extends Error {}

export function renderTemplate(id: string, variables: Record<string, string>): string {
  const template = (TEMPLATES as Record<string, (v: TemplateVariables) => string>)[id];
  if (!template) throw new TemplateError(`Unknown message template "${id}".`);

  const keys = Object.keys(variables).sort();
  const allowed = [...ALLOWED_VARIABLES].sort();
  if (keys.length !== allowed.length || keys.some((k, i) => k !== allowed[i])) {
    // Also catches a MISSING field, and — the case that matters — an EXTRA one.
    throw new TemplateError(`A text may carry exactly ${allowed.join(', ')}; got ${keys.join(', ') || 'nothing'}.`);
  }
  for (const k of allowed) {
    const v = variables[k];
    if (typeof v !== 'string' || v.length === 0 || v.length > 40 || /[\r\n\u0000-\u001f]/.test(v)) {
      throw new TemplateError(`Invalid value for "${k}".`);
    }
  }
  return template(variables as TemplateVariables);
}
