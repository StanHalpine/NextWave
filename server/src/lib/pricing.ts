/**
 * Money arithmetic for the desk. Everything is whole cents; there is no floating point anywhere,
 * so a figure the front desk sees is exactly the figure that is recorded.
 */

/**
 * A member's discount on a LIST price: `percent` of it, rounded to the nearest cent with halves
 * rounding UP (so 15% of $19.99 = $3.00, not $2.99), and the net that remains.
 *
 * The discount is computed once, here, from the list price — never from an already-discounted
 * figure and never by the browser. The web app carries a copy of this function only to show the
 * figure as it is typed; the server recomputes and refuses a check-out whose displayed net differs.
 */
export function memberDiscount(listCents: number, percent: number): { discountCents: number; netCents: number } {
  if (!Number.isInteger(listCents) || listCents < 0) throw new RangeError('A price is a whole number of cents, zero or more.');
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) throw new RangeError('A discount is a whole percent from 0 to 100.');
  const discountCents = Math.floor((listCents * percent + 50) / 100);
  return { discountCents, netCents: listCents - discountCents };
}
