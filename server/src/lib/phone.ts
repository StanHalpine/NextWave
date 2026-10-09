/**
 * Phone numbers. US numbers only for now (the clinic is in Minnesota); anything
 * else is treated as "cannot text", never guessed at.
 */

/** Digits only — what search and sending use. */
export function phoneDigits(raw: string): string {
  return raw.replace(/\D+/g, '');
}

/** A usable US number is 10 digits, or 11 starting with 1. */
export function isValidUsPhone(raw: string): boolean {
  const d = phoneDigits(raw);
  return d.length === 10 || (d.length === 11 && d.startsWith('1'));
}

/** "+16125550187", or null if it is not a number we can text. */
export function toE164(raw: string): string | null {
  const d = phoneDigits(raw);
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return null;
}
