# NextWave Wellness — Scheduling Engine Technical Specification

## 1. System Overview & Tech Stack
* **Database:** PostgreSQL (Render Managed Postgres)
* **ORM:** Prisma ORM
* **Backend API:** Node.js / TypeScript (Express or Next.js API Routes)
* **Frontend UI Framework:** FullCalendar.io (Resource TimeGrid Plugin)
* **Concurrency Strategy:** Transactional Row-Locking (`SELECT ... FOR UPDATE`)

---

## 2. Database Schema (Prisma)

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

enum StaffRole {
  CHIROPRACTOR
  NURSE_PRACTITIONER
  REGISTERED_NURSE
}

enum BookingStatus {
  HOLD
  PENDING_REVIEW
  CONFIRMED
  DECLINED
  CANCELLED
}

model User {
  id        String    @id @default(uuid())
  name      String
  email     String
  phone     String
  createdAt DateTime  @default(now())
  bookings  Booking[]
}

model Staff {
  id        String          @id @default(uuid())
  name      String
  role      StaffRole
  schedules StaffSchedule[]
  bookings  Booking[]
}

model StaffSchedule {
  id        String   @id @default(uuid())
  staffId   String
  dayOfWeek Int      // 1 (Monday) to 7 (Sunday)
  startTime String   // "08:00"
  endTime   String   // "17:00"
  staff     Staff    @relation(fields: [staffId], references: [id])
}

model Resource {
  id          String    @id @default(uuid())
  name        String    // e.g., "IV Chair 1", "Hyperbaric Chamber"
  type        String    // "IV_CHAIR", "CHAMBER", "RED_LIGHT_BED", "CONSULT_ROOM"
  maxCapacity Int       @default(1)
  bookings    Booking[]
}

model Service {
  id           String    @id @default(uuid())
  category     String    // "Chiropractic", "Functional Medicine", "Longevity"
  name         String
  durationMin  Int
  bufferMin    Int
  requiredRole StaffRole
  resourceType String
  bookings     Booking[]
}

model Booking {
  id            String        @id @default(uuid())
  userId        String
  serviceId     String
  resourceId    String
  staffId       String?
  subOption     String?       // Selected panel, peptide, or vitamin shot
  startTime     DateTime
  endTime       DateTime
  holdExpiresAt DateTime?     // Set to now() + 10 mins when status = HOLD
  status        BookingStatus @default(HOLD)
  isRecurring   Boolean       @default(false)
  createdAt     DateTime      @default(now())

  user     User     @relation(fields: [userId], references: [id])
  service  Service  @relation(fields: [serviceId], references: [id])
  resource Resource @relation(fields: [resourceId], references: [id])
  staff    Staff?   @relation(fields: [staffId], references: [id])
}
```

> **As built:** every model above is implemented exactly as written — no field
> was removed or retyped. Three things were added on top:
>
> 1. **Indexes.** `Booking` on `(resourceId, startTime, endTime)`,
>    `(staffId, startTime, endTime)`, `(status, startTime)` and `startTime`.
>    The availability scan and the review queue are unusable without them.
> 2. **`Booking.patientNote String?`** — patient-supplied context captured at
>    booking time. See §8.
> 3. **`model VisitNote` + `enum NoteKind`** — attributed, amend-only clinical
>    notes, added after the initial build. See §8.
>
> The live schema is `server/prisma/schema.prisma`; treat it as authoritative
> over the snapshot above.

---

## 3. Availability Engine

`GET /api/availability?serviceId=<uuid>&date=<YYYY-MM-DD>`

Returns every open 15-minute start for one service on one clinic-local day.
Implemented in `server/src/lib/availability.ts` as `computeDayAvailability`,
which is the **single source of truth for bookability** — the hold path calls
the same function rather than reimplementing the rules.

### 3.1 The four gates

A slot is offered only when all four hold simultaneously:

1. **Clinic hours** — the appointment fits inside the published window for that
   weekday.
2. **Provider rostered** — someone with the service's `requiredRole` has a
   `StaffSchedule` row covering the appointment.
3. **Provider free** — that person has no conflicting booking *anywhere in the
   building*.
4. **Room capacity** — some `Resource` of the service's `resourceType` has
   `maxCapacity` minus overlapping bookings > 0.

Effective concurrency for any service is therefore
`min(free rooms of type, free staff of role)`.

> **Decision (unspecified): staff contention is global, not per-service.**
> A registered nurse running an IV drip is unavailable for a lab draw at the
> same instant, even though those are different services in different rooms.
> This is why availability shows gaps that room capacity alone does not
> explain. The alternative — treating staff as per-service — would double-book
> humans, so this is not really optional, but it is worth knowing that it is
> the reason the grid looks sparser than the room count suggests.

### 3.2 Clinic hours

```
Mon–Fri  07:00 – 19:00
Sat      08:00 – 14:00
Sun      closed
```

> **Decision (unspecified): hours are config, not data.** Taken from
> `contact.html` and held in `CLINIC_HOURS` in `server/src/config.ts`. They are
> not a database table, so changing them is a deploy rather than a front desk
> action. Correct while hours are stable; move to a `ClinicHours` model if the
> practice wants to edit them, or once per-provider holidays and blackout dates
> are needed — neither is currently modelled.

### 3.3 Buffers

`Service.bufferMin` is **trailing turnaround**. A booking occupies its room and
its provider for `durationMin + bufferMin`.

> **Decision (unspecified): the appointment must end by close and by
> end-of-shift, but its buffer may run past both.** The strict reading — buffer
> must also fit — makes the last appointment of every day unbookable, which is
> almost certainly not intended. Under the rule as built, a 30-minute service
> with a 10-minute buffer can start at 18:30 against a 19:00 close.

Buffers are applied at query time from each booking's own service, not baked
into `Booking.endTime`. `endTime` is the clinical end of the appointment, so it
is what a patient should be told.

### 3.4 Slot grid

Starts are aligned to 15-minute boundaries **on the local wall clock**, not on
epoch time, so a half-hour-offset timezone still yields :00/:15/:30/:45.
Granularity is `config.slotGranularityMin`.

Slots in the past are never offered. The booking horizon is
`config.maxAdvanceDays` (90).

### 3.5 What blocks a slot

| Status | Blocks? |
|---|---|
| `CONFIRMED` | yes |
| `PENDING_REVIEW` | yes |
| `HOLD`, unexpired | yes |
| `HOLD`, expired | **no** |
| `DECLINED`, `CANCELLED` | no |

> **Decision (unspecified): `PENDING_REVIEW` reserves capacity.** An unreviewed
> request holds its slot against other patients. The alternative — letting
> requests overlap and resolving at approval time — means telling someone their
> request was declined for a reason they cannot see. The approval path
> re-checks capacity regardless (§5.3).

### 3.6 Timezone

Postgres stores UTC. Every wall-clock string — `StaffSchedule.startTime`,
`CLINIC_HOURS`, the `?date=` parameter, the dashboard grid — resolves against
`CLINIC_TIMEZONE`. All conversion is confined to `server/src/lib/time.ts` via
Luxon, so DST is handled in exactly one place.

> **Resolved:** `CLINIC_TIMEZONE` is **`America/Chicago`** — US Central,
> confirmed by the practice. This is an IANA zone name, not a fixed offset, so
> it resolves to CST (UTC−6) in winter and CDT (UTC−5) in summer on its own.
>
> Pinning a literal `-06:00` would look correct today and silently drift every
> appointment by an hour from the second Sunday in March. **Never replace this
> with an offset.** Verified across both 2026 transitions — 07:00 local maps to
> 13:00Z in January and 12:00Z in July, and stays 07:00 on the wall clock on
> both sides of each switch.

### 3.7 Response

```jsonc
{
  "serviceId": "…", "serviceName": "Manual Adjustment",
  "date": "2026-08-12", "timezone": "America/Chicago",
  "durationMin": 30, "bufferMin": 5,
  "slots": [
    {
      "start": "2026-08-12T11:00:00.000Z",  // appointment start, UTC
      "end":   "2026-08-12T11:30:00.000Z",  // clinical end, excludes buffer
      "localTime": "07:00",                  // for display
      "resourceIds": ["…"],                  // rooms with a seat left
      "staffIds": ["…"],                     // rostered and unconflicted
      "remainingCapacity": 2
    }
  ],
  "closedReason": "The clinic is closed on this day."  // only when slots is empty
}
```

`closedReason` distinguishes *closed*, *nobody rostered*, and *fully booked*,
so the UI can say which rather than showing a bare empty state.

---

## 4. Holds & Concurrency

`POST /api/holds` → claim a slot for `HOLD_TTL_MINUTES` (default 10).

### 4.1 Why the lock is on `Resource`, not `Booking`

The spec (§1) calls for `SELECT … FOR UPDATE`. The obvious reading — lock the
conflicting `Booking` rows — **cannot work**, and this is the single most
important departure in the implementation.

Two people racing for the same *empty* slot both find zero conflicting
bookings. There is nothing to lock, both proceed, both insert. That is a
write-skew phantom: a row lock cannot guard a row that does not exist yet.

So each hold takes `FOR UPDATE` on the `Resource` rows of the required type
*before* evaluating anything:

```sql
SELECT id FROM "Resource" WHERE type = $1 ORDER BY id FOR UPDATE;
SELECT id FROM "Staff"    WHERE role = $2 ORDER BY id FOR UPDATE;
```

Those rows always exist, so the lock always bites. Attempts on the same room
type serialize; attempts on unrelated room types stay fully parallel. Locks are
always taken **Resource then Staff, each ordered by `id`**, so two transactions
cannot acquire them in opposite orders and deadlock.

Inside the lock the engine **re-runs `computeDayAvailability`** and re-proves
the slot. What the browser was shown is never trusted.

Verified: `./scripts/race-test.sh` fires N simultaneous holds at the single
X-Ray Suite. 15 concurrent → exactly 1 × `201`, 14 × `409`. On the 2-seat lab
station the same test yields exactly 2 winners.

### 4.2 Session token

> **Decision (unspecified): the hold id *is* the session token.** The schema has
> no session-token column and does not need one — `Booking.id` is already a v4
> UUID, unguessable and scoped to exactly one slot. The browser stores
> `{ holdId, expiresAt }` in `localStorage` and presents the id to confirm or
> release. Adding a separate token column would be a second secret protecting
> the same object.

Consequence: anyone holding the id can release or confirm that hold. For an
anonymous pre-booking flow this is the same trust model as an unguessable
link. It is not sufficient once a patient can view booking *history*.

### 4.3 Expiry

Expiry is decided by the `holdExpiresAt` **timestamp**, not by a job — an
expired hold stops blocking the instant its timestamp passes, whether or not
any sweeper has run. Correctness never depends on the cleaner.

The 60-second sweep in `index.ts` is housekeeping only: it deletes lapsed holds
and their placeholder users so the table does not accumulate junk.

### 4.4 Placeholder users

> **Decision (forced by schema): holds create a throwaway `User`.**
> `Booking.userId` is `NOT NULL`, but a hold is taken *before* the patient
> types their details. `POST /api/holds` therefore inserts a
> `"Pending guest"` row, which `POST /api/bookings` fills in and the sweeper
> deletes if the hold lapses. Making `userId` nullable would remove this
> entirely — see §7.

### 4.5 Other hold endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/holds/:id` | Is the stored token still valid? Returns `active` / `expired`. |
| `DELETE` | `/api/holds/:id` | Patient backed out — frees the slot immediately rather than waiting out the TTL. |

---

## 5. Booking Lifecycle

```
HOLD ──POST /api/bookings──▶ PENDING_REVIEW ──PATCH──▶ CONFIRMED ──PATCH──▶ CANCELLED
                                            └────────▶ DECLINED
```

### 5.1 Legal transitions

| From | May become |
|---|---|
| `HOLD` | `CANCELLED` |
| `PENDING_REVIEW` | `CONFIRMED`, `DECLINED` |
| `CONFIRMED` | `CANCELLED` |
| `DECLINED` | — terminal |
| `CANCELLED` | — terminal |

Anything else returns `409`. Re-applying the current status is a no-op `200`,
so a double-clicked Approve is harmless.

> **Decision (unspecified): nothing past `PENDING_REVIEW` is ever hard-deleted.**
> Declining and cancelling are status changes, so the front desk keeps its
> history. Only unclaimed holds are deleted outright.

### 5.2 Promoting a lapsed hold

If the hold expired between the browser's last check and the submit, the slot
is **re-proved under the resource lock** rather than trusted or rejected
outright. Still free → the booking proceeds. Taken → `410 Gone` with an
instruction to pick another time. A patient who fills the form slowly is not
punished for it if nobody else wanted the slot.

### 5.3 Approval re-checks capacity

`PATCH … {"status":"CONFIRMED"}` re-takes the resource lock and counts
overlapping `CONFIRMED` bookings against `maxCapacity` before committing. This
catches the case the front desk cannot see: two pending requests for the same
chair, approved seconds apart. The second gets a `409` naming the room rather
than a double-booking.

### 5.4 Front desk authentication

> **Decision (unspecified): a single shared secret**, sent as an
> `x-front-desk-token` header and compared with `timingSafeEqual`.
> This is the smallest thing that keeps the queue off the public internet.
> It is **not** per-user auth: no staff logins, no record of who approved what,
> and one leaked token exposes every patient record behind it. See §7.

---

## 6. Front Desk Dashboard

`GET /dashboard.html` — master resource grid.

> **Decision (cost): built by hand, not with FullCalendar.** §1 specifies the
> FullCalendar Resource TimeGrid plugin. That plugin is **FullCalendar Premium**
> — a paid commercial licence (~$480/yr), and the practice is a commercial
> user. The view needed here is narrow (fixed room columns, fixed 15-minute
> rows, one day at a time), so it is ~260 lines of plain JS in
> `server/public/dashboard.js` with no dependency and no licence. Revisit if
> the front desk later wants drag-to-reschedule, multi-day views or resource
> grouping — that is where FullCalendar starts earning its price.

Delivered: room columns, 15-minute rows, sticky time gutter, status colour
codes, hatched buffer tails, side-by-side lanes when a multi-capacity room runs
concurrent patients, click-through detail dialog, approve/decline actions, a
pending-review queue, and a 30-second auto-refresh.

| Status | Colour |
|---|---|
| `CONFIRMED` | sage `#7C8F7A` |
| `PENDING_REVIEW` | brass `#B9A77C` |
| `HOLD` | grey, dashed edge |
| `DECLINED` | muted red, faded |
| `CANCELLED` | grey, struck through |

Palette is lifted from `assets/style.css` so the internal tool reads as the same
product as the public site.

Data comes from two token-gated endpoints: `GET /api/front-desk/schedule?date=`
(columns + bookings + the open window) and `GET /api/front-desk/pending` (the
review queue).

---

## 7. Open Decisions

Numbered for reference. None of these are blocking a demo; items 5 and 6 block
a launch with real patients.

1. ~~**`CLINIC_TIMEZONE`** is unverified.~~ **Resolved — `America/Chicago`
   (US Central), confirmed by the practice.** *(§3.6)*
2. ~~**`Service` has no `slug`.**~~ **Resolved — see §9.** Added as
   `slug String` (deliberately not `@unique` — the two hyperbaric rows share
   one marketing page).
3. **`Service` has no `price`.** Pricing lives only in the service pages'
   markup, so the API cannot quote a total or apply the member discount.
4. ~~**`Booking` has no `notes`.**~~ **Resolved — see §8.** Implemented as two
   distinct things: `Booking.patientNote` for patient-supplied context, and a
   `VisitNote` model for attributed, amend-only clinical notes.
5. **Auth is one shared token.** No staff identity, no audit trail of who
   approved what. Not sufficient for live PHI. *(§5.4)*
6. **No HIPAA review.** This database holds name, email, phone and appointment
   history. That is PHI once it is real.
7. **`isRecurring` is stored but never acted on.** Nothing expands a recurring
   booking into a series.
8. **Seed data is placeholder.** All six staff names and their shifts are
   invented. Room counts (4 IV chairs, 2 red light beds, 2 lab seats) are
   guesses and directly cap daily throughput. Service durations and buffers are
   estimates except where a service page states one; names, categories and the
   60/90 hyperbaric split are real.
9. **Not built, because unspecified:** patient-facing booking UI, email/SMS
   confirmations, membership-credit integration, cancellation windows, provider
   time-off and blackout dates, automated tests beyond the race script.
---

## 8. Clinical Notes & Patient History

Added after the initial build. The requirement — *"doctors can also add notes
for each visit, then compile these together for a patient history"* — is not a
`notes` column. It is three different things with different authorship,
privacy and retention rules, so it is modelled as three things.

| Layer | Written by | Model | Mutable? |
|---|---|---|---|
| Booking context | the patient, at booking | `Booking.patientNote` | yes — it is their own text |
| Clinical note | a provider, after the visit | `VisitNote` | **no — amend-only** |
| Patient history | nobody; it is compiled | `GET /api/patients/:id/history` | derived |

> **Decision: patient text and clinical text are never the same field.**
> "Recovering from knee surgery" typed into a booking form is not a medical
> record and must not acquire the authority of one. The dashboard renders them
> in visibly different treatments for the same reason.

### 8.1 `VisitNote` is a medical record

```prisma
enum NoteKind { SUBJECTIVE OBJECTIVE ASSESSMENT PLAN GENERAL }

model VisitNote {
  id          String   @id @default(uuid())
  bookingId   String
  authorId    String              // REQUIRED
  kind        NoteKind @default(GENERAL)
  body        String
  createdAt   DateTime @default(now())
  amendsId    String?  @unique    // this row supersedes that one
  amendReason String?             // required when amending
  …
}
```

Three properties, each deliberate:

1. **`authorId` is required.** An unattributed clinical note is not a valid
   record, and authorship cannot be reconstructed later. There is no code path
   that writes a note without one.
2. **Nothing is ever updated in place.** "Editing" a note inserts a new row
   pointing at the old one via `amendsId`; the original text survives verbatim
   along with who wrote it and when. `@unique` on `amendsId` keeps the chain
   linear, so a superseded version cannot be amended twice into a fork. There
   is **no `PATCH` and no `DELETE`** for notes — the API surface makes
   destroying a record impossible, not merely discouraged.
3. **Nothing cascades.** `Booking` and `Staff` both use `onDelete: Restrict`,
   so a booking carrying clinical notes cannot be deleted out from under them.

The *effective* text of a note is the tail of its amendment chain — the row
nothing else amends. `server/src/lib/notes.ts` resolves this; the current
version is returned as the note, with every superseded version beneath it as
`history`, ordered by when the **original** was written so a corrected note
keeps its place in the clinical timeline instead of jumping to the end.

> **Decision: SOAP for `NoteKind`.** Subjective / Objective / Assessment / Plan
> is the standard structure for chiropractic and clinical notes, and maps
> directly onto FHIR `Composition` sections if this is ever exported.
> `GENERAL` is the catch-all.

### 8.2 Notes require a real visit

`POST /api/bookings/:id/notes` refuses with `409` on a `HOLD` or
`PENDING_REVIEW` booking. A clinical note about a visit that has not been
confirmed is almost always a mis-click, and it would pollute the history of a
request that may yet be declined.

### 8.3 Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/bookings/:id/notes` | Write a clinical note |
| `POST` | `/api/visit-notes/:id/amend` | Supersede a note — insert, never update |
| `GET` | `/api/bookings/:id/notes` | Notes for one visit, chains resolved |
| `GET` | `/api/patients?email=` | Find a patient |
| `GET` | `/api/patients/:id/history` | **The compiled record** |
| `GET` | `/api/front-desk/staff` | Author picker |

All are token-gated — every one of them returns or accepts PHI.
`POST /api/bookings` additionally accepts `patientNote`.

History includes only `CONFIRMED` and `CANCELLED` bookings. Holds and declined
requests are not visits and do not belong in a clinical record.

### 8.4 Authorship is currently *claimed*, not *proven*

> **Decision (interim): `authorId` comes from the request body.** With no staff
> logins, the dashboard sends which provider is writing, and the server only
> checks that the id names a real staff member. The **data model** is correct —
> no note is ever unattributed, and that cannot be backfilled later — but the
> **attribution is not yet trustworthy**: anyone with the shared token can
> write a note as any provider.
>
> When staff accounts land, `authorId` must come from the session and the
> request body field must be dropped. This is the single most important
> follow-up in this document.

### 8.5 Export

`GET /api/patients/:id/history` returns the compiled record in the shape an
export would be built from — visits in chronological order, each with the
patient's own note, the provider, and the resolved clinical notes.

**There is no EHR export yet.** No FHIR mapping, no HL7, no file generation.
The mapping is mechanical when wanted — `Booking` → `Encounter`, `VisitNote` →
`Composition` with SOAP sections, `User` → `Patient` — but nothing implements
it. See §7.9.

### 8.6 This changes the compliance picture

Before this section, the database held appointment metadata. It now holds
**clinical records about patients**, which raises the stakes on items already
open in §7:

- §7.5 (one shared token, no staff identity, no audit of who read what) moves
  from *before launch* to **blocking**. Clinical notes without per-user auth
  cannot be attributed or audited.
- §7.6 (no HIPAA review) is no longer theoretical.
- Retention, patient access requests, and breach notification all now apply.
  None of them are implemented.

---

## 9. Marketing Site Integration

The static marketing site and the booking app are separate deployments. This
section covers how a "Book now" button on a service page hands off to the
scheduling engine.

### 9.1 `Service.slug`

```prisma
slug String   // NOT @unique — see below
@@index([slug])
```

The slug is **the service page's filename minus `.html`** — `manual-adjustment`,
`biomarker-testing`, `spinal-xrays`. This is the same convention the contact
form already uses for `?interest=<slug>` (see the root `CLAUDE.md`), so the
site now has one identifier scheme rather than two.

> **Decision: `slug` is not unique.** `hyperbaric-oxygen-therapy` maps to *two*
> Service rows — the 60- and 90-minute sessions are sold as separate services
> at separate prices but share one page. A unique constraint would have forced
> either two fake page slugs or a merged service row, both worse than allowing
> the duplicate. The client resolves it by taking the shortest duration when a
> slug matches more than one row; a `?duration=` parameter can disambiguate
> when that page is wired.

Backfill: the migration adds the column nullable, fills the 15 known seed rows
by their fixed UUIDs, name-derives a slug for anything unexpected, then applies
`NOT NULL`. A plain `ADD COLUMN ... NOT NULL` fails on a populated table.

### 9.2 The handoff

```html
<a href="https://nextwave-scheduling.onrender.com/?service=manual-adjustment"
   class="btn btn-primary">Book now</a>
```

`?service=<slug>` puts the booking app into a **locked** state: the service
picker is replaced by a single confirmation bar naming the chosen service, and
the flow opens directly on "Choose a day".

> **Decision: skip step 1 rather than pre-select it.** A patient who clicked
> "Book now" on the manual adjustment page has already told us what they want.
> Showing them fifteen services with one highlighted asks the same question
> twice. An escape hatch — "Not what you meant? Choose a different service" —
> restores the full list, so the deep link is a shortcut rather than a trap.

Unknown slug (a renamed page, a typo) falls back to the full picker with a
toast, never a dead end.

### 9.3 Rollout status

**Only `manual-adjustment` is wired.** The other 13 service pages still carry
the disabled `Book now` placeholder. Enabling them is a scripted edit across
all 13 — the same pattern the root `CLAUDE.md` prescribes for any change that
touches every page — but it should not happen until the target URL is settled.

> **The URL is temporary.** Every wired button hard-codes
> `nextwave-scheduling.onrender.com`, which is a free-tier demo host that sleeps
> after 15 minutes and whose database expires 90 days from creation. Before
> wiring the remaining 13, decide the permanent home (a `booking.` subdomain
> pointed at the service is the obvious answer) so the mass edit happens once.

> **Do not merge this to `main` casually.** `main` auto-deploys to the live
> marketing site. Merging makes a real "Book now" button on nextwave-wellness.com
> point at a demo carrying a *DEMO — sample data* banner and a Basic Auth
> prompt. That is a worse experience than the current disabled button. See §7.5
> and §7.6 — the booking flow is not ready for real patients until staff auth
> and a HIPAA review are done.
