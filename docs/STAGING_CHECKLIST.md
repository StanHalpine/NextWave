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
| 5 | A walk through the staff app, Accounting and dues included | stage 4 | confidence in the screens |
| 6 | Scheduled jobs | stage 3 | texts, credits and dues, audio retention |
| 7 | Twilio: the two webhook addresses, then real texts | stages 2–3 | real texts, delivery status, STOP handling |
| 8 | AWS (the Phase 4 list) | stage 2, **adapters not built yet** | the AI scribe |
| 9 | Real devices | stage 5 | trust on a phone and a tablet |
| 10 | Before any real patient | all of it | going live |

---

## 0. Decisions and paperwork (yours, no code)

- [ ] **Check the discount table** (approved and enabled in dev): **Prevent 10%, Restore 15%, Optimize 20%** on Spinal X-rays, Supplements and Special
      services, perks off — and that I read "the clean per-tier mapping" the way you meant it (`docs/DISCOUNT_MAPPING.md` top). **A new database starts with no
      discounts:** stage 5 has the step that enters them.
- [ ] **Decide when to fix `membership.html`.** `docs/DISCOUNT_MAPPING.md` §2 lists every place it disagrees with what is enforced (X-rays at a flat 20%, special services,
      packages and additional credits promised but not delivered, every perk off, credits "across functional medicine"), with line numbers. The page is untouched.
- [ ] **Counsel has read `privacy.html` and `sms-terms.html`**, and you have a Notice of Privacy Practices to reference.
- [ ] **The Twilio toll-free verification** for `+18665241007` is approved (submitted with the wording in `docs/SMS_TEMPLATES.md` and
      the opt-in image `sms-opt-in.png`). Stage 7 can start before it, but a real text will not reach a phone until it is.
- [ ] **The AWS Business Associate Addendum is signed** (stage 8 needs it before any real audio exists).

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
| `APP_BASE_URL` | ✔ | ✔ | the public `https://` origin of the web service, no trailing slash, **no underscore in the host name** (Twilio refuses those; the app refuses to start with one). Setup links, the Twilio signature check and every text's status-callback address use it |
| `NODE_ENV=production`, `CLINIC_TIMEZONE=America/Chicago` | ✔ | ✔ | already in the blueprint |
| `BOOKING_MODE=demo` | ✔ | | already in the blueprint; stays `demo` for staging |
| `TWILIO_ACCOUNT_SID` | ✔ | ✔ | stage 7. `AC` + 32 hex characters; any other shape stops the app at start-up. **Texts go through Twilio only when this AND the token are both set** |
| `TWILIO_AUTH_TOKEN` | ✔ | ✔ | stage 7. Also the key both webhooks are verified against; with `NODE_ENV=production` and no token they refuse everything (503) |
| `TWILIO_FROM_NUMBER`, `CLINIC_PHONE` | ✔ | ✔ | optional. Default `+18665241007` (must be E.164) and `(308) 830-1951` |
| `AUDIO_RETENTION_DAYS` | ✔ | ✔ | optional, default 30. **Set the same on both**: the cron job deletes the audio, the web app tells providers the number |
| `ALLOW_STUB_INTEGRATIONS=true` | ✔ | | **staging with fake patients only.** Lets the scribe run on the local stubs; never where real patients are seen |
| `CORS_ORIGINS` | ✔ | | only if the booking widget is served from another origin (e.g. `https://nextwave-wellness.com`) |
| `PREVIEW_KEY` | ✔ | | optional: staff reach the booking flow at `/?preview=<key>` while the public sees "coming soon" |

- [ ] Both services have `DATABASE_URL`, `MFA_ENCRYPTION_KEY` and `APP_BASE_URL`, with identical values for the last two.
- [ ] `ALLOW_STUB_INTEGRATIONS` is set **only** because staging holds fake patients — and is on the list to remove in stage 10.

## 3. First deploy

- [ ] New → Blueprint → this repo → the branch. Wait for the web service to go live (`/health` returns 200) and the cron job to exist.
- [ ] The pre-deploy log shows the migrations applied and the seed run. From the web service's shell,
      `npx prisma migrate status` ends with **"Database schema is up to date"**.
- [ ] The app started: it **refuses to start** for a missing `MFA_ENCRYPTION_KEY` / `APP_BASE_URL`, a database URL without TLS, an
      invalid `TWILIO_FROM_NUMBER`, `TWILIO_ACCOUNT_SID` or `AUDIO_RETENTION_DAYS`, or (with both Twilio credentials set) an `APP_BASE_URL`
      that is not `https://` or has an underscore in its host — so a running service means those are right.
- [ ] `https://<your-app>/app` shows the staff sign-in. The public booking page shows the "demo" banner.

## 4. The first administrator — `ADMIN_EMAIL`

- [ ] In the web service's shell: `ADMIN_EMAIL=you@example.com npm run seed:admin`. It prints a **one-time setup link** (good for 24
      hours; no password is ever created, stored or printed). `--reissue` prints a fresh one. It refuses if a *different* admin exists.
- [ ] Open the link, choose a password, **enrol an authenticator app** (mandatory for admins), and store the ten recovery codes.
- [ ] Sign out and in again with the password and a code.
- [ ] Create the other logins from **Admin → Accounts**: a front desk login, and one login per provider role you will test (a provider
      is sent to enrol an authenticator before the documentation workspace opens — check that happens).

## 5. A walk through the staff app (fake patients), Accounting and dues included

- [ ] Book a test appointment from the public page; approve it on the Schedule; check the patient in; check out **cash**, then another
      visit with **credits** (create a test membership first, Patients → profile → Credit Tracker).
- [ ] **Enrolling that test membership billed its first month's dues.** Accounting → any view: under the service table there is a separate
      **Membership dues (billed)** table with one month at the tier's price, **not** added into the service totals above it.
- [ ] **Accounting** (admin): *Monthly by service*, *Daily*, *Members vs. non-members* and *Custom* each show those two visits; the totals row
      adds up; for the credit visit **Net is $0.00 and Covered by membership shows its list price**; *list = discount + covered + net* on every row.
      Filtering the custom view by a service or provider leaves the dues table empty and says why; payment type **Membership dues** shows only dues.
- [ ] **Reports** (front desk): *New memberships*, *Walk-ins*, *Weekend visits*, *Service demand* load (a vitamin shot appears under
      **Vitamin shots & injections**, not Other); the front desk **cannot** open Accounting (it says "Not available to your role").
- [ ] **Export CSV** from two views and open the files in the spreadsheet your accountant uses: the dashes in "Member — cash" display
      correctly, an Accounting file has **two sections** (service revenue, then dues) with their own totals, money is plain numbers, and **no patient
      name, phone or id appears anywhere**.
- [ ] *(When one happens naturally.)* A visit checked out late on the last evening of a month appears in that month, not the next. The
      automated tests cover this against databases in four time zones; this is the confirmation on the real host.
- [ ] **Admin → Audit log** shows a `READ` row for each view and an `EXPORT` row for each CSV, carrying the dates and filters.
- [ ] **Enter the discount table on this new database** (it starts with none): in the web service's shell, `npm run discounts:apply` — or type the table into Admin →
      Memberships → *Member discounts by service category* (Spinal X-rays and Supplements, each Prevent 10 · Restore 15 · Optimize 20, with their one service each; Special
      services, no service). It prints what it created; run twice, it says there is nothing to do. Perks stay off (Admin → Memberships shows every perk switch off).
- [ ] **Check the discount at the desk:** a **Restore** member paying cash for a **Spinal X-Ray** ($250.00) is shown **list $250.00 − $37.50 = net $212.50** before confirming
      (Prevent $25.00 off, Optimize $50.00 off); a **credit-paid** visit, a **paused** member and a **non-member** are not discounted; Accounting shows the discount and the category.
- [ ] A signed note: only the provider who signed it is offered **Amend**; another provider is offered **Add addendum**; an admin is offered neither.
- [ ] Reports are quick on the real host: the current month appears at once; a three-year range in a second or two. (The timings
      in `docs/PHASE5_NOTES.md` §4 are from a laptop; `npm run perf:reports` repeats them against any database you can create a schema in.)

## 6. Scheduled jobs (the Render Cron Job)

- [ ] `nextwave-jobs` runs every 5 minutes (`npm run jobs:run`) and exits 0; its log shows **counts only**, no names or numbers.
- [ ] A confirmation is picked up within about five minutes of a consenting booking being approved. With the Twilio credentials **not** yet set it
      goes to the stub (the check is that the job picks it up); with them set it is a real text — see stage 7.
- [ ] **The monthly grant bills dues with the credits:** enrol a test patient, move their start date back a month (or wait for a real grant day), run the
      job, and see one new month in the dues table — and *only* one, however many times the job runs. A paused member is not billed.
- [ ] Credit expiry runs from the same job.
- [ ] **Audio retention** (needs stage 8's real storage to be meaningful): with `AUDIO_RETENTION_DAYS` set, a signed visit's audio is
      deleted that many days after signing, the transcript and draft remain, and the audit log has one row per deletion. *With the stub
      storage the cron job cannot delete a file the web service wrote — they have separate disks — so do not expect it to.*
- [ ] The in-process timer (`JOBS_IN_PROCESS=true`) is untested against a real, restarting host; prefer the cron job.

## 7. Twilio

**What is built:** the app sends texts through Twilio **when both `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` are set** (otherwise the local stub, which sends
nothing), receives replies (STOP, START, HELP, C), and receives delivery-status callbacks. All of it is tested against a local fake of Twilio's API, **never
against Twilio itself** — this stage is where that gets proved.

### 7.1 The two addresses

With `APP_BASE_URL` = your public `https://` address (no trailing slash):

| What | Where in the Twilio console | Enter exactly | Method |
|---|---|---|---|
| **Inbound messages** (STOP, START, HELP, C) | Your number `+18665241007`'s messaging configuration → **"A message comes in"** → *Webhook* (menu names vary a little by console version) | `https://<your-app>/api/sms/inbound` | `HTTP POST` |
| **Status callbacks** (delivered / undelivered / failed) | **Nothing to enter.** The app sends a `StatusCallback` with every message, so the console needs no entry | *(for reference: `https://<your-app>/api/sms/status`)* | `HTTP POST` |

- [ ] The inbound address is typed **character for character** as `APP_BASE_URL` + `/api/sms/inbound` (scheme, host, no trailing slash, no port) — Twilio signs
      exactly the URL it called, and a mismatch makes every inbound request a `403`.
- [ ] *Only if you put the number in a Messaging Service:* its **Delivery Status Callback URL** may also be set to the status address; the per-message address
      takes priority either way.

### 7.2 Credentials and start-up

- [ ] Enter `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` **in the Render dashboard, on both services**, and redeploy. Never in a file, a commit or a message to me.
- [ ] The services start. (They refuse to if the SID is not `AC` + 32 hex, or `APP_BASE_URL` is not `https://` / has an underscore in its host.) The logs show no
      `twilio_partially_configured` warning (that means only one of the two is set, so the app is still on the stub).
- [ ] Admin → home → Integrations shows **Messaging (Twilio) · twilio · Live**, not "Development stub".

### 7.3 The webhook signature, with a real inbound message

The signature check is tested only against this project's own implementation of Twilio's published scheme (HMAC-SHA1 of the public URL plus the sorted form
fields, keyed with the auth token), never against a request Twilio actually signed. Both webhooks use the same check.

- [ ] From a real phone that is on the do-not-text list or is a staging patient, text `HELP`, then `STOP`, then `START`, then `C` (with a confirmed
      appointment on that number). Expect each to be answered with the wording in `docs/SMS_TEMPLATES.md`, and **no** `403` in Twilio's webhook log. A `403`
      means the signature did not verify: check the URL and token first.
- [ ] Send one deliberately unsigned request to each address (`curl -X POST -d 'From=+15555550100&Body=STOP' https://<your-app>/api/sms/inbound`, and
      `curl -X POST -d 'MessageSid=SM00000000000000000000000000000000&MessageStatus=delivered' https://<your-app>/api/sms/status`): both must be refused with `403`.

### 7.4 Real texts and delivery status

- [ ] A **consenting staging patient's** confirmation arrives on a real phone **within about five minutes** of approving the appointment, from `+18665241007`, with
      the first name, day and time and nothing else. In Twilio's message log the message is **delivered**.
- [ ] A few seconds later the appointment's detail on the Schedule reads **"sent … · delivered"** — that is the status callback arriving. (In Twilio's log the
      callback to `/api/sms/status` shows `200`.)
- [ ] The 24-hour reminder arrives inside **08:00–21:00 clinic time**; an appointment *today* gets "see you today at …" and one *tomorrow* "see you tomorrow at …";
      an appointment booked less than a day ahead gets only its confirmation.
- [ ] A number that texted `STOP` receives neither, and is not texted again after a `START` unless it has consent.
- [ ] **The job's log shows message SIDs and statuses, and no number, name or text.** Read a few minutes of the cron job's log and the web service's log.
- [ ] *If Twilio ever answers a send with error **21610** (the number opted out at Twilio's end while our list did not know):* the patient's consent turns off, the
      number goes on the do-not-text list, and the audit log has `UPDATE patient` (reason `provider_opt_out`) and `sms_consent` rows. This should be rare, because our own
      list normally catches a STOP first.
- [ ] **Wrong credentials are loud:** (optional, on staging) set a wrong token on the cron job and see `twilio_credentials_rejected` as an **error** in its log;
      the texts retry for about 80 minutes (5, 15, 60) and then fail for good. Put the right token back.
- [ ] **One known limit:** if Twilio accepts a message but its reply is lost to a timeout, the retry sends it a second time (the Messages API has no
      idempotency key). Watch for a duplicate while you test; it should be very rare.
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
