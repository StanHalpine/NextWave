import type { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';

/**
 * HTTP Basic Auth over the STAFF surface only.
 *
 * The patient booking flow is public (see PUBLIC_PATHS) — a patient who
 * clicked "Book now" on the marketing site cannot be handed a password
 * prompt. Everything else, including the front desk grid and every clinical
 * endpoint, stays gated.
 *
 * This is a curtain, not a security model: one credential shared by all staff,
 * with no identity behind it. It is NOT a substitute for the real per-user
 * auth in spec §7.5 — which matters more now that the booking page is public
 * and the records behind this gate are real patients rather than fixtures.
 *
 * Disabled entirely when DEMO_USER / DEMO_PASSWORD are unset, so local
 * development is unaffected.
 */

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/**
 * Paths the Basic Auth gate does NOT cover.
 *
 * The patient booking flow is public — a patient arriving from a "Book now"
 * button cannot be handed a password prompt. Everything a patient needs to
 * reach a booking is listed here, and nothing else.
 *
 * Note what is deliberately absent: /dashboard.html and every
 * /api/front-desk/* and clinical route. Those stay behind Basic Auth *and*
 * the front desk token, so patient records keep two independent locks even
 * though the booking page has none.
 */
const PUBLIC_PATHS = new Set([
  '/',
  '/index.html',
  '/booking.css',
  '/booking.js',
  '/robots.txt',
  '/favicon.ico',
  // Render polls this to decide whether the service is live; gating it would
  // make every deploy look unhealthy.
  '/health',
]);

/** Patient-facing API surface. Prefix-matched. */
const PUBLIC_API = ['/api/config', '/api/services', '/api/availability', '/api/holds', '/api/bookings'];

function isPublic(path: string): boolean {
  if (PUBLIC_PATHS.has(path)) return true;
  // /api/bookings/:id is public (a patient checking their own request), but
  // /api/bookings/:id/notes is NOT — clinical notes are staff-only.
  if (path.includes('/notes')) return false;
  return PUBLIC_API.some((p) => path === p || path.startsWith(p + '/'));
}

export function demoGate(req: Request, res: Response, next: NextFunction) {
  const user = process.env.DEMO_USER;
  const pass = process.env.DEMO_PASSWORD;

  // Not configured → no gate. Keeps `npm run dev` friction-free.
  if (!user || !pass) return next();

  if (isPublic(req.path)) return next();

  const header = req.get('authorization') ?? '';
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx !== -1) {
      const gotUser = decoded.slice(0, idx);
      const gotPass = decoded.slice(idx + 1);
      // Evaluate both halves regardless, so timing does not reveal which failed.
      const okUser = safeEqual(gotUser, user);
      const okPass = safeEqual(gotPass, pass);
      if (okUser && okPass) return next();
    }
  }

  res.set('WWW-Authenticate', 'Basic realm="NextWave Scheduling Demo", charset="UTF-8"');
  res.status(401).send('Authentication required.');
}
