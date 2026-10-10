import { describe, expect, it } from 'vitest';
import { credits, fmtMoney, memberDiscount, parseDollars, addDays, ageOn, fmtDay, fmtInstantTime, fmtPhone, fmtRange, fmtTime12, isoWeekday, layoutLanes, nowHHMM, serviceLabel, toMinutes, weekStart } from './lib';

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

describe('money', () => {
  it('formats cents as dollars', () => {
    expect(fmtMoney(5500)).toBe('$55.00');
    expect(fmtMoney(5500, { whole: true })).toBe('$55');
    expect(fmtMoney(5505, { whole: true })).toBe('$55.05');
    expect(fmtMoney(9)).toBe('$0.09');
    expect(fmtMoney(0)).toBe('$0.00');
    expect(fmtMoney(123456789)).toBe('$1,234,567.89');
    expect(fmtMoney(-250)).toBe('-$2.50');
    expect(fmtMoney(null)).toBe('—');
  });

  it('reads an amount typed at the desk, and refuses anything else', () => {
    expect(parseDollars('55')).toBe(5500);
    expect(parseDollars('55.5')).toBe(5550);
    expect(parseDollars(' $1,234.05 ')).toBe(123405);
    expect(parseDollars('0.07')).toBe(7);
    for (const bad of ['', '0', '0.00', '-5', '5.555', 'abc', '5 dollars', '1e3', '.5']) expect(parseDollars(bad), bad).toBeNull();
  });

  it('pluralises credits', () => {
    expect(credits(1)).toBe('1 credit');
    expect(credits(0)).toBe('0 credits');
    expect(credits(6)).toBe('6 credits');
  });
});

describe('memberDiscount', () => {
  // The same table as server/tests/checkout.test.ts: the browser shows a figure the server will recompute.
  it.each([
    [5500, 10, 550, 4950], [5500, 0, 0, 5500], [5500, 100, 5500, 0], [1999, 15, 300, 1699], [1999, 20, 400, 1599],
    [5, 10, 1, 4], [4, 10, 0, 4], [1, 49, 0, 1], [1, 50, 1, 0], [18500, 20, 3700, 14800], [0, 20, 0, 0],
  ])('%i cents at %i%% takes off %i, leaving %i', (list, pct, off, net) => {
    expect(memberDiscount(list, pct)).toEqual({ discountCents: off, netCents: net });
  });
});
