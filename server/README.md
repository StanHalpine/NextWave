# NextWave Scheduling Engine

Booking backend and staff system for nextwave-wellness.com. Express +
TypeScript + Prisma + PostgreSQL, a hand-built front desk grid, and a React +
Vite staff app. Runs alongside the static marketing site — nothing in the 19
HTML pages changed.

Three surfaces:

| Surface | Path | Who | Built with |
|---|---|---|---|
| Patient booking widget | `/` | the public, anonymous | vanilla JS (embedded by deep links from the marketing site) |
| **Staff app** | `/app` | signed-in staff | React + Vite (`web/`): Front Desk, Patients, Schedule calendar, admin |
| Legacy staff pages | `/dashboard.html`, `/admin.html` | signed-in staff | vanilla JS, behind the same login. The room/employee grid is still here; the new Schedule calendar is `/app/schedule` |

## Run it locally

Requires Node 20+ and PostgreSQL (16 tested).

```bash
cp .env.example .env            # set DATABASE_URL — see .env.example for the rest
npm install
npm run web:install             # the staff app has its own package.json
npx prisma migrate deploy       # applies every migration, including Phase 1
npm run seed                    # services, rooms, staff — fills an EMPTY database only
npm run gen-secrets             # prints MFA_ENCRYPTION_KEY=… ; paste it into .env
ADMIN_EMAIL=you@example.com npm run seed:admin
npm run web:build               # builds the staff app into public/app
npm run dev                     # API + pages on http://localhost:4000
```

`seed:admin` prints a **one-time setup link**. Open it, choose a password, sign
in, then enrol an authenticator app (admins must). There is no default account
and no password is ever created for you.

- Patient booking — <http://localhost:4000/>
- Staff app — <http://localhost:4000/app>
- Front desk grid — <http://localhost:4000/dashboard.html> (also *Schedule* in the staff app)
- API — <http://localhost:4000/api/…>

Working on the staff app itself: `npm run web:dev` serves it with hot reload on
<http://localhost:5173/app/> and proxies `/api` to the server on :4000.

**Without `MFA_ENCRYPTION_KEY`** in development the server generates a throwaway
key per process (and warns). Authenticator enrolments then don't survive a
restart — set the key to avoid re-enrolling every time.

## Staff accounts and security

**Everyone signs in as themselves.** The shared front desk token and the shared
Basic Auth password are gone; a clinical note's author, an approval's approver,
and every audit row now mean a specific person.

| Role | Sees |
|---|---|
| `FRONT_DESK` | Front Desk (today's dashboard, check-in/out, walk-ins), Patients, Schedule, the legacy grid and pending queue. Sees *that* clinical notes exist, never their text |
| `PROVIDER_CHIRO` / `_NP` / `_NURSE` | clinical notes. Must be linked to a matching bookable provider record |
| `ADMIN` | everything above except writing notes, plus accounts, audit log, configuration |

An account can hold several roles — e.g. `ADMIN` + `PROVIDER_CHIRO` — with at
most one provider role. A note records *which provider role* it was written as.

**Sessions.** An opaque random token in an `httpOnly`, `SameSite=Strict` cookie;
only its SHA-256 is stored, so a database read cannot be replayed as a login.
Logout and expiry **revoke the row server-side**. A session ends after **15
minutes of inactivity** or 12 hours absolute. "Activity" means a person doing
something — a ping from real input events, or any non-GET request. Background
polling (the grid refreshes every 30 s) deliberately does *not* count, or an
unattended screen would never time out. Clients warn at 14 minutes.

**MFA.** TOTP (RFC 6238) is mandatory for `ADMIN`. Seeds are AES-256-GCM
encrypted with `MFA_ENCRYPTION_KEY`; a used code cannot be replayed; ten
single-use recovery codes are shown once at enrolment (only hashes stored).
Providers are added at the Phase 4 gate via `MFA_REQUIRED_ROLES`.

**Passwords.** Argon2id; ≥12 characters; common passwords and anything
containing the email are refused. Five bad attempts lock the account for 15
minutes. Unknown email, wrong password, locked and deactivated all return the
*same* message and take the same time. No administrator ever sets or sees a
password: new and reset accounts get a **one-time link** (token in the URL
*fragment*, so it never reaches a server log).

**Audit log.** Every create / read / update / delete of patient, appointment and
clinical-note data writes who, what, which record and when — ids and field
*names* only, never a value. Writes are captured at the Prisma client (so the
booking routes are audited without being edited); reads and refused attempts at
the route. The table is append-only at the database: a trigger rejects
`UPDATE`, `DELETE` and `TRUNCATE`. Viewer: *Admin → Audit log*.

**Logging.** `src/lib/logger.ts` is the only code allowed to write logs; it
reduces any error to class + sanitised message + request id. `npm run lint:logs`
fails if `console.*` appears anywhere else in `src/`.

**Production refuses to start** unless: `DATABASE_URL` requires TLS
(`sslmode=require|verify-ca|verify-full`), `MFA_ENCRYPTION_KEY` is set and valid,
and `APP_BASE_URL` is an `https://` origin.

## Front Desk, Patients and Schedule (Phase 2)

| Page | Path | What it does |
|---|---|---|
| Front Desk | `/app/front-desk` | Three columns from the `Encounter` table: today's appointments, checked in, seen/checked out. Check in, undo, check out, no-show, walk-in. The page asks for an online booking to be linked to a patient record before check-in (the API itself does not require it) |
| Patients | `/app/front-desk/patients` | Directory (search is a `POST` — a name or number never goes in a URL), profile, visit history, text-consent control, a *Credit tracker* tab that is a placeholder until Phase 3 |
| Schedule | `/app/schedule` | Day / week calendar with a provider filter. Click an empty time to book it; click an appointment to move, cancel, check in, approve or decline it |

**The booking engine is untouched.** Creating, moving and walk-ins call the engine's own
`computeDayAvailability()` and take the same row locks in the same order — every room the
service may use, then every person who may deliver it, then the booking
(`src/lib/scheduling.ts`, with the reasoning in its header). An online hold and a staff
booking for the same slot get exactly one winner.

**Writes are atomic with their audit row.** Staff writes run through `staffTransaction()`
(`src/lib/staffTx.ts`): the audit entry is inserted by the same transaction, so a refused or
failed change leaves no record of something that never happened. Reads call `audit.read()`.

**Walk-ins** take the current 15-minute slot (10:07 → the 10:00 slot), already confirmed and
checked in. If no room or provider is free it writes nothing and answers `409` with the next
openings.

**Moving** an appointment is in place (same id, patient and visit record) and all-or-nothing.
**Cancelling** records a reason *code* (`patient_request`, `provider_unavailable`,
`rescheduled_elsewhere`, `other`), never free text, and sends no text message.

### Appointment texts

A confirmation when an appointment is confirmed and a reminder 24 hours before, sent through
the `Messaging` interface (a local stub until a real provider exists — the stub writes to
`.devdata/sms-outbox.jsonl`, never to the log).

- **Content:** first name, date and time only — no service, provider or room. Enforced in code
  (`src/integrations/templates.ts`): templates are functions of exactly those three fields and
  `renderTemplate()` rejects any other variable.
- **Who:** only a *linked* patient whose consent a staff member recorded on their profile.
  The anonymous online widget cannot capture consent, so an online booking is texted only
  after the front desk links it to a consenting patient. Never walk-ins.
- **When:** never outside 08:00–21:00 clinic time; a text that comes due overnight waits for
  the morning. A patient who was only told less than a day before the visit gets no second text.
- **Exactly once:** `MessageLog` is unique on (appointment, kind, appointment time) and inserting
  the row is the claim, so overlapping runs, re-runs and restarts do not double-send. A move
  changes the appointment time, so the new time is confirmed and reminded afresh.
- **Failures:** transient errors retry (5, 15, 60 minutes, four attempts). A provider "STOP"
  turns the patient's consent off. Only a failure *category* is stored — never a provider
  message, which can echo the phone number.

### Scheduled jobs

Texts are sent by a job, not by the booking request, so something must run it. Pick one:

```bash
npm run jobs:run      # run every job once and exit. The blueprint's `nextwave-jobs` Cron Job runs
                      # this every 5 minutes. Needs the same environment as the web app.
```

or set `JOBS_IN_PROCESS=true` (interval `JOBS_INTERVAL_MIN`, default 5) to run them on a timer
inside the web process. Use that only on a single **always-on** instance: a sleeping web service
sends nothing while it sleeps. Running both is safe (every job is idempotent) but pointless.
A confirmation therefore goes out within one interval of the appointment being confirmed, not instantly.

## Deploying (Render blueprint; any Postgres)

The app reads its database from **`DATABASE_URL` and nothing else**, so it runs
against whatever Postgres you point it at: an external staging instance now, AWS
RDS later. `render.yaml` (repo root) is a Blueprint for the **web service only** —
it provisions no database. It builds the server and the staff app.

1. Push the branch; Render → **New → Blueprint** → select it.
2. Set the `sync: false` values in the dashboard:
   - `DATABASE_URL` — your Postgres, **ending `?sslmode=require`** (production
     refuses to start on a non-TLS URL).
   - `APP_BASE_URL` — the public `https://` origin (used for setup links).
   - `MFA_ENCRYPTION_KEY` — from `npm run gen-secrets`. **Keep a copy**: losing
     it invalidates every enrolled authenticator.
3. Deploy. The **build** touches no database (it generates the Prisma client and compiles the
   server and staff app), so Render's build servers never need to reach `DATABASE_URL`. Migrations
   and the seed run in **`preDeployCommand`** — after the build, before the new version takes
   traffic; a failure stops the deploy. `npm run seed` populates an EMPTY database in one
   transaction and skips otherwise, so admin edits survive every deploy and a failed seed leaves
   the database empty rather than half-populated. The pre-deploy step *does* run on Render's
   infrastructure, so if your Postgres allow-lists IP addresses, run migrations from CI instead.
4. Open the service **Shell** and run `ADMIN_EMAIL=you@example.com npm run seed:admin`
   to get the first administrator's setup link.
5. The blueprint also creates **`nextwave-jobs`**, a Render Cron Job that runs `npm run jobs:run`
   every five minutes (see *Scheduled jobs*). Secrets can't live in an environment group, so enter
   `DATABASE_URL`, `APP_BASE_URL`, `MFA_ENCRYPTION_KEY` and `CLINIC_PHONE` on **both** services.

Both services use a **paid** plan (`0.5c-512mb`): `preDeployCommand` isn't available on the free
plan, cron jobs have no free plan, and the web service must be awake to answer the text-message
provider's STOP / HELP webhook (`POST /api/sms/inbound`).

`BASIC_AUTH_GATE=off` by default. Set it to `on` (with `DEMO_USER` /
`DEMO_PASSWORD`) to put the old Basic Auth curtain back in front of the staff
pages during cutover; individual logins apply either way.

A Render *free* web service sleeps after ~15 minutes idle, which is why this blueprint uses a paid
one — and why scheduled jobs run from a Cron Job (below) rather than from the web process.

## How availability is decided

`src/lib/availability.ts` is the single source of truth. A 15-minute slot is
offered only when all four hold at once:

1. the appointment fits inside published clinic hours for that weekday
   (Mon–Fri 07:00–19:00, Sat 08:00–14:00, Sun closed — from `contact.html`)
2. a provider of the service's `requiredRole` is rostered across it
3. that provider has no conflicting booking **anywhere** — staff contention is
   global, so an RN on an IV drip is unavailable for a lab draw
4. one of the rooms assigned to the service (see `ServiceRoom`) has spare
   capacity — a service may list several, and any of them will do

Effective concurrency is therefore `min(free rooms, free qualified staff)`.

**Buffers** are trailing turnaround: a booking occupies its room and provider
for `durationMin + bufferMin`. The appointment must end by close and by
end-of-shift; its buffer may run past both, or the last appointment of every
day would be unbookable.

**Timezone.** Everything in Postgres is UTC. Every wall-clock string
(`StaffSchedule.startTime`, clinic hours, `?date=`) resolves against
`CLINIC_TIMEZONE`, which is **`America/Chicago`** — US Central, confirmed by
the practice. All conversion is in `src/lib/time.ts` via Luxon so DST is
handled in one place.

That value must stay an **IANA zone name, never a fixed offset**. `America/Chicago`
resolves to CST (UTC−6) in winter and CDT (UTC−5) in summer by itself; a
hard-coded `-06:00` would look right today and silently shift every appointment
by an hour from the second Sunday in March.

## Why the lock is on `Resource`, not `Booking`

The spec asks for `SELECT … FOR UPDATE`. Locking the *conflicting bookings*
cannot work: two people racing for the same empty slot both find zero
conflicting rows, so there is nothing to lock and both inserts succeed. That is
a write-skew phantom — row locks cannot guard a row that does not exist yet.

So each hold takes `FOR UPDATE` on the Resource rows of the required type
before evaluating anything. Those rows always exist, so the lock always bites.
Attempts on the same room type serialize; unrelated room types stay parallel.
Locks are always taken Resource-then-Staff, each ordered by `id`, so two
transactions cannot deadlock.

Verified under load:

```bash
./scripts/race-test.sh 2026-08-05 12
# 12 concurrent holds on the single X-Ray Suite → exactly 1 winner, 11 × 409
```

## Endpoints

Auth column: **—** public · **staff** any signed-in role · otherwise the roles
allowed. Every non-GET staff request also needs the `x-csrf-token` header.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/services` | — | Service picker |
| GET | `/api/availability?serviceId&date` | — | Open 15-min starts for one day |
| POST | `/api/holds` | — | Claim a slot for 10 min |
| GET | `/api/holds/:id` | — | Is my held slot still good? |
| DELETE | `/api/holds/:id` | — | Release early |
| POST | `/api/bookings` | — | Hold → `PENDING_REVIEW` |
| GET | `/api/bookings/:id` | — | Patient status check |
| PATCH | `/api/bookings/:id` | front desk, admin | Approve / decline / cancel |
| GET | `/api/front-desk/schedule?date` | front desk, admin | Grid data |
| GET | `/api/front-desk/pending` | front desk, admin | Review queue |
| POST | `/api/bookings/:id/notes` | provider | Write a clinical note (author = your login) |
| POST | `/api/visit-notes/:id/amend` | provider | Supersede a note (never updates) |
| GET | `/api/bookings/:id/notes` | staff | Notes for one visit — text for providers/admin, a count for front desk |
| POST | `/api/patients/search` | staff | Find a patient (body, never a query string) |
| GET | `/api/patients/:id/history` | staff | Compiled patient record |
| POST | `/api/auth/login` · `/logout` · `/ping` · `/change-password` · `/setup` | — / staff | Sign-in flow |
| POST | `/api/auth/mfa/enroll/start` · `/enroll/confirm` · `/verify` | staff | TOTP |
| GET | `/api/auth/me` | staff | Who am I, what step is outstanding |
| GET/POST/PATCH | `/api/admin/accounts` (+ `/:id/reset-password`, `/unlock`, `/reset-mfa`) | admin | Accounts |
| GET | `/api/admin/audit` · `/api/admin/integrations` | admin | Audit log · integration status |
| * | `/api/admin/staff` · `/resources` · `/services` | admin | Configuration (a service's `documentationType` — SOAP or session log — is edited here and audited) |
| GET | `/api/fd/dashboard?date` | front desk, admin | The three-column day |
| POST | `/api/fd/appointments/:id/check-in` · `/undo-check-in` · `/check-out` · `/no-show` | front desk, admin | Visit workflow |
| POST | `/api/fd/walk-ins` | front desk, admin | Place and check in a walk-in (409 + next openings if none free) |
| POST | `/api/fd/patients/search` | front desk, admin | Directory search (body `{ q, page }`) |
| POST · GET · PATCH · DELETE | `/api/fd/patients` · `/:id` | front desk, admin (delete: admin) | Patient records; delete is a soft delete |
| GET | `/api/fd/patients/:id/visits` | front desk, admin | Visit history |
| POST | `/api/fd/patients/:id/sms-consent` | front desk, admin | Record consent / opt-out and how it was given |
| GET · POST | `/api/fd/bookings/:id/patient-matches` · `/link-patient` | front desk, admin | Suggest and link an online booking to a patient |
| GET | `/api/schedule/calendar?from&to` | front desk, admin | Up to 14 days: hours, provider shifts, rooms, appointments |
| GET | `/api/schedule/slots?serviceId&date[&forAppointmentId]` | front desk, admin | Bookable starts (as if one appointment were not there, for a move) |
| GET | `/api/schedule/appointments/:id` | front desk, admin | One appointment, with text delivery status |
| POST | `/api/schedule/appointments` · `/:id/move` · `/:id/cancel` | front desk, admin | Create / move / cancel |

Removed: `POST /api/admin/purge` (bulk-delete of patient data over HTTP) and
`GET /api/patients?email=` (an email address in a URL).

### Lifecycle

```
HOLD ──POST /api/bookings──▶ PENDING_REVIEW ──PATCH──▶ CONFIRMED ──PATCH──▶ CANCELLED
                                            └─PATCH──▶ DECLINED
```

Nothing is hard-deleted past `PENDING_REVIEW`; declining and cancelling are
status changes so the front desk keeps history. Only unclaimed holds are
deleted outright.

### Session token

The schema has no session-token column and does not need one: the hold id is
already a v4 UUID, unguessable and scoped to one slot. The browser stores
`{ holdId, expiresAt }` in `localStorage` and presents the id to confirm or
release.

### Hold expiry

Expiry is decided by the `holdExpiresAt` timestamp, not by a job — an expired
hold stops blocking the moment its timestamp passes. The 60-second sweeper in
`index.ts` is housekeeping only, so abandoned holds do not accumulate.

## Deep-linking from the marketing site

A service page's "Book now" button hands off with the page's own slug:

```html
<a href="https://nextwave-scheduling.onrender.com/?service=manual-adjustment">Book now</a>
```

`?service=<slug>` matches `Service.slug`, which is the marketing page's
filename minus `.html` — the same convention the contact form already uses for
`?interest=`. The booking app then locks to that service and opens on "Choose a
day" rather than asking a patient who already chose to choose again. An unknown
slug falls back to the full picker rather than dead-ending.

`slug` is deliberately **not unique**: `hyperbaric-oxygen-therapy` maps to both
the 60- and 90-minute rows, which share one page. The client takes the shortest
duration when a slug matches more than one.

**Only `manual-adjustment` is wired so far.** The other 13 pages still show the
disabled placeholder — see spec §9.3 before enabling them, because every wired
button hard-codes the temporary `onrender.com` demo host.

## Patient booking flow

`public/index.html` — service → day → slot → hold → details → request.

The hold is taken the moment a slot is picked, so the patient fills the form
against a genuinely reserved slot rather than racing other patients for it. The
countdown is shown live, and the hold id is kept in `localStorage` so a refresh
mid-form resumes instead of abandoning the slot. Releasing early frees it
immediately rather than waiting out the TTL.

The page is styled from `assets/style.css` and carries a permanent
**DEMO — sample data** banner plus `noindex`, so it cannot be mistaken for the
live site.

## Front desk grid

Hand-built (`public/dashboard.js`, ~260 lines) rather than FullCalendar,
because the Resource TimeGrid view that draws room columns is **FullCalendar
Premium** (paid, ~$480/yr) and this view is narrow enough to own outright.

Room columns, 15-minute rows, sticky time gutter, status colours, hatched
buffer tails, side-by-side lanes when a multi-capacity room runs concurrent
patients, click-through detail dialog, 30-second auto-refresh.

The drawn window is clinic hours **union every booking on the day**, so a
booking outside opening hours — after an hours change, a timezone correction,
or a manual entry — appears in shaded out-of-hours rows with a warning rather
than being positioned off-grid where nobody would see it.

## Known gaps — read before launch

**Data.** All staff names and shifts in `seed.ts` are invented. Room counts
(4 IV chairs, 2 red light beds, 2 lab seats) are guesses and directly cap daily
throughput. Service durations/buffers are estimates except where a service page
states one. Names, categories and the 60/90 hyperbaric split are real.

**Schema.** The spec's `Service` model has no `price` and no `slug`. Without a
slug there is no clean join from the site's existing `?interest=<slug>` links
(see the contact form section of the root `CLAUDE.md`) to a service row — right
now it would have to match on name. Both are worth adding.

**Placeholder users.** `Booking.userId` is `NOT NULL`, so a hold must create a
`User` before contact details exist. `POST /api/holds` inserts a "Pending guest"
row that `POST /api/bookings` fills in and the sweeper removes if the hold
lapses. Making `userId` nullable would remove this wart.

**Authentication is per-person, but not yet reviewed.** Staff accounts, sessions,
TOTP for admins and an audit trail exist (see *Staff accounts and security*).
They have been tested but not independently reviewed, and a HIPAA review is still
needed before real patient data lands in this database. Providers do not yet
require MFA (Phase 4 gate). See `docs/PHASE1_NOTES.md` for the list of things to
verify by hand.

**Clinical notes are medical records.** `VisitNote` is amend-only — correcting a
note inserts a new row and preserves the original verbatim; there is no PATCH and
no DELETE. The author and the provider role used are taken from the signed-in
session, never the request body. Until the Phase 4 provider module, the only UI
for writing a note is the legacy dashboard, available to an account that holds
both `ADMIN` and a provider role.

**No EHR export exists.** `GET /api/patients/:id/history` returns the compiled
record in the shape an export would be built from, but there is no FHIR or HL7
mapping. Spec §8.5.

**Not built** (nobody specified them): patient-facing booking UI, recurring
appointment expansion (`isRecurring` is stored but never acted on), a real SMS provider
(texts go to a local stub until Twilio is wired in), cancellation or reschedule texts, email
confirmations, membership-credit integration, cancellation windows, provider
time-off/blackout dates. (Automated tests now exist — `npm test` — covering auth, access control, audit and start-up guards; the booking engine itself is still verified by `scripts/race-test.sh` rather than unit tests.)

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Watch mode |
| `npm run seed` | Load services/rooms/staff into an EMPTY database (one transaction) |
| `npm run seed:admin` | Create the first admin from `ADMIN_EMAIL`; prints a one-time setup link |
| `npm run gen-secrets` | Print a fresh `MFA_ENCRYPTION_KEY` |
| `npm run typecheck` | `tsc --noEmit` over src, prisma, scripts and tests |
| `npm run lint:logs` | Fail if anything but `lib/logger.ts` writes to the console |
| `npm test` | Vitest — runs against a throwaway Postgres *schema* (see below) |
| `npm run web:build` / `web:dev` / `web:install` | The React staff app |
| `npm run jobs:run` | Run every scheduled job once (appointment texts) and exit — see *Scheduled jobs* |
| `npm run dev:reset` | **Dev only**: delete bookings, patients and notes. Refuses when `NODE_ENV=production` or `BOOKING_MODE` is beta/live, and needs `CONFIRM_DEV_RESET=yes` |
| `./scripts/race-test.sh [date] [n]` | Concurrency proof — exactly one winner for one room |
| `./scripts/demo-day.sh [date]` | Fill a day with mixed-status bookings — **dev only**; needs `DEMO_STAFF_EMAIL` / `DEMO_STAFF_PASSWORD` of a front desk login to approve |
| `node scripts/with-schema.mjs create\|drop <name>` / `run <name> -- <cmd>` | Run any command against a throwaway schema inside your database |

### Tests

`npm test` creates a schema named `nw_test_<pid>` inside the database
`DATABASE_URL` points at, migrates and seeds it, runs the suite, and drops it.
It uses a separate *schema* rather than your real tables because the audit log
is append-only — rows a test wrote to the real schema could never be cleaned up.
The connection string is derived in-process and never printed. Needs `CREATE`
privilege on the database.

The suite sends its fake texts and files to a throwaway folder (`DEV_DATA_DIR`), not to your
`.devdata/`. `NW_TEST_POOL=3 npm test` re-runs everything with the connection pool capped at
3 — the setting under which a lock-ordering mistake shows up every time rather than rarely.
The walk-in race tests (`tests/walkin-race.test.ts`) fire concurrent walk-ins, bookings,
moves, cancellations, check-ins and the existing approve route at one another and assert
exact winner counts, no double-booking and no deadlock.
