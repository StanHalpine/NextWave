import type { Appt } from './types';

/**
 * The patient ledger as the server sends it (lib/ledger.ts), and the words and rules the screen uses for it.
 * Read-only: there is no balance and no payment here, on purpose — see docs/SPEC.md §4.7.
 */

/** The Ledger re-reads this often while it is open. (The rest of the Front Desk keeps its 30 seconds.) */
export const LEDGER_REFRESH_MS = 10_000;

export type VisitState = 'not_arrived' | 'no_show' | 'waiting_on_provider' | 'ready_to_check_out' | 'checked_out';

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
  waitingOn: string | null;
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
      visits: number; readyToCheckOut: number; waitingOnProvider: number; notArrived: number;
      listPriceCents: number; discountCents: number; cashNetCents: number; unpricedVisits: number;
    };
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
}

/** Only a visit the provider has SEEN (the note is signed) can be checked out from here. */
export const canCheckOut = (v: LedgerVisit): boolean => v.state === 'ready_to_check_out';

export function stateLabel(v: Pick<LedgerVisit, 'state' | 'waitingOn'>): string {
  switch (v.state) {
    case 'ready_to_check_out': return 'Ready to check out';
    case 'waiting_on_provider': return `Waiting on provider: ${v.waitingOn ?? 'not assigned'}`;
    case 'checked_out': return 'Checked out';
    case 'no_show': return 'No-show';
    default: return 'Not arrived';
  }
}

/** How a recorded visit was paid, in words. */
export function paidWithLabel(p: VisitCharge['paidWith']): string {
  return p === 'CASH' ? 'At the desk' : p === 'CREDITS' ? 'Credits' : p === 'PERK' ? 'Member perk' : '';
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
