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
| `FRONT_DESK` | Front Desk (today's dashboard, check-in, check-out with credits, walk-ins), Patients and their Credit tracker, Schedule, the legacy grid and pending queue. Sees *that* clinical notes exist, never their text |
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

**MFA.** TOTP (RFC 6238) is mandatory for `ADMIN` and, since Phase 4, for every provider role
(`MFA_REQUIRED_ROLES`, default `ADMIN` plus the three provider roles). Seeds are AES-256-GCM
encrypted with `MFA_ENCRYPTION_KEY`; a used code cannot be replayed; ten
single-use recovery codes are shown once at enrolment (only hashes stored). Clinical documentation
checks the authenticator **itself** on every route (enrolled, and used in this session), whatever
`MFA_REQUIRED_ROLES` says, so a mis-set variable cannot open the clinical record.

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
| Patients | `/app/front-desk/patients` | Directory (search is a `POST` — a name or number never goes in a URL), profile, visit history, text-consent control, and the *Credit tracker* tab (Phase 3) |
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

A confirmation when an appointment is confirmed and a reminder the day before, sent through
the `Messaging` interface (a local stub until a real provider exists — the stub writes to
`.devdata/sms-outbox.jsonl`, never to the log).

- **Wording lives in one file**, `src/integrations/templates.ts` — the two texts, the STOP / START /
  HELP / C replies, the opt-in label and the keywords. `npm run sms:templates` writes
  `docs/SMS_TEMPLATES.md` from it (with each message's length and segment cost) to hand to the
  carrier registration form; a test fails if that copy is stale.
- **Content:** first name, day and time only — no service, provider or room. Enforced in code: the
  module refuses to load if a template uses any other placeholder, and `renderTemplate()` rejects an
  extra or missing variable.
- **Who (either is enough):** a *linked* patient whose consent staff recorded on their profile, **or**
  the person who made an online booking and ticked the widget's checkbox (unchecked by default;
  the time and the exact words shown are stored on the booking). A number that texted **STOP** is on
  a do-not-text list that is checked before every send, unless consent *newer* than the STOP exists.
  Never walk-ins.
- **When:** never outside 08:00–21:00 clinic time; a text that comes due overnight waits for
  the morning. The reminder says "see you tomorrow", so it is sent only when the appointment IS
  tomorrow by the clinic's calendar, and never to a patient who was only told less than a day before.
- **Inbound** (`POST /api/sms/inbound`, signed by the provider; set `TWILIO_AUTH_TOKEN`): STOP puts the
  number on the list, turns off consent on every patient record with it, and is confirmed once; START
  lifts it; HELP replies with `CLINIC_PHONE`; **C** marks the next appointment confirmed by the
  patient. Anything else is neither stored nor answered, and neither the number nor the words reach a log.
- **Exactly once:** `MessageLog` is unique on (appointment, kind, appointment time) and inserting
  the row is the claim, so overlapping runs, re-runs and restarts do not double-send. A move
  changes the appointment time, so the new time is confirmed and reminded afresh.
- **Failures:** transient errors retry (5, 15, 60 minutes, four attempts). A provider "opted out"
  puts the number on the do-not-text list. Only a failure *category* is stored — never a provider
  message, which can echo the phone number.

### Credits, memberships and check-out (Phase 3)

| Where | What |
|---|---|
| Patient profile → **Credit tracker** | Membership (enrol, change plan, pause, resume, cancel), balance with an expiring-soon warning, perk counters, every lot with its last day, the full history with a running total; admins can adjust credits with a reason from a fixed list |
| Front Desk → **Check out…** | The visit's price, the member's balance **before and after**, and how it was paid: Wellness Credits, an included perk, or cash (recorded only — **nothing is charged or processed here**) |
| Admin → **Memberships** | The tiers as data (dues, credits a month, rollover) and each tier's perks (how many, which services, on/off) |
| Admin → Catalogue → Services | Price **and credit cost** per service (blank credit cost = cash only) |

**The ledger.** `CreditLedger` is append-only (database triggers reject UPDATE, DELETE and TRUNCATE).
A positive row is a **lot** — one per monthly grant, with a last-usable day (grant date + the tier's
rollover days); a negative row (redemption, expiry, manual removal) is spread over lots, **oldest
first**, by `CreditAllocation` rows, so what is left in a lot is computed, never edited. Credits are
unusable the moment their day passes; the expiry job writes that down so the history says so. A
deferred database constraint refuses a commit that would draw a lot below zero, even if application
code forgot to lock. Anything that takes credits holds the patient's row lock (lock order across
check-out: Booking → Patient → Membership).

**The monthly grant** is unique per (membership, month) in the database, so the job — run twice, or
by ten runners at once — grants a month once. It follows the clinic's calendar, anchors on the start
date (31 Jan → 28 Feb → 31 Mar), makes up missed months one lot each, and skips paused and cancelled
memberships. A plan change applies from the next grant; nothing is prorated or clawed back.

**Check-out** runs in one transaction: lock the booking, lock the patient, take the credits (or use
the perk, or record the cash price), write exactly **one `RevenueEvent`** (service, price, member /
cash, encounter — the data Accounting reads from day one), and check the patient out. It is
idempotent: a repeat or a double-click returns what was recorded and changes nothing.

**Member discount.** A percentage **per tier per service category** (`PlanCategoryDiscount`; a service is in at most
one `DiscountCategory`; both edited on Admin → Memberships → *Member discounts by service category*). It comes off the
**list price** when an **active** member pays **cash**, in whole cents with halves rounding up. Credits and perks are not
priced in money and are never discounted; a paused member, a non-member, a visit with no patient record, a service in no
category, a category switched off and a tier with no percent for the category all pay list. **There are no categories
until the owner approves the mapping** (`docs/DISCOUNT_MAPPING.md`), so nothing is discounted today. The desk is shown
list, discount and net, and the server refuses the check-out if the net the desk saw differs from what it computes
(`price_changed`). `RevenueEvent` records `listPriceCents`, `discountPercent`, `discountCategory` (the code),
`discountCents` and `netPriceCents`; a database CHECK enforces `net = list − discount`.

### Provider, documentation and the AI scribe (Phase 4)

| Where | What |
|---|---|
| **Provider** (`/app/provider`) | Today's checked-in patients for your provider role (plus visits with no provider assigned), longest-waiting first, each with *No note yet / Note in progress / Note signed*; earlier unsigned visits (30 days) apart. A person holding more than one role, or an admin, can switch roles (a role that is not theirs is read-only) |
| **Workspace** (`/app/provider/visits/:id`) | A SOAP editor (S / O / A / P) or, for a session-log service, duration + notes. Autosaves to a **draft**; one-click **macros**; **Review and sign**; after signing, **Amend** (reason required, every earlier version kept) |
| **AI scribe** | Provider confirms the patient agreed → the browser records → uploads to a signed address → the server transcribes and drafts S/O/A/P. The draft is **offered**, never inserted or signed on its own; signing it needs an explicit "I have reviewed it" |
| Admin → **Macro sets** | Shared macro sets by section and provider role. Providers keep personal macros too |
| Front Desk | Sees only whether a note exists and is signed on each appointment, never what it says |

**Two stores, on purpose.** `DocumentationDraft` is a mutable scratchpad (optimistic `version`, so two tabs
cannot silently overwrite each other). `VisitNote` is the record and its amendment model is unchanged
(insert-only, `amendsId` chain). **Signing** copies the draft into VisitNote rows (S, O, A, P, or one GENERAL note
carrying the session's duration), writes an append-only `NoteSignature` (account, **provider role used**, time,
which notes, whether an AI draft was the starting point), deletes the draft and marks the visit `SEEN` — all in
one transaction under the Booking row lock. The database now rejects UPDATE/DELETE/TRUNCATE on `VisitNote` and
`NoteSignature`.

**Who may do what.** Front desk: nothing clinical. Provider: read anything, write visits booked with their own
role. Admin: read only (an admin who also holds a provider role writes as that role). Every clinical route
needs the authenticator first.

**The scribe never runs on stubs in production.** FileStorage and AiScribe are local stubs until real adapters
exist; in production, while either is a stub, the scribe switches itself off (`503 scribe_unavailable`, and the
workspace says why) and the rest of documentation keeps working. `ALLOW_STUB_INTEGRATIONS=true` lifts that for a
**staging deployment that holds only fake patients**. Audio, transcript and draft are audited on every read and
write and are never logged — nor are adapter error messages, which can quote their input.
`docs/PHASE4_NOTES.md` lists the AWS resources and variables the real adapters need.

**Audio retention.** Raw visit audio is deleted `AUDIO_RETENTION_DAYS` (default 30) after the note is **signed**, by a
step of `npm run jobs:run`. The transcript and the AI draft stay with the visit. Each deletion is audited (reason and
period, never the key); a failed delete is retried on the next run and is never marked done; a visit whose note is
unsigned is never purged. With the development stub storage a file lives on the disk of the process that wrote it,
so a cron job cannot delete what the web service wrote — real storage has no such split.

**Amendments and addenda.** Only the provider who **signed** a note can amend it (the amendment model itself is
unchanged). Any other provider-role account adds an **addendum** instead: a new entry linked to the note, attributed to
them, that never changes (the database refuses to edit or delete one) and changes nothing it is linked to. An
administrator has no write path to either.

### Scheduled jobs

Texts, the monthly credit grant and credit expiry are jobs, not part of any request, so something must run them. Pick one:

```bash
npm run jobs:run      # run every job once and exit (texts, monthly credit grant, credit expiry). The blueprint's `nextwave-jobs` Cron Job runs
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
| GET | `/api/fd/appointments/:id/checkout-preview` | front desk, admin | Price, balance and every way the visit can be paid |
| POST | `/api/fd/appointments/:id/check-out` | front desk, admin | **Settle the visit** — body `{ payment: CREDITS \| PERK \| CASH }`; one revenue event; idempotent |
| GET | `/api/fd/patients/:id/credits[?before]` | front desk, admin | Membership, balance, lots, perks, paged history |
| POST | `/api/fd/patients/:id/credits/adjust` | **admin** | Add or remove credits; reason code from a fixed list |
| POST · PATCH | `/api/fd/patients/:id/membership` | front desk, admin | Enrol / change plan, pause, resume, cancel |
| POST | `/api/fd/patients/:id/perks/:perkId/use` | front desk, admin | Use a perk not tied to a service (guest passes) |
| GET | `/api/membership-plans` | staff | The tiers, for the enrol dialog |
| GET · PATCH | `/api/admin/membership-plans` · `/:id` · `/:id/perks/:perkId` | admin | Tiers and perks as data; audited before → after |
| GET | `/api/sms/consent-label` | — | The exact words for the booking widget's text-consent checkbox |
| POST | `/api/bookings/:id/sms-consent` | — (booking id; ≤ 30 min old; rate limited) | Record the tick and the words shown |
| POST | `/api/sms/inbound` | provider signature | STOP / START / HELP / C |

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
TOTP for admins and providers and an audit trail exist (see *Staff accounts and security*).
They have been tested but not independently reviewed, and a HIPAA review is still
needed before real patient data lands in this database. See `docs/PHASE1_NOTES.md`
for the list of things to verify by hand.

**Clinical notes are medical records.** `VisitNote` is amend-only — correcting a
note inserts a new row and preserves the original verbatim; there is no PATCH and
no DELETE. The author and the provider role used are taken from the signed-in
session, never the request body. Phase 4 adds the provider workspace (draft →
sign, with the amendment model unchanged) and the database now refuses to edit or
delete a note or a signature. The older `POST /api/visit-notes/:id/amend` still lets
**any provider** amend **any** note (the workspace only offers it for the booked
role) — see `docs/PHASE4_NOTES.md` §7.

**No EHR export exists.** `GET /api/patients/:id/history` returns the compiled
record in the shape an export would be built from, but there is no FHIR or HL7
mapping. Spec §8.5.

**Not built** (nobody specified them): patient-facing booking UI, recurring
appointment expansion (`isRecurring` is stored but never acted on), a real SMS provider
(texts go to a local stub until Twilio is wired in), cancellation or reschedule texts, email
confirmations, payment processing, void of a check-out, cancellation windows, provider
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
| `npm run jobs:run` | Run every scheduled job once (appointment texts, monthly credit grant, credit expiry) and exit — see *Scheduled jobs* |
| `npm run sms:templates` | Rewrite `docs/SMS_TEMPLATES.md` (every text, its length and segment cost) from `templates.ts` |
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
