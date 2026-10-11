/**
 * Binding a JavaScript Date into HAND-WRITTEN SQL ($queryRaw / $executeRaw).
 *
 * Every DateTime column in schema.prisma is `timestamp(3) WITHOUT time zone`, holding UTC. Prisma's own query API knows
 * that. Raw SQL does not: a bare `${date}` goes over the wire as a timestamptz, and Postgres compares it with (or
 * stores it into) a timestamp column by reading the column in the SESSION's time zone. On a database whose time zone is
 * not UTC every comparison is off by the UTC offset — five hours at this clinic, which moves an event one minute before
 * a month end into the next month — and an INSERT stores local time where UTC belongs. On a UTC database it happens to
 * work, which is how it goes unnoticed.
 *
 * `utcTimestamp(d)` sends the instant as an ISO string cast to ::timestamp, which Postgres reads as the UTC wall time it
 * spells, whatever the session zone. Use it for every Date in raw SQL against a timestamp column.
 * (A `date` column, or a plain "YYYY-MM-DD" string cast ::date, has no zone and needs none of this.)
 */

import { Prisma } from '@prisma/client';

export const utcTimestamp = (d: Date): Prisma.Sql => Prisma.sql`${d.toISOString()}::timestamp`;
