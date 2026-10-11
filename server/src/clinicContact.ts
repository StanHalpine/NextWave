/**
 * How the clinic can be reached, as published on the marketing site (../contact.html).
 *
 * The number a patient is told in a HELP reply must be the number the website shows. The server
 * does not read contact.html at run time (the deployed service is built from server/ alone), so the
 * published value is copied here and tests/contact-page.test.ts compares the two: edit one without
 * the other and the test fails.
 *
 * The CLINIC_PHONE environment variable always wins when set; this is what the HELP reply says otherwise.
 */
export const PUBLISHED_CLINIC_PHONE: string | null = '(308) 830-1951';

/**
 * The number appointment texts are sent FROM: the toll-free number registered for the Twilio
 * verification. TWILIO_FROM_NUMBER overrides it (E.164, e.g. +18665241007).
 */
export const DEFAULT_SMS_FROM_NUMBER = '+18665241007';

/** E.164: a plus sign, a non-zero first digit, 7 to 15 digits in all. */
export const isE164 = (s: string): boolean => /^\+[1-9]\d{6,14}$/.test(s);
