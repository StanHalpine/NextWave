/**
 * Run every scheduled job once and exit. Point an external scheduler at this:
 *
 *     npm run jobs:run          (every 5 minutes is plenty)
 *
 * Needs the same environment as the web app (DATABASE_URL, and the messaging
 * provider once one is configured). Exit code is 0 unless the process cannot reach
 * the database at all — an individual job failing is logged, not fatal, so one bad
 * job never stops the others from running next time.
 */
import { loadIntegrations } from '../src/integrations/index.js';
import { runAllJobsOnce } from '../src/jobs/scheduler.js';
import { prisma } from '../src/lib/prisma.js';
import { logger } from '../src/lib/logger.js';

async function main() {
  await loadIntegrations();
  await runAllJobsOnce();
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    logger.error('jobs_run_failed', err);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
  });
