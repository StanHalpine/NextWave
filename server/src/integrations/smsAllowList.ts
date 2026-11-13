/**
 * The staging guard on outbound texts.
 *
 * Outside live mode (BOOKING_MODE is anything but "live" — staging runs "demo"), the Twilio adapter sends ONLY to the numbers in
 * SMS_ALLOWED_NUMBERS: a comma-separated list of E.164 numbers, e.g. "+16125550142,+16125550199". Any other recipient is skipped
 * before anything reaches Twilio. Empty or unset outside live mode means NOTHING is sent at all — so turning real credentials on
 * for a deployment that holds test bookings can never text someone by accident.
 *
 * In live mode the list is ignored (with a warning at start-up if it is set, so a leftover list is visible).
 *
 * Inbound texts (STOP / START / HELP / C) are untouched: their replies go back in the webhook's own response
 * (routes/smsInbound.ts), never through the adapter, so they work for any number.
 *
 * The numbers themselves are never logged — only how many there are.
 */
import type { BookingMode } from '../config.js';
import { isE164 } from '../clinicContact.js';

/**
 * The numbers a text may go to, or null for "no restriction" (live mode only). Throws, naming the entry's POSITION and never its
 * value, on anything that is not E.164 — a typo must stop the app at start-up rather than silently text nobody.
 */
export function smsAllowList(mode: BookingMode, raw: string | undefined): ReadonlySet<string> | null {
  if (mode === 'live') return null;
  const entries = (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  entries.forEach((e, i) => {
    if (!isE164(e)) {
      throw new Error(`Refusing to start: SMS_ALLOWED_NUMBERS entry ${i + 1} is not a phone number in E.164 form, such as +16125550142.`);
    }
  });
  return new Set(entries);
}

/** How many numbers SMS_ALLOWED_NUMBERS holds (for the live-mode "ignored" warning), without validating them. */
export function smsAllowListCount(raw: string | undefined): number {
  return (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean).length;
}
