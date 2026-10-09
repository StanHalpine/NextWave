import { describe, expect, it } from 'vitest';
import { addDays, ageOn, fmtDay, fmtInstantTime, fmtPhone, fmtRange, fmtTime12, isoWeekday, layoutLanes, nowHHMM, serviceLabel, toMinutes, weekStart } from './lib';

describe('times', () => {
  it('formats 24h clinic times as 12h', () => {
    expect(fmtTime12('00:00')).toBe('12:00 AM');
    expect(fmtTime12('07:05')).toBe('7:05 AM');
    expect(fmtTime12('12:00')).toBe('12:00 PM');
    expect(fmtTime12('13:30')).toBe('1:30 PM');
    expect(fmtTime12('23:59')).toBe('11:59 PM');
    expect(toMinutes('13:30')).toBe(810);
  });

  it('shows an instant in the clinic zone, not the browser zone', () => {
    expect(fmtInstantTime('2026-10-13T15:00:00Z', 'America/Chicago')).toBe('10:00 AM');   // CDT
    expect(fmtInstantTime('2026-11-03T16:00:00Z', 'America/Chicago')).toBe('10:00 AM');   // CST
    expect(fmtInstantTime('2026-10-13T15:00:00Z', 'America/Los_Angeles')).toBe('8:00 AM');
    expect(nowHHMM('America/Chicago', new Date('2026-10-13T15:07:00Z'))).toBe('10:07');
    expect(nowHHMM('America/Chicago', new Date('2026-10-13T05:00:00Z'))).toBe('00:00');
  });
});

describe('dates', () => {
  it('does day arithmetic on date strings, across month, year and DST boundaries', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-11-01', 1)).toBe('2026-11-02');   // the fall-back Sunday
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
  });

  it('knows weekdays and week starts (Monday)', () => {
    expect(isoWeekday('2026-10-12')).toBe(1);
    expect(isoWeekday('2026-10-13')).toBe(2);
    expect(isoWeekday('2026-10-18')).toBe(7);
    expect(weekStart('2026-10-13')).toBe('2026-10-12');
    expect(weekStart('2026-10-12')).toBe('2026-10-12');
    expect(weekStart('2026-10-18')).toBe('2026-10-12');
    expect(fmtDay('2026-10-13')).toBe('Tue Oct 13');
    expect(fmtRange('2026-10-12', '2026-10-18')).toBe('Oct 12 – Oct 18, 2026');
  });

  it('computes age and formats phones', () => {
    expect(ageOn('1984-03-09', '2026-03-08')).toBe(41);
    expect(ageOn('1984-03-09', '2026-03-09')).toBe(42);
    expect(fmtPhone('6125550142')).toBe('(612) 555-0142');
    expect(fmtPhone('1-612-555-0142')).toBe('(612) 555-0142');
    expect(fmtPhone('call the office')).toBe('call the office');
  });
});

describe('layoutLanes', () => {
  const lanes = (xs: Array<[number, number]>) => layoutLanes(xs.map(([startMin, endMin]) => ({ startMin, endMin })));

  it('gives a lone event the full width', () => {
    expect(lanes([[600, 630]])).toEqual([{ lane: 0, lanes: 1 }]);
  });

  it('does not share a lane between events that merely touch', () => {
    expect(lanes([[600, 630], [630, 660]])).toEqual([{ lane: 0, lanes: 1 }, { lane: 0, lanes: 1 }]);
  });

  it('puts overlapping events side by side and sizes the whole cluster alike', () => {
    expect(lanes([[600, 660], [615, 645], [630, 700]])).toEqual([
      { lane: 0, lanes: 3 }, { lane: 1, lanes: 3 }, { lane: 2, lanes: 3 },
    ]);
  });

  it('reuses a freed lane inside a cluster and starts fresh after a gap', () => {
    const r = lanes([[600, 630], [610, 700], [630, 660], [800, 830]]);
    expect(r[0]).toEqual({ lane: 0, lanes: 2 });
    expect(r[1]).toEqual({ lane: 1, lanes: 2 });
    expect(r[2]).toEqual({ lane: 0, lanes: 2 });   // takes the lane the 10:00 event freed
    expect(r[3]).toEqual({ lane: 0, lanes: 1 });
  });

  it('is independent of input order', () => {
    const a = lanes([[615, 645], [600, 660]]);
    expect(a[1]).toEqual({ lane: 0, lanes: 2 });
    expect(a[0]).toEqual({ lane: 1, lanes: 2 });
  });
});

describe('serviceLabel', () => {
  it('adds the duration once, never twice', () => {
    expect(serviceLabel({ name: 'IV Therapy', durationMin: 60 })).toBe('IV Therapy (60 min)');
    expect(serviceLabel({ name: 'Hyperbaric Oxygen Therapy (60 min)', durationMin: 60 })).toBe('Hyperbaric Oxygen Therapy (60 min)');
    expect(serviceLabel({ name: 'Hyperbaric Oxygen Therapy (90 min)', durationMin: 90 })).toBe('Hyperbaric Oxygen Therapy (90 min)');
  });
});
