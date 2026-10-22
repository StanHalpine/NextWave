import { describe, expect, it } from 'vitest';
import { canCheckOut, LEDGER_REFRESH_MS, paidWithLabel, pendingNote, stateLabel, type LedgerVisit, type PatientLedger, type VisitState } from './ledger';

const v = (state: VisitState, waitingOn: string | null = null) => ({ state, waitingOn }) as LedgerVisit;
const pending = (over: Partial<PatientLedger['todayTotals']['pending']> = {}) =>
  ({ visits: 2, readyToCheckOut: 1, waitingOnProvider: 1, notArrived: 0, listPriceCents: 11000, discountCents: 0, cashNetCents: 11000, unpricedVisits: 0, ...over });

describe('the ledger screen\'s rules and words', () => {
  it('refreshes every 10 seconds', () => expect(LEDGER_REFRESH_MS).toBe(10_000));

  it('only a SEEN visit can be checked out from the ledger — a visit waiting on its provider cannot', () => {
    expect(canCheckOut(v('ready_to_check_out'))).toBe(true);
    for (const s of ['waiting_on_provider', 'not_arrived', 'no_show', 'checked_out'] as const) expect(canCheckOut(v(s)), s).toBe(false);
  });

  it('says who a waiting visit is waiting on', () => {
    expect(stateLabel(v('waiting_on_provider', 'Dr. Chase'))).toBe('Waiting on provider: Dr. Chase');
    expect(stateLabel(v('waiting_on_provider'))).toBe('Waiting on provider: not assigned');
    expect(stateLabel(v('ready_to_check_out'))).toBe('Ready to check out');
    expect(stateLabel(v('checked_out'))).toBe('Checked out');
    expect(stateLabel(v('not_arrived'))).toBe('Not arrived');
    expect(stateLabel(v('no_show'))).toBe('No-show');
  });

  it('names how a recorded visit was paid', () => {
    expect([paidWithLabel('CASH'), paidWithLabel('CREDITS'), paidWithLabel('PERK'), paidWithLabel(null)]).toEqual(['At the desk', 'Credits', 'Member perk', '']);
  });

  it('calls the sum an estimate, says nothing is charged by looking, and never says balance', () => {
    const t = pendingNote(pending())!;
    expect(t).toMatch(/^Estimate if paid at the desk/);
    expect(t).toMatch(/nothing is charged or recorded until each visit is checked out/);
    expect(t.toLowerCase()).not.toMatch(/balance|owe|outstanding/);
    expect(pendingNote(pending({ visits: 0 }))).toBeNull();
    expect(pendingNote(pending({ unpricedVisits: 1 }))).toMatch(/1 visit has no set price and is priced at check-out/);
    expect(pendingNote(pending({ unpricedVisits: 2 }))).toMatch(/2 visits have no set price and are priced at check-out/);
  });
});
