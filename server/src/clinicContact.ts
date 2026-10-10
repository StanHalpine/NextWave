/**
 * How the clinic can be reached, as published on the marketing site (../contact.html).
 *
 * The number a patient is told in a HELP reply must be the number the website shows. The server
 * does not read contact.html at run time (the deployed service is built from server/ alone), so the
 * published value is copied here and tests/contact-page.test.ts compares the two: edit one without
 * the other and the test fails.
 *
 * contact.html currently publishes NO phone number (it lists three email addresses and "Address to
 * be confirmed"), so there is nothing to copy yet and this is null. Until it is filled in, the
 * CLINIC_PHONE environment variable is the only source; it always wins when set.
 */
export const PUBLISHED_CLINIC_PHONE: string | null = null;
