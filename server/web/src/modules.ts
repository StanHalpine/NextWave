import type { Role } from './api';

export interface Module {
  key: string;
  label: string;
  blurb: string;
  /** In-app route, or an external href for a page that is not in this app yet. */
  to?: string;
  href?: string;
  roles: Role[];
  phase: number;
}

const PROVIDERS: Role[] = ['PROVIDER_CHIRO', 'PROVIDER_NP', 'PROVIDER_NURSE'];

/** The five module entry points. Who sees each is the access matrix in docs/SPEC.md §1. */
export const MODULES: Module[] = [
  { key: 'front-desk', label: 'Front Desk', to: '/front-desk', roles: ['FRONT_DESK', 'ADMIN'], phase: 2,
    blurb: "Today's appointments, check-in and check-out, and the patient directory." },
  // Schedule opens the existing, working master grid until the Phase 2 calendar replaces it.
  { key: 'schedule', label: 'Schedule', href: '/dashboard.html', roles: ['FRONT_DESK', 'ADMIN'], phase: 1,
    blurb: 'The day grid by room or by employee, and the pending-approval queue.' },
  { key: 'provider', label: 'Provider', to: '/provider', roles: [...PROVIDERS, 'ADMIN'], phase: 4,
    blurb: 'Your checked-in patients and SOAP notes.' },
  { key: 'accounting', label: 'Accounting', to: '/accounting', roles: ['ADMIN'], phase: 5,
    blurb: 'Revenue by service, by day, and members versus non-members.' },
  { key: 'reports', label: 'Reports', to: '/reports', roles: ['FRONT_DESK', 'ADMIN'], phase: 5,
    blurb: 'Memberships, walk-ins, weekend visits, and service demand.' },
];

export const ROLE_LABEL: Record<Role, string> = {
  FRONT_DESK: 'Front desk',
  ADMIN: 'Admin',
  PROVIDER_CHIRO: 'Chiropractor',
  PROVIDER_NP: 'Nurse practitioner',
  PROVIDER_NURSE: 'Nurse',
};
