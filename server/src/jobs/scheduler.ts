/**
 * Scheduled jobs: one place that knows what runs, and an optional in-process timer.
 *
 * Two ways to run them — pick ONE per deployment (running both is safe, because every
 * job is idempotent, but pointless):
 *
 *   • an external scheduler (cron, a Render cron job, an EventBridge rule) running
 *     `npm run jobs:run` every few minutes. Right for production: it keeps running when
 *     the web process is asleep or being redeployed.
 *   • JOBS_IN_PROCESS=true: the web process runs them itself on a timer. Fine for one
 *     always-on instance; useless on a host that sleeps the web service (nothing runs
 *     while it sleeps, so no text goes out).
 */

import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { runAsSystem } from '../lib/audit.js';
import { getIntegrations, integrationStatuses } from '../integrations/index.js';
import { runAppointmentTexts, type TextRunResult } from './appointmentTexts.js';
import { runCreditExpiry, runMembershipGrants, type ExpiryRunResult, type GrantRunResult } from './credits.js';

export interface JobsRunResult {
  appointmentTexts: TextRunResult | { disabled: true };
  /** Always runs — credits are not a messaging feature. null = the job itself failed (logged). */
  membershipGrants: GrantRunResult | null;
  creditExpiry: ExpiryRunResult | null;
}

/** Run every job once. Never throws. */
export async function runAllJobsOnce(): Promise<JobsRunResult> {
  const messagingOn = integrationStatuses().find((s) => s.kind === 'MESSAGING')?.enabled !== false;
  let appointmentTexts: JobsRunResult['appointmentTexts'] = { disabled: true };
  if (messagingOn) {
    try {
      appointmentTexts = await runAsSystem('appointment-texts', () =>
        runAppointmentTexts({ messaging: getIntegrations().messaging }));
    } catch (err) {
      logger.error('job_failed', err, { job: 'appointment-texts' });
    }
  }
  // Grants first, then expiry: a fresh grant is never expired in the same pass, and each is its own
  // failure domain — one job failing is logged and never stops the others.
  const guarded = async <T>(job: string, fn: () => Promise<T>): Promise<T | null> => {
    try { return await runAsSystem(job, fn); } catch (err) { logger.error('job_failed', err, { job }); return null; }
  };
  const membershipGrants = await guarded('membership-grants', () => runMembershipGrants());
  const creditExpiry = await guarded('credit-expiry', () => runCreditExpiry());

  logger.info('jobs_ran', { appointmentTexts, membershipGrants, creditExpiry });
  return { appointmentTexts, membershipGrants, creditExpiry };
}

/** Start the in-process timer. Returns a stop function. */
export function startInProcessScheduler(): () => void {
  let running = false;
  const tick = async () => {
    if (running) return; // a slow run must not overlap the next one
    running = true;
    try { await runAllJobsOnce(); } finally { running = false; }
  };
  const timer = setInterval(tick, config.jobsIntervalMin * 60_000);
  timer.unref();
  void tick();
  logger.info('scheduler_started', { everyMinutes: config.jobsIntervalMin });
  return () => clearInterval(timer);
}
