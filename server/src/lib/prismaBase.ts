import { PrismaClient } from '@prisma/client';

/**
 * The raw client. Almost nothing should import this directly — use `prisma`
 * from ./prisma.js, which adds auditing. The two legitimate users are the audit
 * flush itself (it must not audit its own writes) and tests.
 */
export const basePrisma = new PrismaClient({ log: ['warn', 'error'] });
