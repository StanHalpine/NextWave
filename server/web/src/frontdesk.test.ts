import { describe, expect, it } from 'vitest';
import { deskActions, visitStateLabel, type DeskAction } from './frontdesk';
import type { Appt, EncounterStatus } from './types';

function appt(enc: EncounterStatus | null, over: Partial<Appt> = {}, linked = true): Appt {
  return {
    id: 'b1', status: 'CONFIRMED', source: 'ONLINE', start: '', end: '', localDate: '2026-10-12', localStart: '10:00', localEnd: '10:30', bufferMin: 0,
    service: { id: 's', name: 'Manual Adjustment', color: '#000', category: 'Chiropractic', documentationType: 'SOAP' }, subOption: null,
    staff: null, resource: { id: 'r', name: 'Room' },
    patient: { id: linked ? 'p1' : null, name: 'Pat', linked, smsOptIn: false, texts: null },
    patientConfirmedAt: null,
    encounter: enc ? { id: 'e1', status: enc, checkedInAt: null, checkedOutAt: null } : null,
    documentation: { status: 'NONE', signedAt: null },
    ...over,
  } as Appt;
}

const today = { isToday: true, nowMin: 11 * 60 };
const names = (a: DeskAction[]) => a.map((x) => (x.kind === 'verb' ? x.verb : x.kind));

describe('what the front desk can do, by where the visit is', () => {
  it('a visit that has not arrived: check in, and no-show once its time has passed', () => {
    expect(names(deskActions(appt(null), today))).toEqual(['check-in', 'no-show']);
    expect(names(deskActions(appt('SCHEDULED'), today))).toEqual(['check-in', 'no-show']);
    expect(names(deskActions(appt(null), { isToday: true, nowMin: 9 * 60 }))).toEqual(['check-in']);        // 10:00 has not come yet
    expect(names(deskActions(appt(null), { isToday: true, nowMin: 10 * 60 }))).toContain('no-show');       // the start itself counts
  });

  it('checked in: check out (primary) and undo check-in', () => {
    const a = deskActions(appt('CHECKED_IN'), today);
    expect(names(a)).toEqual(['check-out', 'undo-check-in']);
    expect(a[0]).toMatchObject({ kind: 'check-out', primary: true });
  });

  it('SEEN — the provider has signed — can be CHECKED OUT, and is not treated as finished', () => {
    const a = deskActions(appt('SEEN'), today);
    expect(names(a)).toEqual(['check-out']);
    expect(a[0]).toMatchObject({ kind: 'check-out', primary: true });
    expect(deskActions(appt('SEEN'), { isToday: false, nowMin: null })).toHaveLength(1);                   // a missed check-out can be done another day
  });

  it('with the provider: check out; the server allows no undo from here, so none is offered', () => {
    expect(names(deskActions(appt('IN_PROGRESS'), today))).toEqual(['check-out']);
  });

  it('checked out: nothing more to do', () => {
    expect(deskActions(appt('CHECKED_OUT'), today)).toEqual([]);
  });

  it('a no-show can still be checked in if they turn up', () => {
    const [x] = deskActions(appt('NO_SHOW'), today);
    expect(x).toMatchObject({ kind: 'verb', verb: 'check-in', label: 'They arrived — check in', primary: false, disabled: false });
  });

  it('an unlinked patient is offered the link first, and cannot be checked in until it is made', () => {
    const a = deskActions(appt(null, {}, false), today);
    expect(names(a)).toEqual(['link', 'check-in', 'no-show']);
    expect(a[1]).toMatchObject({ disabled: true, why: 'Link a patient record first' });
  });

  it('check-in is for today only — shown, but disabled with the reason, on another day', () => {
    const [x] = deskActions(appt(null), { isToday: false, nowMin: null });
    expect(x).toMatchObject({ verb: 'check-in', disabled: true, why: 'Check-in is for today only' });
    expect(names(deskActions(appt(null), { isToday: false, nowMin: null }))).not.toContain('no-show');
  });

  it('an appointment that is not confirmed has no desk actions at all', () => {
    for (const status of ['PENDING_REVIEW', 'CANCELLED', 'DECLINED', 'HOLD'] as const) expect(deskActions(appt(null, { status }), today), status).toEqual([]);
  });
});

describe('the words for where a visit is', () => {
  it('never calls a SEEN visit done: it says it needs check-out; only a checked-out visit reads as finished', () => {
    expect(visitStateLabel(appt('SEEN'))).toBe('Seen — needs check-out');
    expect(visitStateLabel(appt('CHECKED_OUT'))).toBe('Checked out');
    for (const e of ['SCHEDULED', 'CHECKED_IN', 'IN_PROGRESS', 'SEEN', 'CHECKED_OUT', 'NO_SHOW'] as const) expect(visitStateLabel(appt(e)) ?? '', e).not.toMatch(/done/i);
  });
});
