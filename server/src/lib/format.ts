import { DateTime } from 'luxon';
import { config } from '../config.js';

/** "Tuesday, Oct 13" — the appointment's date in CLINIC time, whatever the server's zone. */
export function formatApptDate(d: Date): string {
  return DateTime.fromJSDate(d, { zone: config.clinicTimezone }).toFormat('cccc, LLL d');
}

/** "2:30 PM" in clinic time. */
export function formatApptTime(d: Date): string {
  return DateTime.fromJSDate(d, { zone: config.clinicTimezone }).toFormat('h:mm a');
}

/** Clinic-local hour (0–23). */
export function clinicHour(d: Date): number {
  return DateTime.fromJSDate(d, { zone: config.clinicTimezone }).hour;
}
