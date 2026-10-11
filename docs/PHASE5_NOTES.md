# Phase 5 — Notes

What was built, what I assumed, what I changed from the plan, and what you need to verify by hand.
Written 2026-10-11 on branch `scheduling-engine`.

**Nothing has been pushed or deployed.** Everything is committed locally on `scheduling-engine`
(`0f7c989..HEAD`; `git log --oneline 0f7c989..HEAD`), each commit typechecked and tested before it was made. I applied the four new migrations
(`…_note_addenda`, `…_audio_retention`, `…_discount_categories`, `…_phase5_reporting`) to your dev database, as in earlier
phases. The discount migration refuses to run if any tier already has a percentage; it ran, so none did.
The marketing site is not touched by this phase (`main` is level with `origin/main`).

## Read this first — five things that are not what you might assume

1. **The app does not send texts through Twilio yet.** There is no Twilio sending adapter: `integrations/index.ts` selects
   `StubMessaging`, which records the text and sends nothing. The Twilio variables below only (a) let the app **verify the
   signature of Twilio's inbound webhook** (STOP / START / HELP / C) and (b) put the right sender number and clinic phone
   into the wording. Verification approval does not change this: confirmations and reminders will not reach a phone until
   a `TwilioMessaging` adapter is built behind the existing `Messaging` interface (it needs the account SID as well). I did
   not build it because there are no credentials to test it against. Say go and I will.
2. **No discount is enabled, and none will be until you approve `docs/DISCOUNT_MAPPING.md`.** The model is now a percentage
   per tier per service category, admin-editable (decision 2 below). The table I derived from `membership.html` is written
   up with the five places the site contradicts itself. Perks stay off.
3. **Accounting does not include membership dues.** Nothing in the system records a member's monthly payment (Phase 3 never
   built one; SPEC A-13 assumed "dues recorded when collected"). Revenue here is what the desk **recorded at check-out**.
   A member's $0 visit shows its list value in its own column, so the arithmetic still closes (§3.1), but a month's real
   income = this + dues collected elsewhere. Every Accounting screen says so under "How these numbers are made".
4. **I found and fixed a time-zone bug in three queries from earlier phases** (§6). It is invisible on a database whose clock
   is set to UTC and wrong by the offset on any other. I cannot tell from here which your production database is — the
   staging checklist has the one command that does (`SHOW timezone`).
5. **The demand categories follow SPEC assumption A-6, not "existing service categories".** The booking app's `Service.category` has
   three values (Chiropractic, Functional Medicine, Longevity), too coarse for your six. A-6 already lists which services go in
   which, so I used it (§3.4). Vitamin shots and body composition fall in **Other**, as A-6 says.

---

## 1. Your six decisions

| # | Decision | Status | Where |
|---|---|---|---|
| 1 | Clinic phone default, text sender default, bring `contact.html` across, tell you the Twilio variable names | ✅ — see below, and gap 1 above | `clinicContact.ts`, `config.ts`, `contact.html` |
| 2 | Discounts: percentage per tier per service category, admin-editable; derive the mapping from `membership.html`, write it up, **stop** | ✅ model built, **nothing enabled**, table awaiting you | `docs/DISCOUNT_MAPPING.md`, Admin → Memberships |
| 3 | Only the signer can amend; others add an addendum; admin has no write path; versioning untouched | ✅ | `routes/notes.ts`, `lib/addenda.ts`, `tests/amendments.test.ts` (17) |
| 4 | Purge raw audio 30 days after signing; transcript and draft stay; env var, default 30; runs in `jobs:run`; each deletion audited | ✅ | `jobs/audioRetention.ts`, `tests/audio-retention.test.ts` (13) |
| 5 | Enable the same-day reminder with your wording; add to `SMS_TEMPLATES.md` | ✅ | `integrations/templates.ts`, `docs/SMS_TEMPLATES.md` |
| 6 | Render plan name | ✅ left as is | `render.yaml` |

### 1.1 The environment variables the app reads for texting
| Variable | What it does | If missing |
|---|---|---|
| `TWILIO_AUTH_TOKEN` | Verifies the signature on `POST /api/sms/inbound` | In production the webhook answers **503** and acts on nothing |
| `TWILIO_FROM_NUMBER` | The number texts are sent *from*. Default **`+18665241007`** | Uses the default. A value that is not E.164 makes the app **refuse to start** |
| `CLINIC_PHONE` | The phone number in replies (HELP) and texts. Default **`(308) 830-1951`**, the number on `contact.html` | Uses the default |
| `APP_BASE_URL` | The public address; the webhook signature is checked against `APP_BASE_URL` + `/api/sms/inbound` | Signature checks fail if it differs from what is typed in Twilio |
| `TWILIO_ACCOUNT_SID` | Reserved for the sending adapter. **Nothing reads it today** | — |

Set them on **both** the web service and the cron job. `contact.html` on this branch now carries the address
(Lakeside Terrace, 110 S. 243rd St., Waterloo, NE 68069) and the phone, so `contact-page.test.ts` — which compares the
number the page shows with the one the server defaults to — passes.

### 1.2 Discounts
`DiscountCategory`, `PlanCategoryDiscount` (tier × category → whole percent), `Service.discountCategoryId` (a service is in
**one** category or none), and a `RevenueEvent.discountCategory` snapshot. `MembershipPlan.discountPercent` is gone (a
guard in the migration refuses to drop it if any tier has a non-zero value). Check-out takes the **tier's percent for the
service's category** off the list price when an **active** member pays **cash**; whole cents, halves up; credits and
perks are never discounted; a category can be switched off; every change is audited with its before and after.
**There are no categories and no percentages**, so every member pays list price exactly as before.
The mapping document proposes three categories (Spinal X-rays 20/20/20 %, Supplements 10/15/20 %, Special services
10 %, empty for now) and lists what I cannot decide for you: X-rays are 20 % on `membership.html` and 25 % on the X-ray
page; the IV, shots, Baseline and "included" claims differ between the pages (C1–C5). Nothing moves until you say so.

### 1.3 Amendments and addenda
`POST /api/visit-notes/:id/amend` now requires the account that **signed** the note (checked at the root of the chain);
anyone else gets `403 not_author`, audited. Any other provider-role account uses
`POST /api/visit-notes/:id/addendum` to add a `NoteAddendum`: a new signed entry linked to the note, attributed (account,
provider role, time), which the database refuses to edit or delete and which changes nothing it is linked to. An
administrator has **no** write path to either (`requireClinicalWrite`). The amendment model and its versioning are
unchanged. The workspace offers *Amend* to the signer and *Add addendum* to other providers.

### 1.4 Audio retention
`AUDIO_RETENTION_DAYS` (default 30; a value that is not a whole number ≥ 1 makes the app refuse to start). A step of
`npm run jobs:run` deletes the raw audio of a session `N` days after its visit's note was **signed**, sets
`ScribeSession.audioPurgedAt`, and writes one audit row per deletion (reason and period; never the key). The transcript and
the AI draft stay with the visit. A failed delete is retried on the next run and never marked done; an unsigned visit is
never purged; the run is idempotent. With the development stub storage a file lives on the disk of the process that
wrote it, so the cron job cannot delete what the web service wrote — real storage has no such split.

### 1.5 The same-day reminder
`appt_reminder_today_v1`: *"NextWave Wellness: Reminder for {first}: see you today at {time}. Reply STOP to opt out."* The job
uses it when the appointment is **today** by the clinic's calendar and the "tomorrow" wording when it is tomorrow. An
appointment booked less than a day ahead still gets only its confirmation (the `booked_inside_window` rule is unchanged).
This replaces the Phase 3 `same_day` skip.

---

## 2. Phase 5 — what was built

**Accounting** (administrators only) at `/app/accounting`, **Reports** (front desk and administrators) at `/app/reports`.
Providers see neither. Every view has a date-range picker that starts on the **current month in the clinic's calendar**
(the server says which month that is), a **totals row**, and a **CSV export** of exactly what is on screen.

| View | Answers | Built on |
|---|---|---|
| Accounting · Monthly by service | Revenue per service per month | `RevenueEvent` |
| Accounting · Daily | Revenue per clinic day | `RevenueEvent` |
| Accounting · Members vs. non-members | Four payment buckets and two subtotals | `RevenueEvent` |
| Accounting · Custom | Date range + **service**, **payment type**, **provider** filters, totalled by service / month / day / month+service / payment type / who paid / provider / discipline / discount category / tier | `RevenueEvent` |
| Reports · New memberships | Sign-ups per month, by tier | `Membership.startedOn` |
| Reports · Walk-ins by day, by hour | Confirmed walk-ins, clinic day and clinic hour, and their share of all visits | `Booking.source` |
| Reports · Weekend visits | Visits and no-shows by weekday; weekend share | `Booking` + `Encounter` |
| Reports · Service demand | Booked / attended / no-shows in your six categories (+ Other) | `Booking` + `Encounter` |

**Accounting columns:** Visits · **List price** · **Discount** · **Net** · **Covered by membership** · Credits redeemed. For every row
and the totals, `list = discount + covered + net`; a test holds it for every grouping.

**API** (all `GET`, all under `/api`):
`/accounting/options` · `/accounting/{monthly|daily|members|custom}` · `/reports/{signups|walkins-day|walkins-hour|weekend|demand}`,
each with `?from=YYYY-MM-DD&to=YYYY-MM-DD` (both or neither) and `&format=csv`; `custom` also takes `serviceId`,
`paymentType` (`CASH`|`MEMBER`), `providerId` and `group`. Anything else is refused with `400`, so a typo cannot quietly
return an unfiltered number. A range is clinic-local days, both ends included, at most five years.

**Aggregates only.** A response, JSON or CSV, is counts and sums grouped by a service, day, hour, month, tier, payment type
or provider. No patient, booking or encounter is named or identified: a test creates a patient with a distinctive name,
phone, e-mail and ids and searches every view in both formats for any of them. The only names are **providers** (staff),
and only when you total by provider.

**Audit.** Every successful view writes a `READ` row (`accounting_report` / `clinic_report`) and every CSV an `EXPORT` row,
carrying the view, the range and the filters exactly as asked (ids and dates, never a name or value). Views are **not
de-duplicated**: a second look is a second row. A refusal (front desk asking for Accounting) is an `ACCESS_DENIED` row.

---

## 3. Decisions and departures

### 3.1 What "revenue" is
`RevenueEvent`: `list` = the service's list price; `discount` = the member discount; `net` = what the desk collected
(`list − discount` for cash, **0** for a visit a membership covered); `covered` = `list − discount − net`, which is the list
value of a credit or perk visit and 0 for cash. The column is my addition: without it a credit visit would show a list price
and a $0 net with nothing to reconcile them, and A-13 asks for exactly that value "as a separate column". A service with
**no set price** paid with credits has no list value, so it adds 0 to list and covered (credits are still counted).

### 3.2 "Member" means an *active* member at check-out
A paused or cancelled member who pays cash is a non-member in these numbers, because they paid and were priced as one.
The four buckets: *Non-member — cash*, *Member — cash*, *Member — credits*, *Member — included perk*.

### 3.3 Membership dues are not in Accounting
See "Read this first", 3. Adding them needs a place to record a payment (amount, date, member) — a Phase 3 feature
that does not exist. If you want them here, that is the next thing to build, and the "members" view is where they would go.

### 3.4 Service demand uses A-6, by service slug, in code
Chiropractic = adjustment, spinal & postural exam, X-rays · HBOT (both durations) · Red light · IV · Consult = FM consult,
personal wellness planning, hormone optimization, peptide therapy, supplementation · Bloodwork = biomarker testing ·
**Other** = vitamin shots, body composition, and any service added later. SPEC A-6's build plan mentions a
`Service.reportGroup` column; I did not add one because it is 14 services and a code list is simpler and tested. The cost is
that a new service shows up under **Other** until someone adds it to `lib/reportFormat.ts` — a test pins exactly which
seeded services are in Other, so adding one fails the suite until it is decided. Say if you would rather have an admin-editable column.

### 3.5 Weekend, walk-ins, sign-ups
- **Weekend** is Saturday and Sunday by the clinic's calendar (A-17 says Saturday only because Sunday is closed; the table
  shows both, Sunday at 0, and it updates itself if hours change). A "visit" is a checked-in patient; no-shows are shown beside.
- **Walk-ins** are confirmed bookings with source *walk-in*, counted on the day and hour of the appointment's start. The
  share is walk-ins ÷ every checked-in visit in the range.
- **New memberships** counts `Membership` rows by the day they started. A patient who cancels and re-joins counts twice. A
  tier that is switched off appears only if someone joined it in the range.

### 3.6 `RevenueEvent.staffId` — the provider filter needed a column
A check-out recorded the service and the member but not who the visit was booked with. The new column is a snapshot taken
at check-out; the migration **backfills** every existing event from its booking: it lifts the append-only trigger for that one
`UPDATE` and puts it straight back, in the same file (a test runs the shipped statements, then proves the table rejects edits
again; on a database with no check-outs it touches no row). A room-only service with no provider shows as "Unassigned". It is the provider the visit was **booked
with**, not necessarily who gave the treatment.

### 3.7 Smaller decisions
- Every day, hour and month boundary is in **clinic time**, including
  the 23- and 25-hour daylight-saving days (tested across both changes, and at 23:59 on a month end).
- CSV: a leading byte-order mark (so a spreadsheet reads "—" correctly), `CRLF` lines, plain decimals for money, and a cell that
  starts with `= + - @` is prefixed with `'` so a spreadsheet cannot run it as a formula (a service name is typed by an admin).
- The export button **fetches** the file instead of linking to it, so a signed-out session or a refused range is said in words
  instead of downloading an error page.
- The custom view re-queries whenever a filter changes, so each change is its own audited view.
- The Accounting and Reports tiles on the module home are now real (`built: true`); they were placeholders.

---

## 4. Indexes and speed

**New indexes** (migration `…_phase5_reporting`): `RevenueEvent(staffId, occurredAt)`, `Booking(source, startTime)`,
`Membership(startedOn)`. **Already there and used:** `RevenueEvent(occurredAt)`, `Booking(status, startTime)`.
`scripts/perf-reports.mjs` (`npm run perf:reports`) builds a throwaway `nw_*` schema, migrates and seeds it, bulk-loads
**50,000 encounters** (about 54,000 bookings, 40,000 revenue events, 700 memberships) across three years, runs `ANALYZE`, then
times every view at three range sizes (median / worst of 7 runs after a warm-up, milliseconds, including the Node-side
shaping) and prints `EXPLAIN ANALYZE` for the very SQL the reports run. It drops the schema when done.

| View | Current month | 12 months | All 3 years |
|---|---|---|---|
| Accounting · monthly by service | 2 / 3 | 15 / 16 | 38 / 41 |
| Accounting · daily | 3 / 3 | 37 / 38 | 126 / 127 |
| Accounting · members vs. non-members | 1 / 2 | 6 / 7 | 14 / 15 |
| Accounting · custom (service + payment + provider, by day) | 2 / 2 | 2 / 3 | 4 / 4 |
| Accounting · by provider | 2 / 2 | 8 / 8 | 20 / 21 |
| Reports · new memberships | 1 / 7 | 1 / 3 | 2 / 3 |
| Reports · walk-ins (day, hour, share) | 10 / 14 | 19 / 24 | 40 / 42 |
| Reports · weekend visits | 9 / 9 | 23 / 24 | 55 / 56 |
| Reports · service demand | 9 / 10 | 27 / 28 | 67 / 69 |

Slowest single run **127 ms** (all three years of daily revenue). **The plans:** for the current month every statement uses an
index — `RevenueEvent_occurredAt_idx`, `RevenueEvent_staffId_occurredAt_idx` (provider filter), `Booking_source_startTime_idx`
(walk-ins), `Booking_status_startTime_idx` (visits, weekend, demand), `Membership_startedOn_idx` — and **none** scans a large
table sequentially. The three-year ranges do scan sequentially, which is the right plan when the range *is* the table.
Times grow in proportion: at **200,000 encounters** the worst run was 491 ms (all history, daily) and the current month stayed under 35 ms.

Honest limits: the data is synthetic; it is one machine and one connection; the timings are the library functions, not
HTTP; "daily" is the slowest because it converts every row to clinic time before grouping. If a three-year daily view ever
feels slow, the fix is a stored clinic-local date on `RevenueEvent`.

---

## 5. Tests

**525 server tests** (up from 425) and **47 web tests** (up from 43), all passing at the default settings, with the pool
capped at 3 (`NW_TEST_POOL=3`), and with the database in UTC (`NW_TEST_TZ=UTC`). The existing race tests pass unmodified. The files that hold the
booking engine — `holds.ts`, `bookings.ts`, both `availability` files, `time.ts`, `scheduling.ts` — have **no diff** from before this segment.

| File | Tests | Covers |
|---|---|---|
| `reports.test.ts` | 43 | ranges (current month at a month end in the clinic's zone; one end only, reversed, impossible, too long); CSV (cents, quoting, formula guard, BOM); the six categories; **the arithmetic** from real check-outs — non-member, member cash with the discount, **credit-paid**, perk, paused member, odd cents, a no-price service in credits — by day, month, service, bucket, tier, payment type, provider and filters, with `list = discount + covered + net` held for every grouping; the month and day boundaries (23:30 vs 00:15; 23:59 on 31 May vs 00:00 on 1 June); sign-ups, walk-ins (day, hour, DST), weekend, demand; **access** (anonymous, front desk, provider, admin); refusing unknown parameters; **no patient in any view, JSON or CSV**; audit rows with filters, not de-duplicated; the indexes exist; the `staffId` backfill |
| `sql-time.test.ts` | 9 | the UTC-timestamp helper under four session zones, comparing and storing |
| `timezone.test.ts` | 5 | the three fixed queries, an instant 3 hours either side of the line |
| `amendments.test.ts` / `audio-retention.test.ts` | 17 / 13 | decisions 3 and 4 (both paths of amend/addendum; admin has none; every purge audited; retry; idempotent) |
| `checkout.test.ts` and others | updated | categories, the admin API, the same-day reminder, the startup guards, the contact page |
| web: `ReportPanel.test.ts` | 4 | cell formatting, the query the screen sends, range validation |

I broke the code on purpose to see the tests notice: 17 plausible mistakes in the report code (a bare Date, a missing
soft-delete filter, days cut in UTC, member cash filed as non-member, covered ignoring the discount, cancelled walk-ins counted,
front desk allowed into Accounting, the formula guard removed, `DOW` for `ISODOW`, an exclusive range end, sign-ups dropping the last
day, a reversed range accepted, views de-duplicated, the provider filter ignored, unknown parameters ignored, the wrong column, a
patient email in the audit meta) and 3 reverted fixes in each of two session zones — **every one is caught**.

I also looked at it in a browser: the front desk sees Reports and a "not available to your role" page at `/accounting`; an admin
sees all four Accounting views and the filters; an invalid range disables *Show* and says why; the table scrolls inside its box
at phone width; and each click wrote its audit row. I could not drive the browser's native date picker, so I set the dates
through the same input event the picker fires.

---

## 6. A bug in earlier phases, found by the Phase 5 tests

A month-end test put a sale at 23:59 on 31 May and it landed in June. Cause: **Prisma sends a `Date` in hand-written SQL as
`timestamptz`, and Postgres compares it with a `timestamp` column by reading the column in the *database session's* time zone.**
Every `DateTime` column here is a UTC `timestamp without time zone`, so on any database not set to UTC each such comparison
is off by the offset (five hours on this dev database, which is `America/Chicago`). On a UTC database it works, which is how it hid.

Three raw queries from earlier phases had it, and are fixed with `utcTimestamp()` (`lib/sqlTime.ts`, an ISO string cast to
`::timestamp`):
- **The next-appointment lookup behind a "C" reply** could confirm the wrong appointment, or find none (the most consequential).
- **"Is there consent newer than the last STOP"**, which decides whether a repeated STOP is answered again.
- **`CreditLedger.createdAt`** written by a monthly grant — stored in session-local time (display only; the ledger orders by id).

Two test fixtures also wrote `now()` into timestamp columns. The suite now runs with the database session in **`Asia/Kolkata`**
(neither UTC nor the clinic's, a half-hour offset) unless `NW_TEST_TZ` says otherwise, so a regression fails here whatever
zone the database defaults to; `tests/timezone.test.ts` pins each fix. Production code has no raw `now()` writes. I did not
touch the booking, hold or availability SQL (their raw statements are `FOR UPDATE` lock queries that bind no time).

---

## 7. Known limitations

1. **No dues** (§3.3) and **no void/refund**: a mistaken cash check-out cannot be reversed in revenue (a Phase 3 limitation); an admin can only correct credits.
2. **The custom view is filters × one grouping**, not a free-form measure/dimension builder (the SPEC's "analytics builder"). The measures are fixed.
3. **The provider is the one the visit was booked with**, snapshotted at check-out (§3.6). Visits checked out before Phase 5 take the booking's *current* provider.
4. **Reports read the live tables**, with no summary tables. Fine at this size (§4); the next step is a stored clinic-local date.
5. **No print or PDF**; CSV only.
6. **A new service lands in "Other"** until it is added to the demand list (§3.4).
7. **No Twilio sending adapter**, and **no real AWS adapters** (Phase 4 §6) — both are stubs.
8. Not independently reviewed for HIPAA; not run on real devices (see `docs/STAGING_CHECKLIST.md`).
9. Dependency advisories: unchanged from Phase 1.

---

## 8. Documents updated

`docs/STAGING_CHECKLIST.md` (rewritten: **everything that needs a real environment, in the order to do it**), `docs/SPEC.md`
(revision 1.6), `docs/PHASE3_NOTES.md` and `docs/PHASE4_NOTES.md` (**Update** lines where this phase supersedes them),
`docs/DISCOUNT_MAPPING.md`, `docs/SMS_TEMPLATES.md`, `server/README.md`, `.env.example`, `render.yaml` comments.

## 9. What I need from you

1. **Review and approve Phase 5** — or tell me what to change.
2. **`docs/DISCOUNT_MAPPING.md`**: approve or correct the table (X-rays 20 or 25 %?) and say which of the site's other claims are real. I enter nothing until you do.
3. **Twilio sending:** do you want the `TwilioMessaging` adapter built next? It needs the account SID and auth token set (in Render only), and your A2P/toll-free approval to arrive.
4. **Dues:** should Accounting include membership dues? That needs a way to record a payment (§3.3).
5. **Vitamin shots and body composition** are in *Other* per A-6. Fine, or should they join IV / consults?
6. **The production database's time zone:** run `SHOW timezone` (staging checklist, step 3). I fixed the code either way.
7. **Push:** when you want `scheduling-engine` pushed. Nothing is deployed, and I will not do either without you.
8. **Staging:** work through `docs/STAGING_CHECKLIST.md` top to bottom.
