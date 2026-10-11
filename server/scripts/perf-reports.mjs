// Time every Accounting and Reports query against ~50,000 encounters, in a throwaway Postgres SCHEMA.
//
//   npm run perf:reports                 50,000 encounters
//   PERF_ENCOUNTERS=200000 npm run perf:reports
//
// Creates a schema, migrates and seeds it, bulk-loads the visits (scripts/perf-reports.ts), prints timings and the
// query plans, and drops the schema. Nothing is read from or written to the real tables, and the connection string
// is derived in-process (scripts/with-schema.mjs) and never printed.
import { spawnSync } from 'node:child_process';

const name = `nw_perf_${process.pid}`;
const withSchema = (args, { quiet } = {}) => {
  const r = spawnSync('node', ['scripts/with-schema.mjs', ...args], { stdio: quiet ? 'pipe' : 'inherit', encoding: 'utf8' });
  if (r.status !== 0) {
    // Prisma prints a "Datasource" line naming the host; keep it out of anything we show.
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.split('\n').filter((l) => !/^Datasource /i.test(l) && !/postgres(ql)?:\/\//i.test(l)).join('\n');
    console.error(out.slice(-2000));
    throw new Error(`step failed: ${args.slice(0, 3).join(' ')}`);
  }
};

try {
  withSchema(['create', name], { quiet: true });
  withSchema(['run', name, '--', 'npx', 'prisma', 'migrate', 'deploy'], { quiet: true });
  withSchema(['run', name, '--', 'npx', 'tsx', 'prisma/seed.ts'], { quiet: true });
  withSchema(['run', name, '--', 'npx', 'tsx', 'scripts/perf-reports.ts']);
} finally {
  try { withSchema(['drop', name], { quiet: true }); } catch { /* the name is unique per run */ }
}
