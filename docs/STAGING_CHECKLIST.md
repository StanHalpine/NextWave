# Staging checklist

Everything that cannot be proven by the automated tests, because it needs a real database, a real host, a real
provider, a real phone or a real browser — **in the order to do it**. Each stage says what it unlocks. **None of it blocks
development**; it is what stands between this code and real patients.

Staging means: the Render blueprint (`render.yaml`) deployed, `BOOKING_MODE=demo`, **fake patients only**. Tick a box here when
you have seen the thing happen, not when you have set it up.

| Stage | What | Needs | Unlocks |
|---|---|---|---|
| 0 | Decisions and paperwork | you | everything below that waits on them |
| 1 | The database (`DATABASE_URL`) | a Postgres | the app starting at all |
| 2 | Settings and secrets on Render | stage 1 | a safe first deploy |
| 3 | First deploy | stages 1–2 | a running staff app |
| 4 | The first administrator (`ADMIN_EMAIL`) | stage 3 | anyone signing in |
| 5 | A walk through the staff app, Phase 5 included | stage 4 | confidence in the screens |
| 6 | Scheduled jobs | stage 3 | texts, credits, audio retention |
| 7 | Twilio | stages 2–3 | the inbound webhook; **sending still needs an adapter** |
| 8 | AWS (the Phase 4 list) | stage 2, **adapters not built yet** | the AI scribe |
| 9 | Real devices | stage 5 | trust on a phone and a tablet |
| 10 | Before any real patient | all of it | going live |

---

## 0. Decisions and paperwork (yours, no code)

- [ ] **Approve or correct `docs/DISCOUNT_MAPPING.md`.** Until you do, no member discount exists anywhere; stage 5 has a step that
      needs the approved table.
- [ ] **Counsel has read `privacy.html` and `sms-terms.html`**, and you have a Notice of Privacy Practices to reference.
- [ ] **The Twilio toll-free verification** for `+18665241007` is approved (submitted with the wording in `docs/SMS_TEMPLATES.md` and
      the opt-in image `sms-opt-in.png`). Stage 7 can start before it, but a real text cannot reach a phone until it is.
- [ ] **The AWS Business Associate Addendum is signed** (stage 8 needs it before any real audio exists).
- [ ] Answer the open questions at the end of `docs/PHASE5_NOTES.md` (dues in Accounting, vitamin shots in "Other", the Twilio adapter).

## 1. The database — the external `DATABASE_URL`

The app reads its database from `DATABASE_URL` and nothing else, so the same code runs against any Postgres. Use a **separate
database for staging**; never point staging at the one real patients will use.

- [ ] Create the database and a role that may `CREATE` in it (migrations create tables, types, indexes and triggers).
- [ ] Build the URL as `postgresql://USER:PASSWORD@HOST:5432/DBNAME?schema=public&sslmode=require`. **In production the app refuses to
      start unless the URL requires TLS.**
- [ ] **Reachability.** The blueprint's pre-deploy step (`prisma migrate deploy && npm run seed`) runs on Render's machines, which have
      no fixed addresses. If your Postgres allow-lists IPs, either allow Render's outbound addresses or run the migrations from CI
      and delete `preDeployCommand`. If you use a pooler (pgbouncer), run migrations on the **direct** connection.
- [ ] **Look at its time zone**, from any SQL prompt: `SHOW timezone;` and write the answer here: ______. The app is correct either way
      (see `docs/PHASE5_NOTES.md` §6 — three queries used to depend on it and no longer do), but a database that is not UTC is what
      hid that bug, so know which you have.
- [ ] Turn on backups at the host, and note how to restore. A restore drill into a scratch database is worth doing before real data.
- [ ] Enter `DATABASE_URL` **in the Render dashboard** for **both** services (web and cron). Never in a file, a commit or a message.

## 2. Settings and secrets on Render

Secrets marked `sync: false` in `render.yaml` are entered in the dashboard, **separately on each service**.

| Variable | Web | Cron | Notes |
|---|:-:|:-:|---|
| `DATABASE_URL` | ✔ | ✔ | stage 1 |
| `MFA_ENCRYPTION_KEY` | ✔ | ✔ | `npm run gen-secrets` on your machine, paste the **same** value into both. Losing or changing it invalidates every enrolled authenticator |
| `APP_BASE_URL` | ✔ | ✔ | the public `https://` origin of the web service, no trailing slash. Setup links and the Twilio signature check use it |
| `NODE_ENV=production`, `CLINIC_TIMEZONE=America/Chicago` | ✔ | ✔ | already in the blueprint |
| `BOOKING_MODE=demo` | ✔ | | already in the blueprint; stays `demo` for staging |
| `AUDIO_RETENTION_DAYS` | ✔ | ✔ | optional, default 30. **Set the same on both**: the cron job deletes the audio, the web app tells providers the number |
| `ALLOW_STUB_INTEGRATIONS=true` | ✔ | | **staging with fake patients only.** Lets the scribe run on the local stubs; never where real patients are seen |
| `CORS_ORIGINS` | ✔ | | only if the booking widget is served from another origin (e.g. `https://nextwave-wellness.com`) |
| `PREVIEW_KEY` | ✔ | | optional: staff reach the booking flow at `/?preview=<key>` while the public sees "coming soon" |
| `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `CLINIC_PHONE`, `TWILIO_ACCOUNT_SID` | ✔ | ✔ | stage 7. Only the token is needed to start |

- [ ] Both services have `DATABASE_URL`, `MFA_ENCRYPTION_KEY` and `APP_BASE_URL`, with identical values for the last two.
- [ ] `ALLOW_STUB_INTEGRATIONS` is set **only** because staging holds fake patients — and is on the list to remove in stage 10.

## 3. First deploy

- [ ] New → Blueprint → this repo → the branch. Wait for the web service to go live (`/health` returns 200) and the cron job to exist.
- [ ] The pre-deploy log shows the migrations applied and the seed run. From the web service's shell,
      `npx prisma migrate status` ends with **"Database schema is up to date"**.
- [ ] The app started: it **refuses to start** for a missing `MFA_ENCRYPTION_KEY` / `APP_BASE_URL`, a database URL without TLS, an
      invalid `TWILIO_FROM_NUMBER` or `AUDIO_RETENTION_DAYS`, so a running service means those are right.
- [ ] `https://<your-app>/app` shows the staff sign-in. The public booking page shows the "demo" banner.

## 4. The first administrator — `ADMIN_EMAIL`

- [ ] In the web service's shell: `ADMIN_EMAIL=you@example.com npm run seed:admin`. It prints a **one-time setup link** (good for 24
      hours; no password is ever created, stored or printed). `--reissue` prints a fresh one. It refuses if a *different* admin exists.
- [ ] Open the link, choose a password, **enrol an authenticator app** (mandatory for admins), and store the ten recovery codes.
- [ ] Sign out and in again with the password and a code.
- [ ] Create the other logins from **Admin → Accounts**: a front desk login, and one login per provider role you will test (a provider
      is sent to enrol an authenticator before the documentation workspace opens — check that happens).

## 5. A walk through the staff app (fake patients), Phase 5 included

- [ ] Book a test appointment from the public page; approve it on the Schedule; check the patient in; check out **cash**, then another
      visit with **credits** (create a test membership first, Patients → profile → Credit Tracker).
- [ ] **Accounting** (admin): *Monthly by service*, *Daily*, *Members vs. non-members* and *Custom* each show those two visits; the totals row
      adds up; for the credit visit **Net is $0.00 and Covered by membership shows its list price**; *list = discount + covered + net* on every row.
- [ ] **Reports** (front desk): *New memberships*, *Walk-ins*, *Weekend visits*, *Service demand* load; the front desk **cannot** open
      Accounting (it says "Not available to your role").
- [ ] **Export CSV** from two views and open the files in the spreadsheet your accountant uses: the dashes in "Member — cash" display
      correctly, the totals row is last, money is plain numbers, and **no patient name, phone or id appears anywhere**.
- [ ] *(When one happens naturally.)* A visit checked out late on the last evening of a month appears in that month, not the next. The
      automated tests cover this against databases in four time zones; this is the confirmation on the real host.
- [ ] **Admin → Audit log** shows a `READ` row for each view and an `EXPORT` row for each CSV, carrying the dates and filters.
- [ ] **Discounts, once you approve the table:** enter it on Admin → Memberships → *Member discounts by service category*; check out a
      member's cash visit and confirm the desk is shown *list − discount = net* before confirming, and that a credit visit is not discounted.
- [ ] A signed note: only the provider who signed it is offered **Amend**; another provider is offered **Add addendum**; an admin is offered neither.
- [ ] Reports are quick on the real host: the current month appears at once; a three-year range in a second or two. (The timings
      in `docs/PHASE5_NOTES.md` §4 are from a laptop; `npm run perf:reports` repeats them against any database you can create a schema in.)

## 6. Scheduled jobs (the Render Cron Job)

- [ ] `nextwave-jobs` runs every 5 minutes (`npm run jobs:run`) and exits 0; its log shows **counts only**, no names or numbers.
- [ ] A confirmation is *composed* within about five minutes of a consenting booking being approved (while Twilio sending is not built it
      goes to the stub; the check is that the job picks it up).
- [ ] The monthly credit grant and credit expiry run from the same job (enrol a test patient, move the date, or check the next real grant day).
- [ ] **Audio retention** (needs stage 8's real storage to be meaningful): with `AUDIO_RETENTION_DAYS` set, a signed visit's audio is
      deleted that many days after signing, the transcript and draft remain, and the audit log has one row per deletion. *With the stub
      storage the cron job cannot delete a file the web service wrote — they have separate disks — so do not expect it to.*
- [ ] The in-process timer (`JOBS_IN_PROCESS=true`) is untested against a real, restarting host; prefer the cron job.

## 7. Twilio

**Read this first: the app does not send texts through Twilio yet.** There is no sending adapter (`TwilioMessaging`); every
confirmation and reminder goes to the local stub. What *is* built and checkable is the inbound webhook (STOP / START / HELP / C) and
the wording. Building the adapter needs the account SID and auth token, and your toll-free approval.

- [ ] Set on **both** services: `TWILIO_AUTH_TOKEN` (and `APP_BASE_URL`, stage 2). Optional: `TWILIO_FROM_NUMBER` (default
      `+18665241007`; must be E.164 or the app will not start) and `CLINIC_PHONE` (default `(308) 830-1951`). `TWILIO_ACCOUNT_SID` is
      reserved for the sending adapter; nothing reads it yet.
- [ ] **Verify the Twilio signature with a real inbound message.** The webhook's signature check (`POST /api/sms/inbound`,
      `src/routes/smsInbound.ts`) is tested only against this project's own implementation of Twilio's published scheme (HMAC-SHA1 of the
      public URL plus the sorted form fields, keyed with the auth token), never against a request Twilio actually signed.
  1. In Twilio, point the number's "A message comes in" webhook at `POST {APP_BASE_URL}/api/sms/inbound`. The URL Twilio signs is the one
     typed there, so it must match `APP_BASE_URL` + `/api/sms/inbound` character for character (scheme, host, no trailing slash, no port).
  2. From a real phone that is on the do-not-text list or is a staging patient, text `HELP`, then `STOP`, then `START`, then `C` (with a
     confirmed appointment on that number).
  3. Expect each to be answered with the wording in `docs/SMS_TEMPLATES.md`, and **no** `403` in Twilio's webhook log. A `403` means the
     signature did not verify: check the URL and token first.
  4. Send one deliberately unsigned request (`curl -X POST -d 'From=+15555550100&Body=STOP' {url}`): it must be refused with `403`.
- [ ] **After the sending adapter exists:** a real confirmation and a real reminder reach a consenting test phone **in the clinic's time
      zone**, inside 08:00–21:00 clinic time; an appointment *today* gets the "see you today at …" wording and one *tomorrow* the tomorrow
      wording; a number that texted `STOP` receives neither; and the texts come from `+18665241007`.
- [ ] Toll-free verification is **approved**, with the exact text in `docs/SMS_TEMPLATES.md` and the opt-in image from the marketing site.

## 8. AWS — the resources in `docs/PHASE4_NOTES.md` §6

**Blocked:** the `S3FileStorage` and `AwsAiScribe` adapters are not built (no credentials to test them against). Do these in order;
the details, the IAM policy and the settings table are in §6.2–§6.3 of that document.

- [ ] 1. **Sign the AWS BAA** in your account; choose **one region** where Transcribe Medical and your chosen Claude model both exist.
- [ ] 2. **KMS key** (customer-managed, symmetric, rotation on); the app's IAM identity may `GenerateDataKey` and `Decrypt`.
- [ ] 3. **S3 bucket** with two prefixes (`scribe/audio/`, `transcripts/`): block all public access; default encryption SSE-KMS with that key;
      a policy denying non-TLS requests; CORS allowing `PUT` from the app's origin (`Content-Type` allowed, `ETag` exposed); versioning
      off (or non-current versions expired within a day); a lifecycle rule on `scribe/audio/` as a **backstop at least as long as
      `AUDIO_RETENTION_DAYS`** (the app deletes audio at that many days after signing; S3 must not delete it sooner); CloudTrail data events on.
- [ ] 4. **IAM user** (access key, no console access) with the one inline policy in §6.2. Replace it with a role when the app moves onto AWS.
- [ ] 5. **Transcribe Medical** needs nothing provisioned; decide the specialty.
- [ ] 6. **Bedrock model access** enabled for the chosen model; **model invocation logging off** (or to an encrypted, locked-down bucket).
- [ ] 7. **A budget alert** and an alarm on repeated failures.
- [ ] 8. Send me the non-secret settings (region, bucket, key ARN, model id). Enter `AWS_REGION`, `AWS_ACCESS_KEY_ID` and
      `AWS_SECRET_ACCESS_KEY` **directly in Render, on the web service only**.
- [ ] 9. After the adapters are built and the providers switched from `stub`: **remove `ALLOW_STUB_INTEGRATIONS`**; record one synthetic visit
      end to end (consent → record → transcript → draft → review → sign); a clinician checks the draft; then confirm the retention purge
      (stage 6) deletes the audio and leaves the transcript.
- [ ] The AI scribe stays **off in production** until all of this is true and the BAA is in place.

## 9. Real devices

- [ ] The staff screens (Credit Tracker, check-out, provider queue, documentation workspace, **Accounting and Reports**) on a phone and a
      tablet: touch targets, the on-screen keyboard not covering the field being typed in, the idle-timeout warning, and the wide report
      tables scrolling inside their box rather than the page.
- [ ] The **date pickers** on Accounting and Reports on iOS Safari and Android Chrome (the range boxes are native date inputs; I could not drive them by hand).
- [ ] **Recording** on iPhone/iPad Safari and Android Chrome: the microphone permission prompt, the recording format the browser produces,
      and that a recording of several minutes uploads.

## 10. Before any real patient

- [ ] Stages 1–9 ticked, or the open ones accepted in writing.
- [ ] `ALLOW_STUB_INTEGRATIONS` removed; the scribe running on real storage, or left off.
- [ ] `BOOKING_MODE` moved from `demo` deliberately (`beta` / `live`), and a restore of the production database tested.
- [ ] The privacy policy and SMS terms read by counsel; the owner's own sign-off on the discount table; a HIPAA review of the whole
      system (none has been done — see the notes' known limitations).
