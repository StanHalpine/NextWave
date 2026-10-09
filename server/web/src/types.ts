/** Shapes the Phase 2 staff API returns. Times are ISO instants; `local*` fields are clinic time. */

export type EncounterStatus = 'SCHEDULED' | 'CHECKED_IN' | 'IN_PROGRESS' | 'SEEN' | 'CHECKED_OUT' | 'NO_SHOW';
export type BookingStatus = 'HOLD' | 'PENDING_REVIEW' | 'CONFIRMED' | 'CANCELLED' | 'DECLINED';
export type BookingSource = 'ONLINE' | 'PHONE' | 'WALK_IN' | 'FRONT_DESK';

export interface Appt {
  id: string;
  status: BookingStatus;
  source: BookingSource;
  start: string;
  end: string;
  localDate: string;
  localStart: string;   // "HH:MM" 24h, clinic time
  localEnd: string;
  bufferMin: number;
  service: { id: string; name: string; color: string; category: string; documentationType: 'SOAP' | 'SESSION_LOG' };
  subOption: string | null;
  staff: { id: string; name: string } | null;
  resource: { id: string; name: string };
  patient: { id: string | null; name: string; linked: boolean; smsOptIn: boolean; /** where consent to texts comes from */ texts: 'patient' | 'online' | null };
  patientConfirmedAt: string | null;
  encounter: { id: string; status: EncounterStatus; checkedInAt: string | null; checkedOutAt: string | null } | null;
}

export interface Dashboard {
  date: string; today: string; isToday: boolean; timezone: string; now: string;
  pendingReview: number;
  scheduled: Appt[]; checkedIn: Appt[]; done: Appt[]; noShows: Appt[];
}

export interface CalendarDay { date: string; open: string | null; close: string | null; closed: boolean }
export interface CalendarStaff { id: string; name: string; role: string; shifts: Record<string, Array<{ start: string; end: string }>> }
export interface Calendar {
  timezone: string; today: string;
  days: CalendarDay[]; staff: CalendarStaff[];
  rooms: Array<{ id: string; name: string; type: string }>;
  appointments: Appt[];
}

export interface PatientSummary {
  id: string; name: string; preferredName: string | null; phone: string; email: string | null;
  dateOfBirth: string | null; smsOptIn: boolean;
}

export interface Patient {
  id: string; firstName: string; lastName: string; preferredName: string | null;
  dateOfBirth: string | null; sex: string | null; phone: string; email: string | null;
  addressLine1: string | null; addressLine2: string | null; city: string | null; state: string | null; postalCode: string | null;
  emergencyName: string | null; emergencyPhone: string | null; emergencyRelation: string | null;
  preferredContact: 'PHONE' | 'SMS' | 'EMAIL';
  smsOptIn: boolean; smsOptInAt: string | null;
  frontDeskNote: string | null;
  createdAt: string; updatedAt: string;
}

export interface ServiceLite {
  id: string; slug: string; name: string; category: string; durationMin: number;
  options: Array<{ label: string; priceCents: number | null }>;
}

export interface SlotLite { start: string; localTime: string; staffIds: string[]; resourceIds: string[] }

export interface Visit {
  id: string; status: BookingStatus; start: string; end: string; service: string; subOption: string | null;
  provider: string | null; source: BookingSource; encounterStatus: EncounterStatus | null;
}

export const CANCEL_REASON_LABEL: Record<string, string> = {
  patient_request: 'Patient asked to cancel',
  provider_unavailable: 'Provider unavailable',
  rescheduled_elsewhere: 'Rebooked another way',
  other: 'Other reason',
};
