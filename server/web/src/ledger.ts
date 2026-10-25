import type { NoteStatus } from './notes';
import type { MoneyView, OpenLines } from './money';
import type { Appt } from './types';

/**
 * The patient ledger as the server sends it (lib/ledger.ts), and the words and rules the screen uses for it.
 * Read-only: there is no balance and no payment here, on purpose — see docs/SPEC.md §4.7.
 */

/** The Ledger re-reads this often while it is open. (The rest of the Front Desk keeps its 30 seconds.) */
export const LEDGER_REFRESH_MS = 10_000;

/** `ready_to_check_out` is any visit the patient is checked in for — with the provider or not, note signed or not (rev 2.0). */
export type VisitState = 'not_arrived' | 'no_show' | 'ready_to_check_out' | 'checked_out';

export interface VisitCharge {
  basis: 'recorded' | 'projected' | 'none';
  listPriceCents: number | null;
  discountPercent: number;
  discountCents: number;
  creditsApplied: number | null;
  creditCost: number | null;
  creditsAvailable: boolean | null;
  netCents: number | null;
  priceKnown: boolean;
  paidWith: 'CASH' | 'CREDITS' | 'PERK' | null;
  recordedAt: string | null;
  /** Rev 2.2: a promotion that applied instead of the tier discount (never both), and a one-off adjustment. */
  promotionCents: number;
  promotionName: string | null;
  adjustmentCents: number;
  adjustmentReason: string | null;
}

export interface LedgerVisit {
  id: string;
  appointment: Appt;
  localDate: string;
  localStart: string;
  service: string;
  subOption: string | null;
  provider: string | null;
  state: VisitState;
  /** Where the note is, apart from the visit; null before check-in. */
  note: NoteStatus | null;
  charge: VisitCharge;
}

export interface PatientLedger {
  patient: { id: string; name: string };
  asOf: string;
  today: string;
  timezone: string;
  todayVisits: LedgerVisit[];
  todayTotals: {
    recorded: { visits: number; listPriceCents: number; discountCents: number; creditsApplied: number; netCents: number };
    pending: {
      visits: number; readyToCheckOut: number; notArrived: number;
      listPriceCents: number; discountCents: number; cashNetCents: number; unpricedVisits: number;
    };
    /** Today's visits whose required note is still unsigned, checked out or not. */
    notesPending: number;
  };
  priorVisits: LedgerVisit[];
  priorVisitsMore: boolean;
  credits: {
    membership: { planName: string; status: string } | null;
    balance: number;
    expiringSoon: { on: string; credits: number } | null;
    redeemedToDate: number;
  };
  dues: Array<{ id: string; periodStart: string | null; description: string; listPriceCents: number | null; billingStatus: string | null; recordedAt: string }>;
  /** Phase 2b: what has been posted, the balance carried forward, and account credit ($). */
  money: MoneyView;
  /** Rev 2.3: add-on services and products added but not yet checked out — not in the balance until they are. */
  openCharges: OpenLines;
}

/** Any visit the patient is checked in for can be checked out from here. The note never holds it up (rev 2.0). */
export const canCheckOut = (v: LedgerVisit): boolean => v.state === 'ready_to_check_out';

export function stateLabel(v: Pick<LedgerVisit, 'state'>): string {
  switch (v.state) {
    case 'ready_to_check_out': return 'Ready to check out';
    case 'checked_out': return 'Checked out';
    case 'no_show': return 'No-show';
    default: return 'Not arrived';
  }
}

/** How a recorded visit was charged, in words. */
export function paidWithLabel(p: VisitCharge['paidWith']): string {
  // Rev 2.2: "CASH" means charged in money — paid or not is the payments' business (the Ledger's posted section), so never "paid".
  return p === 'CASH' ? 'Money' : p === 'CREDITS' ? 'Membership credits' : p === 'PERK' ? 'Member perk' : '';
}

/** A word for the desk about today's notes still to be signed — information only, since check-out does not wait for them. */
export function notesPendingNote(n: number): string | null {
  if (n === 0) return null;
  return `${n} ${n === 1 ? 'note is' : 'notes are'} still to be signed by the provider. That does not hold up check-out.`;
}

/**
 * The line under today's list: what the rest of the day comes to if each visit is paid at the desk. It says "estimate" and what is left
 * out, and never uses the word balance — nothing is charged or recorded until a visit is checked out.
 */
export function pendingNote(p: PatientLedger['todayTotals']['pending']): string | null {
  if (p.visits === 0) return null;
  const left = p.unpricedVisits > 0 ? ` ${p.unpricedVisits} ${p.unpricedVisits === 1 ? 'visit has' : 'visits have'} no set price and ${p.unpricedVisits === 1 ? 'is' : 'are'} priced at check-out.` : '';
  return `Estimate if paid at the desk — nothing is charged or recorded until each visit is checked out.${left}`;
}
