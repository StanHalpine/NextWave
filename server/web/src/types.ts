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

// ---- Phase 3: credits, memberships, check-out ----------------------------------------------------

export interface PlanLite { code: string; name: string; priceCents: number; creditsPerMonth: number; rolloverDays: number }
export interface MembershipView {
  id: string; status: 'ACTIVE' | 'PAUSED' | 'CANCELLED'; startedOn: string; nextGrantOn: string; plan: PlanLite;
}
export interface LotView {
  id: string; grantedOn: string; period: string | null; expiresOn: string; source: 'MONTHLY_GRANT' | 'ADJUSTMENT';
  granted: number; redeemed: number; removed: number; expired: number; remaining: number; status: 'ACTIVE' | 'LAPSED' | 'USED' | 'EXPIRED';
}
export interface PerkView {
  perkId: string; label: string; period: 'MONTHLY' | 'QUARTERLY' | 'ANNUAL'; quantity: number; used: number; remaining: number;
  periodKey: string; services: string[]; usedAtCheckout: boolean;
}
export interface LedgerEntry {
  id: string; at: string; date: string; reason: 'MONTHLY_GRANT' | 'ADJUSTMENT' | 'REDEMPTION' | 'EXPIRATION'; delta: number;
  lotExpiresOn: string | null; reasonCode: string | null; by: string | null; service: string | null; runningTotal: number;
}
export interface CreditsView {
  membership: MembershipView | null; balance: number; expiringSoon: { on: string; credits: number } | null; today: string;
  lots: LotView[]; perks: PerkView[]; history: { entries: LedgerEntry[]; nextBefore: string | null };
}

export interface CheckoutPreview {
  alreadyCheckedOut: boolean;
  service: { id: string; name: string; category: string; subOption: string | null };
  listPriceCents: number | null; priceNote: string | null; creditCost: number | null;
  patient: { id: string; name: string } | null;
  membership: { planCode: string; planName: string; status: string } | null;
  balance: number | null;
  credits: { available: boolean; cost: number | null; balanceAfter: number | null; reason: string | null };
  perks: Array<{ perkId: string; label: string; remaining: number; period: string }>;
  cash: { priceCents: number | null; priceKnown: boolean };
}
export interface CheckoutResult {
  paymentType: 'MEMBER' | 'CASH'; memberBenefit: 'CREDITS' | 'PERK' | null; priceCents: number | null; creditsRedeemed: number;
  cashDueCents: number; balanceBefore: number | null; balanceAfter: number | null; perkLabel: string | null; planName: string | null;
  alreadyCheckedOut: boolean;
}

export const ADJUSTMENT_REASON_LABEL: Record<string, string> = {
  correction: 'Correction (a mistake on the ledger)',
  goodwill: 'Goodwill',
  opening_balance: 'Opening balance (existing member)',
  lost_credits: 'Credits lost in error',
  other: 'Other',
};
