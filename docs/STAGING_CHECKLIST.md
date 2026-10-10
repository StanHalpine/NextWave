# Staging checklist

Things that cannot be proven by the automated tests, because they need a real provider, a real
host, a real phone or a real browser. **None of these blocks development**; each is a check to do
once on a staging deployment (fake patients only) before real patients use the feature, and to tick
off here.

Staging means: the Render blueprint deployed, `BOOKING_MODE=demo`, no real patient data.

## Texts (Twilio)

- [ ] **Verify the Twilio signature with a real inbound message.** The webhook's signature check
      (`POST /api/sms/inbound`, `src/routes/smsInbound.ts`) is tested only against this project's own
      implementation of Twilio's published scheme (HMAC-SHA1 of the public URL plus the sorted form
      fields, keyed with the auth token), never against a request Twilio actually signed.
  1. Set `TWILIO_AUTH_TOKEN`, `APP_BASE_URL` and `CLINIC_PHONE` on **both** the web service and the cron job.
  2. In Twilio, point the number's "A message comes in" webhook at `POST {APP_BASE_URL}/api/sms/inbound`.
     The URL Twilio signs is the one typed there, so it must match `APP_BASE_URL` + `/api/sms/inbound`
     character for character (scheme, host, no trailing slash, no port).
  3. From a real phone that is on the do-not-text list or a staging patient, text `HELP`, then `STOP`,
     then `START`, then `C` (with a confirmed appointment on that number).
  4. Expect each to be answered with the wording in `docs/SMS_TEMPLATES.md`, and **no** `403` in Twilio's
     webhook log. A `403` means the signature did not verify: check the URL and token first.
  5. Send one deliberately unsigned request (`curl -X POST -d 'From=+15555550100&Body=STOP' {url}`):
     it must be refused with `403`.
- [ ] A real confirmation and a real 24-hour reminder reach a consenting test phone, in the clinic's
      time zone, and a number that texted `STOP` receives neither.
- [ ] Toll-free / A2P registration approved with the exact text in `docs/SMS_TEMPLATES.md` and the opt-in
      image from the marketing site.

## Scheduled jobs (Render Cron Job)

- [ ] `nextwave-jobs` runs every 5 minutes (`npm run jobs:run`) and exits 0; the run logs counts only.
- [ ] A confirmation text goes out within about five minutes of a consenting booking being approved.
- [ ] The monthly credit grant and credit expiry run from the same job (enrol a test patient, move the
      date, or check the next real grant day).
- [ ] The in-process timer (`JOBS_IN_PROCESS=true`) is untested against a real, restarting host; prefer the cron job.

## Screens, on real devices

- [ ] The Phase 3 and 4 staff screens (Credit Tracker, check-out, provider queue, documentation
      workspace) on a phone and a tablet: touch targets, the on-screen keyboard not covering the field
      being typed in, and the idle-timeout warning.
- [ ] **Recording** on iPhone/iPad Safari and Android Chrome: the microphone permission prompt, the
      recording format the browser produces, and that a recording of several minutes uploads.

## Provider documentation (Phase 4)

- [ ] A provider with no authenticator is sent to enrol before they can open the documentation workspace.
- [ ] The AI scribe is **off** in production while the storage and scribe integrations are the local
      stubs (`ALLOW_STUB_INTEGRATIONS` is for staging with fake patients only). Switch it on only after
      the real S3, Transcribe Medical and Bedrock adapters are connected (see `docs/PHASE4_NOTES.md`),
      the AWS BAA is in place, and one end-to-end recording has been checked by a clinician.
