import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PUBLISHED_CLINIC_PHONE } from '../src/clinicContact.js';
import { config } from '../src/config.js';

/**
 * The phone number a patient is given in a HELP text must be the one the website shows. The server
 * keeps a copy of the published number (src/clinicContact.ts); this fails when the two disagree,
 * in either direction: a number added to contact.html with no copy here, or a copy here that the
 * page no longer shows.
 */
const page = readFileSync(path.resolve(__dirname, '../../contact.html'), 'utf8');
const digits = (s: string) => s.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');

function phonesOnPage(): string[] {
  const found = new Set<string>();
  for (const m of page.matchAll(/href="tel:([^"]+)"/gi)) found.add(digits(decodeURIComponent(m[1]!)));
  // Visible text only: drop tags and the inline script before looking for a US number.
  const text = page.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ');
  for (const m of text.matchAll(/(?<!\d)\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?!\d)/g)) found.add(digits(m[0]));
  return [...found].filter((d) => d.length === 10);
}

describe('the clinic phone number', () => {
  it('matches contact.html: the same number, or none on either side', () => {
    const published = phonesOnPage();
    if (published.length === 0) {
      expect(PUBLISHED_CLINIC_PHONE, 'contact.html shows no phone number, so there is nothing to copy into src/clinicContact.ts').toBeNull();
    } else {
      expect(published, 'contact.html shows more than one number; decide which is the HELP number').toHaveLength(1);
      expect(PUBLISHED_CLINIC_PHONE, 'contact.html now shows a phone number: copy it into src/clinicContact.ts').not.toBeNull();
      expect(digits(PUBLISHED_CLINIC_PHONE!)).toBe(published[0]);
    }
  });

  it('is overridden by CLINIC_PHONE, and falls back to the published number', () => {
    const saved = process.env.CLINIC_PHONE;
    try {
      process.env.CLINIC_PHONE = '  (612) 555-0199 ';
      expect(config.clinicPhone).toBe('(612) 555-0199');
      delete process.env.CLINIC_PHONE;
      expect(config.clinicPhone).toBe(PUBLISHED_CLINIC_PHONE ?? '');
    } finally {
      if (saved === undefined) delete process.env.CLINIC_PHONE; else process.env.CLINIC_PHONE = saved;
    }
  });
});
