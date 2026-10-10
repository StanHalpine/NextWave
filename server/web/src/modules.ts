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
  /** False while the module is only a placeholder; its tile then says which phase builds it. */
  built: boolean;
}

const PROVIDERS: Role[] = ['PROVIDER_CHIRO', 'PROVIDER_NP', 'PROVIDER_NURSE'];

/** The five module entry points. Who sees each is the access matrix in docs/SPEC.md §1. */
export const MODULES: Module[] = [
  { key: 'front-desk', label: 'Front Desk', to: '/front-desk', roles: ['FRONT_DESK', 'ADMIN'], phase: 2, built: true,
    blurb: "Today's appointments, check-in and check-out, and the patient directory." },
  { key: 'schedule', label: 'Schedule', to: '/schedule', roles: ['FRONT_DESK', 'ADMIN'], phase: 2, built: true,
    blurb: 'Day and week calendar by provider: book, move and cancel appointments, and approve online requests.' },
  { key: 'provider', label: 'Provider', to: '/provider', roles: [...PROVIDERS, 'ADMIN'], phase: 4, built: true,
    blurb: 'Your checked-in patients, SOAP notes and session logs, macros, and the AI scribe.' },
  { key: 'accounting', label: 'Accounting', to: '/accounting', roles: ['ADMIN'], phase: 5, built: false,
    blurb: 'Revenue by service, by day, and members versus non-members.' },
  { key: 'reports', label: 'Reports', to: '/reports', roles: ['FRONT_DESK', 'ADMIN'], phase: 5, built: false,
    blurb: 'Memberships, walk-ins, weekend visits, and service demand.' },
];

export const ROLE_LABEL: Record<Role, string> = {
  FRONT_DESK: 'Front desk',
  ADMIN: 'Admin',
  PROVIDER_CHIRO: 'Chiropractor',
  PROVIDER_NP: 'Nurse practitioner',
  PROVIDER_NURSE: 'Nurse',
};
