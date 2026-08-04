import type { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';

/**
 * HTTP Basic Auth across the whole app while this is a shared demo.
 *
 * This is a curtain, not a security model — one credential shared by everyone
 * who gets the link, with no identity behind it. It exists so the demo is not
 * protected by nothing more than an unlisted URL, which is not protection:
 * URLs leak through referrer headers, browser sync, and crawlers.
 *
 * It is NOT a substitute for the real staff auth described in spec §7.5. When
 * actual patient data lands, this gate should be removed, not relied on.
 *
 * Disabled entirely when DEMO_USER / DEMO_PASSWORD are unset, so local
 * development is unaffected.
 */

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export function demoGate(req: Request, res: Response, next: NextFunction) {
  const user = process.env.DEMO_USER;
  const pass = process.env.DEMO_PASSWORD;

  // Not configured → no gate. Keeps `npm run dev` friction-free.
  if (!user || !pass) return next();

  // Render polls this to decide whether the service is live; gating it would
  // make every deploy look unhealthy.
  if (req.path === '/health') return next();

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
