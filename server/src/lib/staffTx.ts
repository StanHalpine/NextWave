/**
 * Transaction wrapper for staff-initiated WRITES (Phase 2+).
 *
 * It uses the raw client, not the audited one, and hands the callback a `rec()`
 * that writes the audit row through the TRANSACTION'S OWN connection. Two reasons:
 *
 *   1. Atomicity. The audit row commits or rolls back with the change it
 *      describes. The client extension (used by the legacy routes) records an
 *      entry when an operation returns — even if the transaction later rolls back —
 *      so a failed move would leave an audit row for a change that never happened.
 *   2. No second connection. It is the same one the transaction already holds, so
 *      this cannot starve a small pool.
 *
 * The cost is discipline: inside these callbacks you MUST call rec() for every
 * write. tests/ checks that each new write path produces its audit rows.
 */
import type { Prisma } from '@prisma/client';
import { basePrisma } from './prismaBase.js';
import { auditInTx, type AuditInput } from './audit.js';

export type Rec = (entry: AuditInput) => Promise<void>;

export function staffTransaction<T>(fn: (tx: Prisma.TransactionClient, rec: Rec) => Promise<T>): Promise<T> {
  return basePrisma.$transaction(async (tx) => fn(tx, (entry) => auditInTx(tx, entry)), {
    timeout: 15_000,
    maxWait: 10_000,
  });
}
