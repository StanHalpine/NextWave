import { describe, expect, it } from 'vitest';
import { frontDeskHref, readDeskParams, deskActions, visitStateLabel, type DeskAction } from './frontdesk';
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
    note: enc && enc !== 'SCHEDULED' && enc !== 'NO_SHOW' ? 'PENDING' : null,
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

  it('check-out is offered whatever the note says — pending, signed, or none needed (rev 2.0: billing and documentation are decoupled)', () => {
    for (const enc of ['CHECKED_IN', 'IN_PROGRESS', 'SEEN'] as const) {
      for (const note of ['PENDING', 'SIGNED', 'NOT_REQUIRED'] as const) {
        const a = deskActions(appt(enc, { note }), today);
        expect(a[0], `${enc} / ${note}`).toMatchObject({ kind: 'check-out', primary: true });
      }
    }
    expect(deskActions(appt('CHECKED_OUT', { note: 'PENDING' }), today)).toEqual([]);           // a pending note does not reopen a checked-out visit
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

describe('rev 2.4.x: the Front Desk URL — /front-desk?date=YYYY-MM-DD&appt=<id>', () => {
  const ID = '0b9d3c1e-5f2a-4c6b-9e8d-7a1b2c3d4e5f';
  it('carries the appointment\'s own clinic day and its id; no date means today', () => {
    expect(frontDeskHref({ date: '2026-11-01', appt: ID })).toBe(`/front-desk?date=2026-11-01&appt=${ID}`);
    expect(frontDeskHref({ date: '2026-10-23' })).toBe('/front-desk?date=2026-10-23');
    expect(frontDeskHref()).toBe('/front-desk');
  });
  it('reads back what it wrote, so a refresh or a shared link lands in the same place', () => {
    const href = frontDeskHref({ date: '2027-03-14', appt: ID });
    expect(readDeskParams(new URLSearchParams(href.split('?')[1]))).toEqual({ date: '2027-03-14', appt: ID });
    expect(readDeskParams(new URLSearchParams(''))).toEqual({ date: undefined, appt: null });
  });
  it('ignores a malformed or impossible date, and an appt that is not an id — never trusted', () => {
    for (const d of ['2026-02-30', '2026-13-01', '26-10-23', '2026-10-23T05:00', 'today', '']) {
      expect(readDeskParams(new URLSearchParams({ date: d, appt: ID })).date, d).toBeUndefined();
    }
    for (const a of ['x', '1', `${ID}x`, '<script>', '']) expect(readDeskParams(new URLSearchParams({ appt: a })).appt, a).toBeNull();
    expect(readDeskParams(new URLSearchParams({ date: '2028-02-29' })).date).toBe('2028-02-29');   // a real leap day
  });
});
