/** Provider login roles and the bookable staff role behind each. */

import type { AccountRole, StaffRole } from '@prisma/client';
import { PROVIDER_ROLES } from './sessions.js';

export type ProviderRole = 'PROVIDER_CHIRO' | 'PROVIDER_NP' | 'PROVIDER_NURSE';

export const STAFF_ROLE_FOR: Record<ProviderRole, StaffRole> = {
  PROVIDER_CHIRO: 'CHIROPRACTOR',
  PROVIDER_NP: 'NURSE_PRACTITIONER',
  PROVIDER_NURSE: 'REGISTERED_NURSE',
};

export const PROVIDER_ROLE_LABEL: Record<ProviderRole, string> = {
  PROVIDER_CHIRO: 'Chiropractor',
  PROVIDER_NP: 'Nurse practitioner',
  PROVIDER_NURSE: 'Nurse',
};

export const isProviderRole = (r: string): r is ProviderRole => (PROVIDER_ROLES as string[]).includes(r);

export const providerRolesOf = (roles: readonly AccountRole[]): ProviderRole[] => roles.filter(isProviderRole);

/**
 * May a provider acting as `role` document a visit booked with a provider of staff role `booked`?
 * Only the same role. A visit with NO provider assigned (a room-only service) can be documented by
 * any provider role, rather than being invisible to everyone.
 */
export function roleMayDocument(booked: StaffRole | null | undefined, role: ProviderRole): boolean {
  return !booked || STAFF_ROLE_FOR[role] === booked;
}
