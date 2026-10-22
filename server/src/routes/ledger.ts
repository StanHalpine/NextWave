/**
 * The patient ledger (front desk + admin), READ ONLY.
 *
 *   GET /api/fd/patients/:id/ledger   today's visits and what they come to, earlier visits with their amounts, credits used, dues as information
 *
 * ONE endpoint keyed by the patient and nothing else: the profile's Ledger tab, the Checked-in card's dialog and a second desk screen all call
 * exactly this, so they cannot disagree. It reads in a single consistent snapshot (lib/ledger.ts), writes nothing, posts no revenue, and
 * takes no booking id — a stray `?bookingId=` is ignored. See docs/SPEC.md §4.7 / §5.6.
 *
 * Audited as a read of the patient and of their credit ledger. The screen re-reads every 10 seconds while open, so the audit rows are written
 * once per five minutes of viewing (audit.read's listKey rule), not once per refresh.
 */

import { Router } from 'express';
import { audit } from '../lib/audit.js';
import { now } from '../lib/clock.js';
import { patientLedger } from '../lib/ledger.js';
import { requireFrontDesk } from '../middleware/frontDesk.js';

export const ledgerRouter = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

ledgerRouter.get('/fd/patients/:id/ledger', requireFrontDesk, async (req, res) => {
  const id = req.params.id ?? '';
  const ledger = UUID.test(id) ? await patientLedger(id, now()) : null;
  if (!ledger) return res.status(404).json({ error: 'Unknown patient.', code: 'not_found' });

  audit.read('patient', id, { section: 'ledger', today: ledger.todayVisits.length, prior: ledger.priorVisits.length }, `ledger:${id}`);
  audit.read('credit_ledger', id, { section: 'ledger' }, `ledger:${id}`);
  res.json(ledger);
});
