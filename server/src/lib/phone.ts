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

/**
 * ONE key for a US number however it was typed: "(612) 555-0142", "612-555-0142" and
 * "1-612-555-0142" are all "16125550142". Anything that is not a US number falls back to its
 * digits. Used for the do-not-text list, where two spellings of one number must not be two entries.
 */
export function canonicalDigits(raw: string): string {
  return toE164(raw)?.slice(1) ?? phoneDigits(raw);
}

/** The spellings a stored phone may have as digits: with and without the leading 1. */
export function phoneVariants(raw: string): string[] {
  const c = canonicalDigits(raw);
  return c.length === 11 && c.startsWith('1') ? [c, c.slice(1)] : [c];
}
