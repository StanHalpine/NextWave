/** Shapes the Phase 2 staff API returns. Times are ISO instants; `local*` fields are clinic time. */
import type { NoteStatus } from './notes';

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
  /** The scheduled provider (the booking's; the calendar column). */
  staff: { id: string; name: string } | null;
  /** Rev 2.1: the covering provider, when someone other than the scheduled one is seeing the patient — the visit's provider. */
  covering: { id: string; name: string } | null;
  resource: { id: string; name: string };
  patient: { id: string | null; name: string; linked: boolean; smsOptIn: boolean; /** where consent to texts comes from */ texts: 'patient' | 'online' | null };
  patientConfirmedAt: string | null;
  encounter: { id: string; status: EncounterStatus; checkedInAt: string | null; checkedOutAt: string | null } | null;
  /** Whether the provider's note exists and is signed — never its text. */
  documentation: { status: DocStatus; signedAt: string | null };
  /** Rev 2.0: whether this visit needs a note and has it; null before check-in. Never holds up check-out. */
  note: NoteStatus | null;
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

export interface PlanLite { code: string; name: string; priceCents: number; creditsPerMonth: number; rolloverDays: number; /** What this tier takes off cash prices, by service category (only those switched on). */ discounts: Array<{ category: string; percent: number }> }
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
  cash: {
    /** The list price. */
    priceCents: number | null; priceKnown: boolean;
    /** The member discount that applies to a cash payment (0 for a non-member, a paused member, or a service in no discounted category). */
    discountPercent: number; discountCategory: string | null; discountCents: number | null; netPriceCents: number | null;
    /** Rev 2.2: the tier percent before the better-of rule, the promotion that applies instead (never both), every promotion this
     *  visit qualifies for (so a typed price is priced the same way), and the most the front desk may adjust it by. */
    tierPercent: number;
    promotion: { id: string; name: string; cents: number } | null;
    promotions: Array<{ id: string; name: string; kind: 'PERCENT' | 'FIXED_CENTS'; value: number }>;
    adjustmentCapCents: number | null;
  };
}
export interface CheckoutResult {
  paymentType: 'MEMBER' | 'CASH'; memberBenefit: 'CREDITS' | 'PERK' | null; creditsRedeemed: number;
  listPriceCents: number | null; discountPercent: number; discountCents: number; netPriceCents: number;
  balanceBefore: number | null; balanceAfter: number | null; perkLabel: string | null; planName: string | null;
  alreadyCheckedOut: boolean;
}

export const ADJUSTMENT_REASON_LABEL: Record<string, string> = {
  correction: 'Correction (a mistake on the ledger)',
  goodwill: 'Goodwill',
  opening_balance: 'Opening balance (existing member)',
  lost_credits: 'Credits lost in error',
  other: 'Other',
};


// ---- Phase 4: provider queue, documentation, scribe, macros --------------------------------------------

export type DocStatus = 'NONE' | 'DRAFT' | 'SIGNED';
export type DocType = 'SOAP' | 'SESSION_LOG';
export type ProviderRole = 'PROVIDER_CHIRO' | 'PROVIDER_NP' | 'PROVIDER_NURSE';
export type Section = 'subjective' | 'objective' | 'assessment' | 'plan';
export type NoteSection = 'SUBJECTIVE' | 'OBJECTIVE' | 'ASSESSMENT' | 'PLAN' | 'GENERAL';

export interface QueueRow {
  bookingId: string; start: string; localDate: string; localStart: string; localEnd: string;
  service: { id: string; name: string; color: string; documentationType: DocType };
  subOption: string | null;
  patient: { id: string | null; name: string };
  staff: { id: string; name: string } | null;
  covering: { id: string; name: string } | null;
  isMine: boolean; unassigned: boolean; mayDocument: boolean;
  encounter: { status: EncounterStatus; checkedInAt: string | null; startedAt: string | null; seenAt: string | null; checkedOutAt: string | null };
  documentation: { status: DocStatus; type: DocType; signedAt: string | null; signedBy: string | null; draftUpdatedAt: string | null };
  note: NoteStatus;
  waitingMinutes: number | null;
}
export interface ProviderQueue {
  role: ProviderRole; roleLabel: string; today: string; rows: QueueRow[]; backlog: QueueRow[]; pending: number;
  roles: Array<{ role: ProviderRole; own: boolean }>;
  /** The signed-in provider's own Unsigned notes, counted (null with no provider record). */
  unsignedNotes: { count: number; overdue: number; thresholdHours: number } | null;
}

export interface NoteVersion { id: string; body: string; durationMin: number | null; author: { id: string; name: string; role: string }; createdAt: string; amendReason: string | null }
export interface Addendum { id: string; noteId: string; body: string; author: { name: string; role: string }; createdAt: string }
export interface SignedNote {
  id: string; kind: NoteSection; body: string; durationMin: number | null; author: { id: string; name: string; role: string };
  createdAt: string; amended: boolean; history: NoteVersion[];
  /** The viewer is the provider who signed it: only they may amend. */
  canAmend: boolean;
  /** Notes other providers have added to it. They never change. */
  addenda: Addendum[];
}
export interface ScribeSessionView { id: string; status: 'RECORDING' | 'UPLOADED' | 'TRANSCRIBING' | 'DRAFTING' | 'READY' | 'FAILED'; failureCode: string | null; createdAt: string; applied: boolean; hasDraft: boolean; audioPurged: boolean }
export interface Workspace {
  booking: {
    id: string; localDate: string; localStart: string; localEnd: string;
    service: { id: string; name: string; documentationType: DocType }; subOption: string | null; patientNote: string | null;
    patient: { id: string | null; name: string };
    /** The visit's provider (covering, else scheduled) — the only one who may write and sign. */
    provider: { id: string; name: string } | null;
    scheduledProvider: { id: string; name: string } | null;
    covering: boolean;
  };
  encounter: { status: EncounterStatus; checkedInAt: string | null; startedAt: string | null; seenAt: string | null; checkedOutAt: string | null; scribeConsentAt: string | null } | null;
  access: {
    canWrite: boolean; role: ProviderRole | null; /** The provider record a signature will carry. */ signsAs: string | null; readOnlyReason: string | null;
    /** Holds a provider role, so may add an addendum to any signed note. */ canAddend: boolean;
    /** An administrator, and the note was signed by someone other than the visit's provider. */ canConfirmCovering: boolean;
  };
  documentation: { status: DocStatus; type: DocType };
  note: NoteStatus | null;
  draft: { version: number; subjective: string; objective: string; assessment: string; plan: string; notes: string; durationMin: number | null; aiDrafted: boolean; aiAppliedAt: string | null; updatedAt: string } | null;
  signature: { signedAt: string; signedBy: string | null; signedRole: string; aiAssisted: boolean; aiDraftUnchanged: boolean | null; afterCheckout: boolean | null; signerIsVisitProvider: boolean; amended: boolean } | null;
  notes: SignedNote[];
  scribe: { applicable: boolean; available: boolean; unavailableReason: string | null; consentAt: string | null; audioRetentionDays: number; sessions: ScribeSessionView[] };
}

export interface MacroLite { id: string; section: NoteSection; title: string; body: string; sortOrder: number }
export interface MacroLibrary { personal: { macros: MacroLite[] }; shared: Array<{ id: string; name: string; macros: MacroLite[] }> }
export interface MacroSetAdmin { id: string; name: string; roles: ProviderRole[]; active: boolean; macros: MacroLite[] }

// ---- Accounting and Reports (Phase 5) ------------------------------------------------------------------------------
export interface ReportColumn { key: string; label: string; kind: 'text' | 'int' | 'money' | 'percent' }
export type ReportRow = Record<string, string | number>;
/** Membership dues billed, apart from the service revenue (Accounting views only). */
export interface ReportDues {
  columns: ReportColumn[];
  rows: ReportRow[];
  totals: ReportRow;
  /** Why it is empty, or what it means, when the rows do not say. */
  note: string | null;
}
export interface ReportData {
  view: string;
  title: string;
  range: { from: string; to: string };
  filters: Record<string, string>;
  columns: ReportColumn[];
  rows: ReportRow[];
  /** Rows between the body and the totals (e.g. all members / non-members). */
  subtotals: ReportRow[];
  /** Null where adding the rows up would mean nothing (the review list shows a subtotal per kind instead). */
  totals: ReportRow | null;
  dues: ReportDues | null;
  summary: Record<string, number> | null;
  notes: string[];
}
export interface AccountingOptions {
  services: Array<{ id: string; name: string }>;
  providers: Array<{ id: string; name: string }>;
  paymentTypes: Array<{ value: 'CASH' | 'MEMBER'; label: string }>;
  groups: string[];
  views: Array<{ key: string; title: string }>;
}
