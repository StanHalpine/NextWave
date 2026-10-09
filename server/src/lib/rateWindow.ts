/**
 * A tiny in-memory fixed-window counter, for the few PUBLIC (cookie-less) endpoints that write.
 * Per process, like the login limiter: it blunts a script hammering one endpoint, it is not a
 * substitute for a WAF. `now` is injectable so tests need no sleeping.
 */
const windows = new Map<string, { start: number; count: number }>();

/** Count one hit for `key`; true while within `max` per `windowMs`. */
export function withinLimit(key: string, max: number, windowMs: number, now = Date.now()): boolean {
  const w = windows.get(key);
  if (!w || now - w.start >= windowMs) {
    windows.set(key, { start: now, count: 1 });
    if (windows.size > 10_000) for (const [k, v] of windows) if (now - v.start >= windowMs) windows.delete(k);
    return true;
  }
  w.count += 1;
  return w.count <= max;
}

/** Test hook. */
export function resetRateWindows(): void { windows.clear(); }
