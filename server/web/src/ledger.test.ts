import { describe, expect, it } from 'vitest';
import { canCheckOut, LEDGER_REFRESH_MS, notesPendingNote, paidWithLabel, pendingNote, stateLabel, type LedgerVisit, type PatientLedger, type VisitState } from './ledger';
import type { NoteStatus } from './notes';

const v = (state: VisitState, note: NoteStatus | null = null) => ({ state, note }) as LedgerVisit;
const pending = (over: Partial<PatientLedger['todayTotals']['pending']> = {}) =>
  ({ visits: 2, readyToCheckOut: 2, notArrived: 0, listPriceCents: 11000, discountCents: 0, cashNetCents: 11000, unpricedVisits: 0, ...over });

describe('the ledger screen\'s rules and words', () => {
  it('refreshes every 10 seconds', () => expect(LEDGER_REFRESH_MS).toBe(10_000));

  // Rev 2.0 (was: "only a SEEN visit can be checked out from the ledger — a visit waiting on its provider cannot"): the note no longer gates it.
  it('any visit the patient is checked in for can be checked out from the ledger, whatever its note', () => {
    for (const note of ['PENDING', 'SIGNED', 'NOT_REQUIRED'] as const) expect(canCheckOut(v('ready_to_check_out', note)), note).toBe(true);
    for (const s of ['not_arrived', 'no_show', 'checked_out'] as const) expect(canCheckOut(v(s)), s).toBe(false);
  });

  // Rev 2.0 (was: "says who a waiting visit is waiting on"): there is no waiting state any more; the note has its own pill.
  it('names where a visit is, and never says it is waiting on the provider', () => {
    expect(stateLabel(v('ready_to_check_out', 'PENDING'))).toBe('Ready to check out');
    expect(stateLabel(v('checked_out'))).toBe('Checked out');
    expect(stateLabel(v('not_arrived'))).toBe('Not arrived');
    expect(stateLabel(v('no_show'))).toBe('No-show');
  });

  it('tells the desk how many notes are still to come, and that they hold nothing up', () => {
    expect(notesPendingNote(0)).toBeNull();
    expect(notesPendingNote(1)).toBe('1 note is still to be signed by the provider. That does not hold up check-out.');
    expect(notesPendingNote(3)).toMatch(/^3 notes are still to be signed/);
  });

  it('names how a recorded visit was charged — "Money", never "paid": payments are their own entries (rev 2.2)', () => {
    expect([paidWithLabel('CASH'), paidWithLabel('CREDITS'), paidWithLabel('PERK'), paidWithLabel(null)]).toEqual(['Money', 'Membership credits', 'Member perk', '']);
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
