-- Defense in depth: turn Row Level Security ON for every table, with NO policies.
--
-- Supabase flags a table in the exposed schema with RLS off (rls_disabled_in_public). This app does not use Supabase's Data API
-- (it is disabled), so nothing connects as the API roles (anon / authenticated); with RLS on and no policy those roles can read and
-- write nothing, should the Data API ever be switched on by mistake.
--
-- The app is unaffected: it connects as the table OWNER (the `postgres` role on Supabase), and an owner bypasses RLS unless a table
-- is also FORCEd, which this does not do. The migration runs as that same role. No policy is created on purpose: an RLS-enabled
-- table with no policy is "deny all" to every role that does not bypass it.
--
-- Idempotent: ENABLE ROW LEVEL SECURITY on a table that already has it changes nothing. It covers every ordinary table in the schema
-- this migration runs in (current_schema(), so a throwaway test schema is covered too, not just `public`). A table created by a LATER
-- migration is not covered by this one: enable RLS in that migration (new tables: `ALTER TABLE "X" ENABLE ROW LEVEL SECURITY;`).
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', current_schema(), t.relname);
  END LOOP;
END
$$;
