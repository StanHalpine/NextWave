import { describe, expect, it } from 'vitest';
import { basePrisma } from '../src/lib/prismaBase.js';
import { utcTimestamp } from '../src/lib/sqlTime.js';

/**
 * Every DateTime column is a UTC `timestamp without time zone`. These run the same comparisons and inserts under
 * session zones on both sides of UTC, so they say the same thing whatever zone the test database defaults to.
 */
const ZONES = ['UTC', 'America/Los_Angeles', 'America/Chicago', 'Pacific/Auckland'];
const inZone = <T>(zone: string, fn: (tx: Parameters<Parameters<typeof basePrisma.$transaction>[0]>[0]) => Promise<T>) =>
  basePrisma.$transaction(async (tx) => { await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${zone}'`); return fn(tx); });

describe('utcTimestamp', () => {
  it.each(ZONES)('compares an instant with a timestamp column as the UTC time it spells (session zone %s)', async (zone) => {
    const edge = new Date('2033-06-01T05:00:00.000Z');     // midnight at the clinic on 1 June (CDT)
    const row = await inZone(zone, (tx) => tx.$queryRaw<Array<{ before: boolean; at: boolean; after: boolean }>>`
      SELECT (TIMESTAMP '2033-06-01 04:59:00' < ${utcTimestamp(edge)}) AS before,
             (TIMESTAMP '2033-06-01 05:00:00' = ${utcTimestamp(edge)}) AS at,
             (TIMESTAMP '2033-06-01 05:01:00' < ${utcTimestamp(edge)}) AS after`);
    expect(row[0]).toEqual({ before: true, at: true, after: false });
  });

  it.each(ZONES)('stores an instant into a timestamp column as UTC (session zone %s)', async (zone) => {
    const at = new Date('2033-06-01T04:59:00.000Z');
    const stored = await inZone(zone, async (tx) => {
      await tx.$executeRawUnsafe('CREATE TEMP TABLE nw_tz_probe (at timestamp(3)) ON COMMIT DROP');
      await tx.$executeRaw`INSERT INTO nw_tz_probe (at) VALUES (${utcTimestamp(at)})`;
      return tx.$queryRawUnsafe<Array<{ at: string }>>(`SELECT at::text AS at FROM nw_tz_probe`);
    });
    expect(stored[0]!.at).toBe('2033-06-01 04:59:00');
  });

  it('exists because a bare Date is read in the session zone — on a zone other than UTC the same comparison flips', async () => {
    const edge = new Date('2033-06-01T05:00:00.000Z');
    const bare = (zone: string) => inZone(zone, (tx) => tx.$queryRaw<Array<{ before: boolean }>>`SELECT (TIMESTAMP '2033-06-01 04:59:00' < ${edge}) AS before`).then((r) => r[0]!.before);
    expect(await bare('UTC')).toBe(true);
    expect(await bare('America/Chicago')).toBe(false);          // 04:59 "Chicago time" is 09:59Z, after the edge
  });
});
