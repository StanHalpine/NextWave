import { describe, expect, it } from 'vitest';
import { basePrisma } from '../src/lib/prismaBase.js';

/**
 * Row Level Security is ON for every table, with no policies (migration 20261021100000_enable_row_level_security). Defense in depth
 * for Supabase's flag rls_disabled_in_public: the app is the table owner and bypasses it, so behaviour is unchanged — every other test
 * in this suite reading and writing these tables is the proof of that.
 */
describe('row level security', () => {
  it('is enabled on every table in the schema — a table added by a later migration must enable it too', async () => {
    const rows = await basePrisma.$queryRawUnsafe<Array<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p') ORDER BY c.relname`);
    expect(rows.length).toBeGreaterThan(30);
    expect(rows.filter((r) => !r.relrowsecurity).map((r) => r.relname)).toEqual([]);
    // not FORCEd: that would apply it to the owner (the app), which must keep bypassing it
    expect(rows.filter((r) => r.relforcerowsecurity).map((r) => r.relname)).toEqual([]);
  });

  it('has no policies: with RLS on, every role that does not bypass it can read and write nothing', async () => {
    const [{ n }] = await basePrisma.$queryRawUnsafe<[{ n: number }]>(`SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = current_schema()`);
    expect(n).toBe(0);
  });

  it('leaves the app\'s own access alone: it reads and writes through RLS as the owner', async () => {
    const [{ bypass }] = await basePrisma.$queryRawUnsafe<[{ bypass: boolean }]>(
      `SELECT (pg_has_role(current_user, c.relowner, 'USAGE')) AS bypass FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = current_schema() AND c.relname = 'Account'`);
    expect(bypass).toBe(true);
    expect(await basePrisma.account.count()).toBeGreaterThanOrEqual(0);
  });
});
