import { z } from 'zod';
import type { Patient, Prisma } from '@prisma/client';
import { isValidUsPhone, phoneDigits } from './phone.js';

const text = (max: number) =>
  z.string().trim().max(max).transform((v) => (v === '' ? null : v)).nullable().optional();

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.').refine((v) => {
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v) && v >= '1900-01-01' && d.getTime() <= Date.now();
}, 'Enter a real date of birth.');

/** What the front desk may record about a patient. Deliberately no SSN, insurance or card data. */
export const patientFields = z.object({
  firstName: z.string().trim().min(1, 'First name is required.').max(80),
  lastName: z.string().trim().min(1, 'Last name is required.').max(80),
  preferredName: text(80),
  dateOfBirth: isoDate.nullable().optional(),
  sex: text(20),
  phone: z.string().trim().refine(isValidUsPhone, 'Enter a 10-digit US phone number.'),
  email: z.string().trim().toLowerCase().email('Enter a valid email.').max(254).or(z.literal('')).transform((v) => (v === '' ? null : v)).nullable().optional(),
  addressLine1: text(120),
  addressLine2: text(120),
  city: text(80),
  state: text(40),
  postalCode: text(20),
  emergencyName: text(120),
  emergencyPhone: text(40),
  emergencyRelation: text(60),
  preferredContact: z.enum(['PHONE', 'SMS', 'EMAIL']).optional(),
  frontDeskNote: text(500),
}).strict();

export type PatientInput = z.infer<typeof patientFields>;

/** Map validated input to database columns (normalising the derived ones). */
export function toPatientData(input: Partial<PatientInput>): Prisma.PatientUncheckedUpdateInput {
  const { dateOfBirth, phone, ...rest } = input;
  const data: Prisma.PatientUncheckedUpdateInput = { ...rest };
  if (dateOfBirth !== undefined) data.dateOfBirth = dateOfBirth ? new Date(`${dateOfBirth}T00:00:00Z`) : null;
  if (phone !== undefined) { data.phone = phone; data.phoneDigits = phoneDigits(phone); }
  return data;
}

/** The whole record, for the profile page. */
export function patientView(p: Patient) {
  return {
    id: p.id,
    firstName: p.firstName, lastName: p.lastName, preferredName: p.preferredName,
    dateOfBirth: p.dateOfBirth ? p.dateOfBirth.toISOString().slice(0, 10) : null,
    sex: p.sex, phone: p.phone, email: p.email,
    addressLine1: p.addressLine1, addressLine2: p.addressLine2, city: p.city, state: p.state, postalCode: p.postalCode,
    emergencyName: p.emergencyName, emergencyPhone: p.emergencyPhone, emergencyRelation: p.emergencyRelation,
    preferredContact: p.preferredContact,
    smsOptIn: p.smsOptIn, smsOptInAt: p.smsOptInAt,
    frontDeskNote: p.frontDeskNote,
    createdAt: p.createdAt, updatedAt: p.updatedAt,
  };
}

/** Enough to tell two people apart in a list, and no more. */
export function patientSummary(p: Patient) {
  return {
    id: p.id,
    name: `${p.firstName} ${p.lastName}`,
    preferredName: p.preferredName,
    phone: p.phone,
    email: p.email,
    dateOfBirth: p.dateOfBirth ? p.dateOfBirth.toISOString().slice(0, 10) : null,
    smsOptIn: p.smsOptIn,
  };
}

/**
 * Directory search. One free-text box, interpreted by shape:
 *   an '@'                       → email
 *   a date YYYY-MM-DD            → date of birth
 *   mostly digits (≥ 4)          → phone number
 *   anything else                → name: every word must START a first, last or preferred name
 */
export function searchWhere(q: string): Prisma.PatientWhereInput {
  const query = q.trim();
  const base: Prisma.PatientWhereInput = { deletedAt: null };
  if (!query) return base;

  if (query.includes('@')) return { ...base, email: { contains: query.toLowerCase(), mode: 'insensitive' } };
  if (/^\d{4}-\d{2}-\d{2}$/.test(query)) return { ...base, dateOfBirth: new Date(`${query}T00:00:00Z`) };

  const digits = phoneDigits(query);
  if (digits.length >= 4 && digits.length >= query.replace(/[\s()+-]/g, '').length - 1) {
    return { ...base, phoneDigits: { contains: digits } };
  }

  const words = query.split(/[\s,]+/).filter(Boolean).slice(0, 4);
  return {
    ...base,
    AND: words.map((w) => ({
      OR: [
        { firstName: { startsWith: w, mode: 'insensitive' as const } },
        { lastName: { startsWith: w, mode: 'insensitive' as const } },
        { preferredName: { startsWith: w, mode: 'insensitive' as const } },
      ],
    })),
  };
}
