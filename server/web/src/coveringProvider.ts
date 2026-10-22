import { fmtTime12 } from './lib';

/**
 * The covering provider (rev 2.1), as the server sends it (GET /api/fd/appointments/:id/provider-options), and the words the desk sees.
 * A covering provider becomes the visit's provider; the booking and the calendar are unchanged.
 */

export interface ProviderOverlap {
  bookingId: string; localStart: string; localEnd: string; service: string; patient: string;
  status: 'CONFIRMED' | 'PENDING_REVIEW'; asCovering: boolean;
}
export interface ProviderOption {
  id: string; name: string; role: string;
  /** The visit's provider now (covering, else booked). */
  isCurrent: boolean;
  /** The provider the visit was booked with. */
  isScheduled: boolean;
  /** Their OTHER appointments overlapping this visit. A warning only. */
  overlaps: ProviderOverlap[];
}
export interface ProviderOptions {
  bookingId: string; service: string;
  scheduled: { id: string; name: string } | null;
  currentId: string | null;
  checkedIn: boolean;
  signed: boolean;
  options: ProviderOption[];
}

/** "Dr. X also has 10:00–10:30 Manual Adjustment (Cara L.) at this time." — or null when they have nothing else on. Never a refusal. */
export function overlapWarning(o: ProviderOption): string | null {
  if (o.isCurrent || o.overlaps.length === 0) return null;
  const items = o.overlaps.map((x) => `${fmtTime12(x.localStart)}–${fmtTime12(x.localEnd)} ${x.service} (${x.patient}${x.asCovering ? ', covering' : ''}${x.status === 'PENDING_REVIEW' ? ', awaiting approval' : ''})`);
  return `${o.name} also has ${items.join('; ')} at this time. You can still choose them; the Schedule is not changed.`;
}

/** "Dr. Halpine (covering for Dr. L'Heureux)" — the provider line on a card or dialog. */
export function providerLine(a: { staff: { name: string } | null; covering: { name: string } | null }): string {
  if (a.covering) return a.staff ? `${a.covering.name} (covering for ${a.staff.name})` : a.covering.name;
  return a.staff?.name ?? 'No provider';
}
