import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SMS_FROM_NUMBER, PUBLISHED_CLINIC_PHONE, isE164 } from '../src/clinicContact.js';
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
    expect(published, 'contact.html is expected to show the clinic phone').toEqual(['3088301951']);
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

describe('the sender number', () => {
  it('defaults to the registered toll-free number, is valid E.164, and is overridden by TWILIO_FROM_NUMBER', () => {
    expect(DEFAULT_SMS_FROM_NUMBER).toBe('+18665241007');
    expect(isE164(DEFAULT_SMS_FROM_NUMBER)).toBe(true);
    for (const bad of ['', '8665241007', '+0123456', '+1 866 524 1007', '+1866524100712345678']) expect(isE164(bad), bad).toBe(false);
    const saved = process.env.TWILIO_FROM_NUMBER;
    try {
      delete process.env.TWILIO_FROM_NUMBER;
      expect(config.twilioFromNumber).toBe('+18665241007');
      process.env.TWILIO_FROM_NUMBER = ' +18005550199 ';
      expect(config.twilioFromNumber).toBe('+18005550199');
    } finally {
      if (saved === undefined) delete process.env.TWILIO_FROM_NUMBER; else process.env.TWILIO_FROM_NUMBER = saved;
    }
  });
  it('is what the stub provider records as the sender', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const { StubMessaging, DEV_DATA_DIR } = await import('../src/integrations/stubs.js');
    await new StubMessaging().sendSms({ to: '+16125550100', templateId: 'appt_reminder_24h_v3', variables: { first: 'Ingrid', time: '9:00 AM' } });
    const lines = readFileSync(path.join(DEV_DATA_DIR, 'sms-outbox.jsonl'), 'utf8').trim().split('\n');
    expect(JSON.parse(lines[lines.length - 1]!)).toMatchObject({ from: '+18665241007', to: '+16125550100' });
  });
});
