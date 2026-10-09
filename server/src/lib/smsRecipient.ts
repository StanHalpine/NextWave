/**
 * Who a text about a booking may go to — decided in one place.
 *
 * Two kinds of consent exist, and either is enough:
 *   • the PATIENT's, recorded by staff on their profile (Patient.smsOptIn / smsOptInAt), used when
 *     the booking is linked to a patient; the text goes to the patient's phone;
 *   • the BOOKING's, ticked on the public widget by the person who made it (Booking.smsConsentAt),
 *     used even when nobody has linked the booking to a patient; the text goes to the phone they
 *     typed into the booking form.
 * Either is overridden by a number on the do-not-text list unless the consent is newer than the STOP.
 */
import { toE164, canonicalDigits } from './phone.js';
import { sanitizeFirstName } from '../integrations/templates.js';

export interface PatientForText {
  id: string; firstName: string; preferredName: string | null; phone: string;
  smsOptIn: boolean; smsOptInAt: Date | null; deletedAt: Date | null;
}
export interface BookingForText {
  patientId: string | null;
  smsConsentAt: Date | null;
  patient: PatientForText | null;
  user: { name: string; phone: string };
}
export interface Recipient { to: string; digits: string; first: string; patientId: string | null; via: 'patient' | 'booking' }

export const SELECT_PATIENT_FOR_TEXT = { id: true, firstName: true, preferredName: true, phone: true, smsOptIn: true, smsOptInAt: true, deletedAt: true } as const;

/** The numbers a booking could be texted on (digits), for loading their suppressions in one query. */
export function candidateDigits(b: BookingForText): string[] {
  return [b.patient?.phone, b.user.phone].filter((p): p is string => !!p && toE164(p) !== null).map(canonicalDigits);
}

const firstTokenOf = (name: string) => sanitizeFirstName(name.trim().split(/\s+/)[0] ?? '');

/** null = nobody to text (no consent, no usable number, or the number said STOP after consenting). */
export function resolveRecipient(b: BookingForText, suppressed: Map<string, Date>): Recipient | null {
  const options: Array<{ phone: string; consentAt: Date; first: string; via: Recipient['via'] }> = [];
  const p = b.patient;
  if (p && !p.deletedAt && p.smsOptIn && toE164(p.phone)) {
    options.push({ phone: p.phone, consentAt: p.smsOptInAt ?? new Date(0), first: sanitizeFirstName(p.preferredName || p.firstName), via: 'patient' });
  }
  if (b.smsConsentAt && toE164(b.user.phone)) {
    options.push({ phone: b.user.phone, consentAt: b.smsConsentAt, first: p && !p.deletedAt ? sanitizeFirstName(p.preferredName || p.firstName) : firstTokenOf(b.user.name), via: 'booking' });
  }
  for (const o of options) {
    const digits = canonicalDigits(o.phone);
    const stopped = suppressed.get(digits);
    if (stopped && stopped.getTime() >= o.consentAt.getTime()) continue;
    return { to: toE164(o.phone)!, digits, first: o.first, patientId: b.patientId, via: o.via };
  }
  return null;
}
