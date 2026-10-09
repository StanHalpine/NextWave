import type { Prisma } from '@prisma/client';
import { colorHexFor } from './serviceColors.js';
import { toLocalDateISO, toLocalHHMM } from './time.js';

/** Everything an appointment card or calendar block needs, in one query shape. */
export const APPT_INCLUDE = {
  service: { select: { id: true, name: true, color: true, category: true, bufferMin: true, durationMin: true, documentationType: true } },
  staff: { select: { id: true, name: true } },
  resource: { select: { id: true, name: true } },
  user: { select: { name: true } },
  patient: { select: { id: true, firstName: true, lastName: true, preferredName: true, smsOptIn: true } },
  encounter: { select: { id: true, status: true, checkedInAt: true, seenAt: true, checkedOutAt: true, noShowAt: true } },
} satisfies Prisma.BookingInclude;

export type ApptRow = Prisma.BookingGetPayload<{ include: typeof APPT_INCLUDE }>;

/**
 * JSON for one appointment. Times are given in CLINIC time as well as ISO, so the
 * browser never has to guess the clinic's zone (a laptop set to another time zone
 * must still draw the 10:00 appointment at 10:00).
 */
export function appointmentView(b: ApptRow) {
  const linked = b.patient;
  return {
    id: b.id,
    status: b.status,
    source: b.source,
    start: b.startTime.toISOString(),
    end: b.endTime.toISOString(),
    localDate: toLocalDateISO(b.startTime),
    localStart: toLocalHHMM(b.startTime),
    localEnd: toLocalHHMM(b.endTime),
    bufferMin: b.service.bufferMin,
    service: { id: b.service.id, name: b.service.name, color: colorHexFor(b.service.color), category: b.service.category, documentationType: b.service.documentationType },
    subOption: b.subOption,
    staff: b.staff,
    resource: b.resource,
    // The linked patient when there is one; otherwise the contact the booking was made under.
    patient: {
      id: linked?.id ?? null,
      name: linked ? `${linked.firstName} ${linked.lastName}` : b.user.name,
      linked: !!linked,
      smsOptIn: linked?.smsOptIn ?? false,
      /** Where consent to texts comes from, if anywhere: the patient's record (staff-recorded) or this booking's own checkbox. */
      texts: linked?.smsOptIn ? ('patient' as const) : b.smsConsentAt ? ('online' as const) : null,
    },
    patientConfirmedAt: b.patientConfirmedAt,
    encounter: b.encounter
      ? { id: b.encounter.id, status: b.encounter.status, checkedInAt: b.encounter.checkedInAt, checkedOutAt: b.encounter.checkedOutAt }
      : null,
  };
}
