# NextWave Scheduling Engine

Booking backend for nextwave-wellness.com. Express + TypeScript + Prisma +
PostgreSQL, with a hand-built front desk grid. Runs alongside the static
marketing site — nothing in the 19 HTML pages changed.

## Run it

```bash
npm install
cp .env.example .env        # then set DATABASE_URL
npx prisma migrate dev
npm run seed
npm run dev
```

- Patient booking — <http://localhost:4000/>
- Front desk — <http://localhost:4000/dashboard.html>
- API — <http://localhost:4000/api/…>

The dashboard asks for `FRONT_DESK_TOKEN` once and keeps it in `localStorage`.

## Deploying the demo to Render

`server/render.yaml` is a Blueprint that provisions the Postgres instance and
the web service together and wires `DATABASE_URL` between them.

1. Push this branch to GitHub.
2. Render → **New → Blueprint** → connect the repo → point it at
   `server/render.yaml`.
3. Render prompts for the two `sync: false` values — pick a username and
   password for `DEMO_USER` / `DEMO_PASSWORD`. That pair is the Basic Auth
   credential you hand to anyone you want in.
4. Deploy. The build runs `prisma migrate deploy`, so the schema is created
   automatically.
5. **Seed it.** Migrations create empty tables; the rooms, services and staff
   come from the seed. In the Render shell for the service:
   `npm run seed`
6. Grab `FRONT_DESK_TOKEN` from the service's Environment tab (Render generates
   it) — that is what signs you into the front desk grid.

Two free-tier caveats worth knowing before you demo: the web service **sleeps
after ~15 minutes idle**, so the first request back takes ~30 seconds, and free
Postgres **expires after 90 days**. Move both to a paid plan if this outlives
the experiment.

### Access model for the demo

| Layer | Protects | Credential |
|---|---|---|
| HTTP Basic Auth | everything except `/health` | `DEMO_USER` / `DEMO_PASSWORD` |
| Front desk token | the 12 staff/clinical endpoints | `FRONT_DESK_TOKEN` |

Basic Auth is a **curtain, not a security model** — one shared credential, no
identity behind it. It exists so the demo is not protected by nothing more than
an unlisted URL. It is not a substitute for the staff auth in spec §7.5, and it
should be removed rather than relied on when real patient data lands.

`/health` is deliberately exempt so Render's health checks pass.

## How availability is decided

`src/lib/availability.ts` is the single source of truth. A 15-minute slot is
offered only when all four hold at once:

1. the appointment fits inside published clinic hours for that weekday
   (Mon–Fri 07:00–19:00, Sat 08:00–14:00, Sun closed — from `contact.html`)
2. a provider of the service's `requiredRole` is rostered across it
3. that provider has no conflicting booking **anywhere** — staff contention is
   global, so an RN on an IV drip is unavailable for a lab draw
4. a room of the service's `resourceType` has spare capacity

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

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/services` | — | Service picker |
| GET | `/api/availability?serviceId&date` | — | Open 15-min starts for one day |
| POST | `/api/holds` | — | Claim a slot for 10 min |
| GET | `/api/holds/:id` | — | Is my held slot still good? |
| DELETE | `/api/holds/:id` | — | Release early |
| POST | `/api/bookings` | — | Hold → `PENDING_REVIEW` |
| GET | `/api/bookings/:id` | — | Patient status check |
| PATCH | `/api/bookings/:id` | token | Approve / decline / cancel |
| GET | `/api/front-desk/schedule?date` | token | Grid data |
| GET | `/api/front-desk/pending` | token | Review queue |
| GET | `/api/front-desk/staff` | token | Note-author picker |
| POST | `/api/bookings/:id/notes` | token | Write a clinical note |
| POST | `/api/visit-notes/:id/amend` | token | Supersede a note (never updates) |
| GET | `/api/bookings/:id/notes` | token | Notes for one visit |
| GET | `/api/patients?email=` | token | Find a patient |
| GET | `/api/patients/:id/history` | token | Compiled patient record |

Front desk routes need `x-front-desk-token`.

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

**Auth is a shared secret.** One token for the whole front desk: no staff
logins, no record of who approved what. Fine for a hidden internal page,
**not sufficient for live PHI** — replace with real staff accounts, and get a
HIPAA review before real patient data lands in this database.

**Clinical notes are medical records.** `VisitNote` is amend-only — correcting
a note inserts a new row and preserves the original verbatim; there is no PATCH
and no DELETE. `authorId` is required so nothing is ever unattributed. **But
authorship is currently *claimed*, not *proven*:** with no staff logins the
dashboard sends which provider is writing, and anyone with the shared token can
write as any provider. When staff accounts land, `authorId` must come from the
session and the body field must be dropped. See spec §8.4.

**No EHR export exists.** `GET /api/patients/:id/history` returns the compiled
record in the shape an export would be built from, but there is no FHIR or HL7
mapping. Spec §8.5.

**Not built** (nobody specified them): patient-facing booking UI, recurring
appointment expansion (`isRecurring` is stored but never acted on), email/SMS
confirmations, membership-credit integration, cancellation windows, provider
time-off/blackout dates, automated tests beyond `scripts/race-test.sh`.

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Watch mode |
| `npm run seed` | Load the matrices (idempotent) |
| `npm run typecheck` | `tsc --noEmit` |
| `./scripts/race-test.sh [date] [n]` | Concurrency proof |
| `./scripts/demo-day.sh [date]` | Fill a day with mixed-status bookings — **dev only** |
| `./scripts/notes-test.sh [date]` | Notes lifecycle + amendment chain proof |
