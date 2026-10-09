import { useEffect, useState } from 'react';
import { api } from './api';

const FALLBACK_TZ = 'America/Chicago';
let cached: string | null = null;
let inflight: Promise<string> | null = null;

/** The clinic's IANA zone, from the server (public /api/config). Cached for the life of the page. */
function loadTz(): Promise<string> {
  if (cached) return Promise.resolve(cached);
  inflight ??= api<{ timezone?: string }>('/api/config')
    .then((c) => (cached = c.timezone || FALLBACK_TZ))
    .catch(() => FALLBACK_TZ)
    .finally(() => { inflight = null; });
  return inflight;
}

export function useClinicTz(): string {
  const [tz, setTz] = useState(cached ?? FALLBACK_TZ);
  useEffect(() => { void loadTz().then(setTz); }, []);
  return tz;
}

/** Today's date ("YYYY-MM-DD") in the clinic's zone. */
export const todayIn = (tz: string, at = new Date()): string => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(at);
