# Phase 5 — Notes

What was built, what I assumed, what I changed from the plan, and what you need to verify by hand.
Written 2026-10-11 on branch `scheduling-engine`.

**Nothing has been pushed or deployed.** Everything is committed locally on `scheduling-engine`
(`0f7c989..HEAD`; `git log --oneline 0f7c989..HEAD`), each commit typechecked and tested before it was made. I applied the four new migrations
(`…_note_addenda`, `…_audio_retention`, `…_discount_categories`, `…_phase5_reporting`) to your dev database, as in earlier
phases. The discount migration refuses to run if any tier already has a percentage; it ran, so none did.
The marketing site is not touched by this phase (`main` is level with `origin/main`).

## Update — Phase 5 approved, with six follow-ups (2026-10-11)

> **Later the same day: discounts are now enabled** — see "Discounts enabled" at the end of this Update. What follows in this paragraph
> is what was true when it was written.

**The first one was not done, on purpose.** Item 1 of the approval read *"Discount table: [approved as written / or list corrections].
Enable discounts per that table."* The choice between the two options was left in the brackets, so I do not know which you meant,
and the table has five internal conflicts you have not settled (X-rays 20% or 25% is the first). Enabling a discount changes what a
member is charged, so I left everything **off**: no category, no percentage, perks off. Say **"approved as written"** or send the
corrections and I will enter them (Admin → Memberships → *Member discounts by service category*, audited). See
[DISCOUNT_MAPPING.md](DISCOUNT_MAPPING.md).

| # | You asked | Status |
|---|---|---|
| 1 | Enable the discount table | ~~Not done — your choice was unfilled~~ **Enabled later the same day** (below) |
| 2 | Twilio sending adapter | **Built** (below) |
| 3 | Dues as a separate revenue line | **Built** (below) |
| 4 | Vitamin shots and injections get their own category | **Done** (below) |
| 5 | Push `scheduling-engine` to origin, no merge to `main` | **Pushed** — see the end of this section |
| 6 | Staging checklist, and the webhook paths | **Done** — [STAGING_CHECKLIST.md](STAGING_CHECKLIST.md) |

### The Twilio adapter (2)
`src/integrations/twilio.ts`, behind the existing `Messaging` interface. **Used only when both `TWILIO_ACCOUNT_SID` and
`TWILIO_AUTH_TOKEN` are set and `NODE_ENV` is not `test`**; otherwise the stub, which sends nothing. One alone stays on the stub and
logs a warning naming the missing variable. A malformed SID, or a callback address Twilio would refuse (not `https` in production, an
underscore in the host name), stops the app at start-up. It sends `To`, `From` (`TWILIO_FROM_NUMBER`, default `+18665241007`), `Body`
(the rendered template, so still first name, day and time only) and `StatusCallback`. **21610 (recipient opted out)** turns the patient's
consent off, puts the number on the do-not-text list, and writes audit rows — both when Twilio refuses the send and when it reports
the failure later. Invalid numbers do not retry; network errors, timeouts, 429, 5xx and refused credentials do (the last with an ERROR in
the log). **Logged: message SIDs, statuses and numeric error codes. Never a body, a number, or Twilio's error text.**

**The status-callback webhook** is `POST /api/sms/status`, verified with exactly the same function as inbound (`lib/twilioWebhook.ts`;
production with no token answers 503). It records `deliveryStatus` and the numeric `providerErrorCode` on the message, moves only
forward (Twilio does not promise order and repeats itself: a compare-and-swap, so a late or duplicate callback writes nothing and no
audit row), audits each change, and shows it on the appointment ("sent 10:05 AM · delivered", or "not delivered").

**The webhook paths for the Twilio console** (with `APP_BASE_URL` = your public `https://` address, no trailing slash):

| What | Where in Twilio | Value | Method |
|---|---|---|---|
| Inbound messages (STOP, START, HELP, C) | the number's **A message comes in** webhook | `{APP_BASE_URL}/api/sms/inbound` | `HTTP POST` |
| Status callbacks | **nothing to enter** — every message is sent with its own `StatusCallback` | `{APP_BASE_URL}/api/sms/status` | `HTTP POST` |

Twilio signs the exact URL it calls, so what you type for the inbound webhook must match `APP_BASE_URL` + `/api/sms/inbound` character for
character. If you later put the number in a **Messaging Service**, its *Delivery Status Callback URL* may be set to the status address too;
the per-message address takes priority either way. **Honest limits:** this is tested against a local fake of Twilio's API (the real
request encoding, auth and error shapes, no network), never against Twilio itself — the staging checklist has the real-phone checks. And if
Twilio accepts a message but the reply is lost to a timeout, the retry sends it again; the Messages API has no idempotency key.

### Dues (3)
A `RevenueEvent` of payment type **`DUES`**, status **`BILLED`**, is written by `grantDue` for every period it grants — at enrolment, on
resume, and from the monthly job — for the tier's price **at the time**, **dated the first day of the period in the clinic's calendar**
(so a job that was down over a month end still files it in the right month), one per (membership, period). It has no visit, which the
database enforces (`RevenueEvent_kind`: a row is a dues event or a visit event, never both; `RevenueEvent_consistent`: dues are a positive
amount billed in full with no discount, credits or benefit). A $0 tier bills nothing; a paused or cancelled membership is not billed, and
months missed while paused are not made up (the same rule as the credits). **Billed is not paid:** nothing records collecting the money.

**Every Accounting view shows dues apart from service revenue:** a second table beneath (screen), a `dues` object (JSON) and a second
section (CSV), totalled by month, day or tier where that means something for dues and as one "Membership dues (billed)" line otherwise.
Every service-revenue query excludes `DUES`, so dues never add into service totals or count as visits. A service, provider or cash/credit
filter leaves dues out (and says so); the new `DUES` payment-type filter leaves only dues. The earlier "dues are not in Accounting" gap
is closed. At 50,000 encounters plus ~13,000 dues events the slowest view is 171 ms; the dues query uses the `occurredAt` index.

### Service demand (4)
**Vitamin shots & injections** is its own category, holding the `vitamin-shots` service. **Premise checked:** you said "vitamin shots and
injections", but the only service the site describes as an injection is vitamin shots (`services/vitamin-shots.html` says "injection"
throughout); no other service is named that. Peptide therapy stays in **Consults**, where SPEC A-6 puts it, and **body composition is now the
only seeded service in Other.** If you meant another service to join, it is a one-line change in `lib/reportFormat.ts`.

### Discounts enabled (later the same day)
Your decision: *"use the clean per-tier mapping; where the published copy conflicts with it, the tier percentage wins, including X-rays — apply the
tier's rate, not a separate 20% or 25%. Perks stay off."* **My reading — please check it:** one rate per tier, **Prevent 10%, Restore 15%, Optimize 20%** (the
only tiered rate the page publishes, its supplements line), on **every** category including X-rays. Categories: **Spinal X-rays**, **Supplements**,
**Special services** (no service in it yet, so it discounts nothing today). Entered in **your dev database** through the admin screen's own operations
(audited, 8 rows) with `npm run discounts:apply`, which **a new database needs once** — it starts with no discounts. I looked at the admin screen on a scratch
copy: it shows the three categories at 10 / 15 / 20 and every perk off. **[DISCOUNT_MAPPING.md](DISCOUNT_MAPPING.md) §2 now lists every place `membership.html`
disagrees with what is enforced** (X-rays 20% flat vs the tier rate; special services, packages and additional credits promised and not delivered; all eight perk lines
off; credits "across functional medicine" when none of those services has a credit cost), with line numbers, for fixing the copy later. I did not touch the marketing page.

### Tests
**596 server tests** (up from 525; 14 of them for the discount table) and 47 web tests, all passing at the default settings, with the pool capped at 3, and under UTC. New:
`dues.test.ts` (13), `twilio.test.ts` (35), `discount-table.test.ts` (14), and the dues and category cases in `reports.test.ts`. I broke the dues code 14 ways,
the Twilio code 21 ways and the discount table 13 ways; one mutant of each survived at first (a repeat bill inside one transaction; the desk's delivery status; the
apply script's audit actor), each exposed a missing test, and each is now killed.

---

## Read this first — five things that are not what you might assume

*(Written before the approval. Items 1, 3 and 5 are resolved by the Update above; item 2 is unchanged.)*

1. *[Resolved — the adapter is built; see the Update.]* **The app did not send texts through Twilio.** There is no Twilio sending adapter: `integrations/index.ts` selects
   `StubMessaging`, which records the text and sends nothing. The Twilio variables below only (a) let the app **verify the
   signature of Twilio's inbound webhook** (STOP / START / HELP / C) and (b) put the right sender number and clinic phone
   into the wording. Verification approval does not change this: confirmations and reminders will not reach a phone until
   a `TwilioMessaging` adapter is built behind the existing `Messaging` interface (it needs the account SID as well). I did
   not build it because there are no credentials to test it against. Say go and I will.
2. *[Resolved — enabled at the tier rate; see the Update.]* **No discount was enabled, and none would be until you approved `docs/DISCOUNT_MAPPING.md`.** The model is now a percentage
   per tier per service category, admin-editable (decision 2 below). The table I derived from `membership.html` is written
   up with the five places the site contradicts itself. Perks stay off.
3. *[Resolved — dues are now a separate line; see the Update.]* **Accounting did not include membership dues.** Nothing in the system records a member's monthly payment (Phase 3 never
   built one; SPEC A-13 assumed "dues recorded when collected"). Revenue here is what the desk **recorded at check-out**.
   A member's $0 visit shows its list value in its own column, so the arithmetic still closes (§3.1), but a month's real
   income = this + dues collected elsewhere. Every Accounting screen says so under "How these numbers are made".
4. **I found and fixed a time-zone bug in three queries from earlier phases** (§6). It is invisible on a database whose clock
   is set to UTC and wrong by the offset on any other. I cannot tell from here which your production database is — the
   staging checklist has the one command that does (`SHOW timezone`).
5. **The demand categories follow SPEC assumption A-6, not "existing service categories".** The booking app's `Service.category` has
   three values (Chiropractic, Functional Medicine, Longevity), too coarse for your six. A-6 already lists which services go in
   which, so I used it (§3.4). Vitamin shots and body composition fell in **Other**, as A-6 says *[vitamin shots have since moved out; see the Update]*.

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
*[When written: there were no categories and no percentages. **They are now entered at Prevent 10% · Restore 15% · Optimize 20%; see "Discounts enabled" in the Update.**]*
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

### 3.3 Membership dues *(superseded — they are now billed and shown separately; see the Update)*
As first built, dues were not in Accounting, because nothing recorded them. They are now: billed with each month's credits, as their own line in every
view. **Collecting** the money is still not recorded — a dues line means *billed*.

### 3.4 Service demand uses A-6, by service slug, in code
Chiropractic = adjustment, spinal & postural exam, X-rays · HBOT (both durations) · Red light · IV · Consult = FM consult,
personal wellness planning, hormone optimization, peptide therapy, supplementation · Bloodwork = biomarker testing ·
**Other** = body composition, and any service added later *(vitamin shots moved to their own category at approval; see the Update)*. SPEC A-6's build plan mentions a
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

### 3.8 The first administrator no longer needs a shell *(added after approval, for staging)*
The seed used to skip a database that already had services, and the first-admin script was a separate command run by hand — so a database seeded before
`ADMIN_EMAIL` was set never got an administrator, and Render's free plan has no shell to run it from. Now **every `npm run seed` ends with the admin step**
(`src/lib/bootstrapAdmin.ts`), independent of the service seed's skip: `ADMIN_EMAIL` set and no account with that address → the account is created
(`ADMIN`, no usable password, must change it) and the one-time link is printed to the deploy log — the link only, never a password. The account, its link and
its two audit rows are written in **one transaction**, so there is never an account without a link that every later deploy would skip; two deploys racing each other
create one account. `npm run seed:admin` is now a thin wrapper over the same code (it keeps `--reissue`).
- **I kept the "a different admin exists → refuse" rule.** It is stricter than "no user with that email exists → create": without it, a stale or mistyped `ADMIN_EMAIL`
  would mint a new administrator on every database that already has one. The log says so when it refuses. Say if you want it dropped.
- **No automatic re-issue.** If the 24-hour link expires unused, a redeploy does not print another (that would put a fresh credential in the log on every deploy).
  Recovery without a shell: delete that one `Account` row in Supabase and redeploy (stage 4 of the staging checklist). An opt-in re-issue for a still-never-used account
  is a small addition if you would rather have it.
- A problem in this step (bad address, a refused `APP_BASE_URL`) is reported by name in the log and **does not fail the deploy**; the catalogue seed has already run.

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

**A fragile test fixture, found at the very end.** Two DST tests started failing about two runs in three, though they pass alone.
The suite shares one schema, and a fixture patient's default phone came from a counter that restarts in every file; "honours STOP"
in `texts.test.ts` leaves a do-not-text row for its patient's number, and whichever file ran after it and drew the same number had
its patient silently suppressed. The collision was latent — it appears only when the files run in a different order, and adding
this phase's test files shifted the order. `makePatient` now takes numbers from a sequence in the test schema, so each is issued
once per run across all files. I reproduced the failure by forcing the order (`--sequence.shuffle.files --sequence.seed=3` on
`texts` + `dst` fails with the old helper, passes with the new) and ran the full suite under four shuffled orders: all green.

---

## 7. Known limitations

1. **Dues are billed, not collected** (§3.3), and **no void/refund**: a mistaken cash check-out cannot be reversed in revenue (a Phase 3 limitation); an admin can only correct credits.
2. **The custom view is filters × one grouping**, not a free-form measure/dimension builder (the SPEC's "analytics builder"). The measures are fixed.
3. **The provider is the one the visit was booked with**, snapshotted at check-out (§3.6). Visits checked out before Phase 5 take the booking's *current* provider.
4. **Reports read the live tables**, with no summary tables. Fine at this size (§4); the next step is a stored clinic-local date.
5. **No print or PDF**; CSV only.
6. **A new service lands in "Other"** until it is added to the demand list (§3.4).
7. *(Twilio is now built; see the Update.)* **No real AWS adapters** (Phase 4 §6) — they are stubs. A text that fails for good (a refused number, rejected credentials after the retries) cannot be re-sent: its `MessageLog` row is final.
8. Not independently reviewed for HIPAA; not run on real devices (see `docs/STAGING_CHECKLIST.md`).
9. Dependency advisories: unchanged from Phase 1.

---

## 8. Documents updated

`docs/STAGING_CHECKLIST.md` (rewritten: **everything that needs a real environment, in the order to do it**), `docs/SPEC.md`
(revision 1.6), `docs/PHASE3_NOTES.md` and `docs/PHASE4_NOTES.md` (**Update** lines where this phase supersedes them),
`docs/DISCOUNT_MAPPING.md`, `docs/SMS_TEMPLATES.md`, `server/README.md`, `.env.example`, `render.yaml` comments.

## 9. What I need from you

1. **The discount table — check my reading of "the clean per-tier mapping":** one rate per tier, **Prevent 10%, Restore 15%, Optimize 20%**, on X-rays,
   supplements and special services. If you meant X-rays at a flat 20% (as published), say so — it is two numbers on the admin screen. **Then fix
   `membership.html`** when you choose: [DISCOUNT_MAPPING.md](DISCOUNT_MAPPING.md) §2 lists every place it disagrees, with line numbers.
2. **Twilio, for the real check:** your account SID and auth token, set **in Render only** (never in a file or a message to me), on **both** services; the
   toll-free verification approved; then the real-phone checks in the staging checklist (stage 7). I cannot test against Twilio from here.
3. **The production database's time zone:** run `SHOW timezone` (staging checklist, stage 1). I fixed the code either way.
4. **Staging:** work through [STAGING_CHECKLIST.md](STAGING_CHECKLIST.md) top to bottom.
5. **Merging to `main`:** not done and not requested. The branch is on `origin/scheduling-engine`.
