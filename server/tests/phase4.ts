/** Fixtures for the Phase 4 (provider queue, documentation, scribe, macros) tests. */
import type { AccountRole, DocumentationType, EncounterStatus, StaffRole } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { STAFF_ROLE_FOR, type ProviderRole } from '../src/lib/providerRoles.js';
import { makeAccount, signInFully, type Signed } from './helpers.js';
import { post, slotAt } from './phase2.js';

export { post };
export const put = (s: Signed, url: string, body: object = {}) => s.agent.put(url).set('x-csrf-token', s.csrf).send(body);

let n = 0;
const tag = () => `${Date.now().toString(36)}${(++n).toString(36)}`;

export interface Provider extends Signed { role: ProviderRole; staff: { id: string; name: string }; accountId: string; email: string }

/** A provider of the given role: a bookable Staff record, a login linked to it, signed in with the authenticator enrolled. */
export async function providerLogin(role: ProviderRole, extraRoles: AccountRole[] = []): Promise<Provider> {
  const staff = await prisma.staff.create({ data: { name: `Test ${role} ${tag()}`, role: STAFF_ROLE_FOR[role] } });
  const account = await makeAccount({ roles: [role, ...extraRoles], staffId: staff.id });
  const s = await signInFully(account.email);
  return Object.assign(s, { role, staff: { id: staff.id, name: staff.name }, accountId: account.id, email: account.email });
}

export const adminLogin = async () => signInFully((await makeAccount({ roles: ['ADMIN'] })).email);
export const frontDeskLogin = async () => signInFully((await makeAccount({ roles: ['FRONT_DESK'] })).email);

export interface VisitOpts {
  /** The staff role the visit is booked with; null = no provider assigned (a room-only service). */
  staffRole?: StaffRole | null;
  /** Book with this exact Staff record (so a provider can be "mine"). */
  staffId?: string;
  doc?: DocumentationType;
  /** Whether the service needs a signed note (rev 2.0); the column default (true) when not given. */
  requiresNote?: boolean;
  /** Encounter state; null = no encounter at all. */
  encounter?: EncounterStatus | null;
  start?: Date;
  checkedInAt?: Date;
  patientId?: string | null;
  contactName?: string;
  bookingStatus?: 'CONFIRMED' | 'CANCELLED' | 'PENDING_REVIEW';
  patientNote?: string;
}

/** A visit with its own service (so the documentation type is whatever the test says), room and, optionally, provider. */
export async function visit(o: VisitOpts = {}) {
  const t = tag();
  const service = await prisma.service.create({
    data: {
      slug: `t4-${t}`, category: 'Chiropractic', name: `T4 Service ${t}`, durationMin: 30, bufferMin: 0, color: 'chiro_saddle', documentationType: o.doc ?? 'SOAP',
      ...(o.requiresNote !== undefined ? { requiresNote: o.requiresNote } : {}),
    },
  });
  const room = await prisma.resource.create({ data: { name: `T4 Room ${t}`, type: 'TEST_ROOM', maxCapacity: 1 } });
  let staffId: string | null = o.staffId ?? null;
  if (!staffId && o.staffRole !== null) {
    staffId = (await prisma.staff.create({ data: { name: `T4 Staff ${t}`, role: o.staffRole ?? 'CHIROPRACTOR' } })).id;
  }
  const user = await prisma.user.create({ data: { name: o.contactName ?? `Contact ${t}`, email: '', phone: '6125550000' } });
  const start = o.start ?? slotAt('10:00');
  const booking = await prisma.booking.create({
    data: {
      userId: user.id, serviceId: service.id, resourceId: room.id, staffId, startTime: start, endTime: new Date(start.getTime() + 30 * 60_000),
      status: o.bookingStatus ?? 'CONFIRMED', source: 'FRONT_DESK', patientId: o.patientId ?? null, patientNote: o.patientNote ?? null,
    },
  });
  const status = o.encounter === undefined ? 'CHECKED_IN' : o.encounter;
  const encounter = status
    ? await prisma.encounter.create({
      data: {
        bookingId: booking.id, status,
        checkedInAt: status === 'SCHEDULED' || status === 'NO_SHOW' ? null : (o.checkedInAt ?? new Date(start.getTime() - 5 * 60_000)),
      },
    })
    : null;
  return { booking, encounter, service, staffId, user };
}

export const URL = {
  queue: (role?: string) => `/api/provider/queue${role ? `?role=${role}` : ''}`,
  ws: (id: string) => `/api/provider/visits/${id}/documentation`,
  start: (id: string) => `/api/provider/visits/${id}/start`,
  draft: (id: string) => `/api/provider/visits/${id}/draft`,
  sign: (id: string) => `/api/provider/visits/${id}/sign`,
  consent: (id: string) => `/api/provider/visits/${id}/scribe/consent`,
  sessions: (id: string) => `/api/provider/visits/${id}/scribe/sessions`,
  session: (id: string, sid: string, tail = '') => `/api/provider/visits/${id}/scribe/sessions/${sid}${tail}`,
};

export const SOAP = {
  subjective: 'Test subjective text.', objective: 'Test objective text.', assessment: 'Test assessment text.', plan: 'Test plan text.',
};

/** Save a complete SOAP draft and return its version. */
export async function saveSoap(p: Signed, bookingId: string, fields: Partial<typeof SOAP> = {}, version?: number) {
  const r = await put(p, URL.draft(bookingId), { ...SOAP, ...fields, ...(version !== undefined ? { version } : {}) });
  if (r.status !== 200) throw new Error(`saveSoap failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.version as number;
}
