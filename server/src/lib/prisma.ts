import type { PrismaClient } from '@prisma/client';
import { basePrisma } from './prismaBase.js';
import { auditExtension } from './auditExtension.js';

/**
 * The application's database client: the raw client plus write-auditing.
 *
 * Typed as plain `PrismaClient` on purpose. The extension adds no models, no
 * result fields and no client methods — it only observes writes — so the type
 * is accurate, and every existing call site (including the booking code, which
 * must not be edited) keeps compiling and behaving exactly as before.
 */
export const prisma = basePrisma.$extends(auditExtension) as unknown as PrismaClient;

export { basePrisma };
