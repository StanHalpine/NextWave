# Phase 2 — Notes

What was built, what I assumed, what I changed from the plan, and what you need
to verify by hand. Written 2026-10-09 on branch `scheduling-engine`.

> **Since approval:** several things in this file were changed at approval — the text wording (now your exact
> strings, kept in `integrations/templates.ts` and `docs/SMS_TEMPLATES.md`), the consent model (a checkbox on the
> booking page; STOP/HELP handled), the five service types in §5 (four became SOAP), the Render cron job and
> pre-deploy migration, and check-out (it now settles the visit). They are recorded in `docs/PHASE3_NOTES.md` §1
> and `docs/SPEC.md` revisions 1.3 and 1.4; this file is left as it was when written.

**Nothing has been pushed or deployed.** All of this is committed locally
(`f163caa..HEAD`: 12 commits, the first being the spec / `render.yaml` change). Every commit typechecks on its own.

---

## 1. Your scope

| # | Item | Status | Where |
|---|---|---|---|
| 1 | Schedule calendar: day and week, provider filter, create / move / cancel on the existing engine | ✅ | `/app/schedule` · `src/routes/schedule.ts` · `src/lib/scheduling.ts` |
| 2 | Front Desk dashboard: three columns from `Encounter`, check-in and check-out | ✅ | `/app/front-desk` · `src/routes/fd.ts` · `src/lib/encounters.ts` |
| 3 | Walk-in endpoint in the existing lock order (R-2) + a race test | ✅ | `POST /api/fd/walk-ins` · `tests/walkin-race.test.ts` |
| 4 | Patient directory (POST search), profile, Credit Tracker placeholder | ✅ | `/app/front-desk/patients` · `src/routes/patients.ts` |
| 5 | Confirmation and 24-hour reminder texts via `Messaging`, idempotent scheduled job | ✅ **stub provider only** — see §7 | `src/jobs/` · `src/integrations/templates.ts` |
| 6 | Audit on every new read and write | ✅ — table in §3 | |
| 7 | Retire the shared Basic-auth gate behind the flag | ✅ **already off since Phase 1; verified** (below) | `BASIC_AUTH_GATE` |
| 8 | Tests for every new endpoint + the race test; existing `race-test.sh` still passes | ✅ | §2 |
| 9 | This file | ✅ | |

From your four answers:

1. **No provider-scoped view.** Done as instructed. Providers are refused (`403`) on every Phase 2
   endpoint and see "Not available to your role" on the pages. The "swap Phases 3 and 4 if charting is needed early" option is
   recorded in `SPEC.md` (revision 1.2).
2. **Per-service documentation type** (`SOAP` | `SESSION_LOG`), editable on the admin
   Services screen, every change audited from → to. Mapping and the services I defaulted
   are in §5.
3. **Texts.** Templates carry first name, date and time only. No service, no provider.
   Enforced in code, not by convention (§4.4).
4. **Database.** `databases:` removed from `render.yaml`; the app reads `DATABASE_URL` and
   nothing else. Audit of everything else that assumed a Render database is in §6.

**Shared Basic-auth gate — stated and checked.** `BASIC_AUTH_GATE` defaults to **off**. A test
asserts the config value, that the staff pages send no `WWW-Authenticate` challenge, and that
the data behind them still answers `401` without an individual login. Setting it to `on`
brings the curtain back for cutover; individual logins apply either way.

---

## 2. How it was verified

| Check | Result |
|---|---|
| Server test suite (`npm test`) | **151 pass** (was 67) — +84: patients 13, schedule 17, front desk 15, walk-in races 5, texts 25, misc 9 |
| …the whole suite again with the connection pool capped at **3** (`NW_TEST_POOL=3`) | 151 pass |
| Staff-app unit tests (`web/`) | 16 pass (was 5): dates, 12-hour times, clinic-zone display, calendar lane layout |
| `npm run typecheck`, `lint:logs`, web typecheck, both production builds | clean |
| **Existing `scripts/race-test.sh`, unmodified** | **PASS** — 12 racing → 1 winner, 11 clean 409s |
| Heavier races (40 for one chamber; 30 for IV; 60 interleaved across two services sharing rooms and NPs) | all PASS — 1, 2, 2 winners, nothing double-booked; **no deadlock or pool-timeout lines in the server log** |
| …all of the above repeated with the pool capped at **3** | all PASS |
| **Walk-in and mixed-path races** (new) | 12 walk-ins → 1 slot → exactly 1 winner · 2 rooms × 3 providers → exactly 2, in different rooms · capacity-3 room → exactly 3 · walk-in vs scheduled booking on overlapping time → exactly 1 · a storm of walk-ins, bookings, moves, cancels, check-ins and the **existing approve/decline route** at once: every request resolves with 200/201/400/404/409, no double-booking, nobody both cancelled and checked in. Passes at pool size 3 |
| Booking-engine diff since Phase 1 | `holds.ts`, `bookings.ts`, `availability.ts` (route and lib), `time.ts`: **0 lines changed** |
| Text job, end to end on a scratch database (`npm run jobs:run`) | one confirmation written to the stub outbox with the exact approved wording; a second run sent nothing |
| Real browser walk-through (in-app Chromium, 1024 px, plus Front Desk at 375 px) | sign-in → dashboard → walk-in (refused with next openings, then placed) → check in / out → calendar day + week → open, move (including onto its own overlapping time), approve → link an online booking to a patient → book with an option → patient directory, profile, visits, consent, Credit Tracker placeholder |
| Your real database afterwards | 11 migrations; **0** accounts / sessions / audit rows / patients / bookings / messages; 15 services (6 `SOAP`); no scratch schemas left |

**What I did *not* verify** — be aware of these:

- **Any real provider.** Nothing talks to Twilio, AWS or a real TLS database. Texts go to a
  local file. No BAA, no A2P registration is reflected anywhere in code.
- **The in-process job timer** (`JOBS_IN_PROCESS=true`). The job body and the `jobs:run`
  entry point were run; the `setInterval` wrapper itself was not.
- **The Schedule page on a phone or tablet** (only Front Desk was looked at at 375 px), and
  **keyboard / screen-reader use** of the calendar and dialogs. Only one browser engine.
- **Daylight-saving end (Nov 1).** Unit tests cover the date arithmetic and the walk-in slot
  rounding on a standard-time date; I did not drive the calendar across the change.
- **Volume.** Tested with a handful of patients. The directory search is a prefix match on
  indexed names, but phone and email use `contains`, which will not scale to a very large
  directory without a trigram index.
- The 14-minute idle dialog on the new pages — your manual check from Phase 1 covers it, and
  the new pages use the same layout, but I did not sit through it here.

---

## 3. Audit: every new path

Writes go through `staffTransaction()`, so the audit row is in the **same transaction** as the
change: a refused or rolled-back change leaves no record of something that did not happen
(tested: a refused move writes no audit row and leaves the original untouched). Reads call
`audit.read()`. No row ever holds a value — ids, counts and field **names** only.

| Endpoint | Audit |
|---|---|
| `POST /api/fd/patients/search` | `READ patient` — every search, never deduplicated; the term is **not** recorded |
| `POST /api/fd/patients` | `CREATE patient` (field names) |
| `GET /api/fd/patients/:id` · `/visits` | `READ patient` (id) |
| `PATCH /api/fd/patients/:id` | `UPDATE patient` (field names) |
| `DELETE /api/fd/patients/:id` | `DELETE patient` (soft) |
| `POST …/sms-consent` | `UPDATE patient` — records opt-in/out **and how it was given**; this row is the consent evidence |
| `GET …/patient-matches` · `POST …/link-patient` | `READ appointment` · `UPDATE appointment` |
| `GET /api/schedule/calendar` · `/slots` | `READ appointment` (list; repeats within 5 min logged once) |
| `GET /api/schedule/appointments/:id` | `READ appointment` (id) |
| `POST …/appointments` · `/move` · `/cancel` | `CREATE` / `UPDATE appointment` (cancel carries the reason **code**) |
| `GET /api/fd/dashboard` | `READ appointment` (list) |
| check-in · undo · check-out · no-show · walk-in | `CREATE` / `UPDATE encounter` (+ `CREATE appointment` for a walk-in) |
| the text job | `CREATE` / `UPDATE message` as the system actor `appointment-texts` (+ `UPDATE patient` if a STOP arrives) |
| `PATCH /api/admin/services/:id` | `UPDATE service` (from → to) when `documentationType` changes |

Two changes to existing audit behaviour: legacy booking-contact lookups (`/api/patients/search`,
`/api/patients/:id/history` over the old `User` table) are now recorded as **`booking_contact`**,
so `patient` means the new Patient table. **Phase 1 rows keep the old label** — they are
append-only. The audit-log screen's filter lists the new types.

---

## 4. Where I departed from the instructions, and why

### 4.1 Texts are sent by a job, not by a hook on booking

You told me the booking code stays untouched, and there is no "booking confirmed" event to
subscribe to without editing it. So a job finds confirmed future appointments nobody has been
texted about. That is also what makes it idempotent. **Cost: a confirmation is not instant —
it goes out within one job interval (5 minutes by default).**

### 4.2 Texts are only sent to a *linked, consenting* patient — so online bookings get none by default

The public booking widget has no consent checkbox (and you said it stays as-is), so I cannot
treat "someone typed a phone number into a form" as consent to be texted. A text goes out only
when a front-desk person has linked the booking to a patient record **and** recorded that
patient's consent on their profile. The Schedule's appointment dialog and the Front Desk card
both have a "Link patient" step that suggests matches by phone and email.
**Consequence: until consent is captured somewhere or linked by hand, an online booking gets
no confirmation text.** Decision for you in §9.

### 4.3 A new endpoint you did not list: `GET /api/schedule/slots`

The pickers need "which times are bookable". The public availability endpoint would do for
creating, but not for moving an appointment (it counts the appointment against itself, so
11:00 → 11:15 looks unavailable), and it uses the real clock. The new endpoint returns the
engine's own answer, optionally *as if one appointment were not there* (a transaction that is
always rolled back, taking no resource locks). It also means the browser never converts times
between zones.

### 4.4 The stub now enforces the text rule

`StubMessaging` (a Phase 1 file) renders through `renderTemplate()`, which **rejects any
variable other than first name, date and time**. A future adapter that passes `service` fails
loudly in development rather than leaking it in production. The test suite asserts the wording
and that the residue of a rendered text, after removing those three fields, names no service,
provider or room.

### 4.5 Smaller departures

- **Moves are in place** (same appointment id, patient link and visit record) rather than
  cancel-and-rebook; `rescheduledFromId` is therefore not used (recorded in `SPEC.md`).
- **Staff-made appointments are `CONFIRMED` immediately** — there is no review step for
  something the desk created. They record `source` (`PHONE` / `FRONT_DESK` / `WALK_IN`) and
  `createdByAccountId`.
- **`Booking.userId` is still `NOT NULL`**, so a staff-made booking also writes a `User` row
  (a contact snapshot copied from the patient). Editing a patient's phone later does **not**
  update old snapshots; texts use the Patient record, not the snapshot.
- **Patient records carry no SSN, insurance or card fields** — deliberately. The front-desk
  note field says in its hint that health information belongs in a visit note.
- **The legacy room/employee grid is still there** (`/dashboard.html`, linked from the foot of
  the Schedule page). The "Schedule" navigation entry now opens the new calendar.
- **No cancellation or reschedule text.** A third template needs a wording decision (§9).
- The test run sends the stubs' fake texts to a temp folder (`DEV_DATA_DIR`) so it cannot
  pollute your local `.devdata/`.

---

## 5. Documentation type — your mapping, and the five I defaulted

Your list → my reading of your 15 services (confirm any of these):

| You said | Services I set to `SOAP` |
|---|---|
| chiropractic adjustment | Manual Adjustment |
| chiropractic exam / new patient | Spinal & Postural Exam |
| NP consult · functional medicine consult | Functional Medicine Consult |
| IV therapy | IV Therapy |
| injections | Vitamin Shots |
| bloodwork | Biomarker Testing |

`SESSION_LOG`, as you named: **Hyperbaric Oxygen Therapy (60 and 90 min), Red Light Therapy,
Body Composition.**

**Not named by you → defaulted to `SESSION_LOG`; please confirm:**

| Service | Why it might be wrong |
|---|---|
| **Hormone Optimization** | Delivered by an NP — may be an "NP consult" |
| **Peptide Therapy** | Same |
| **Personal Wellness Planning** | A planning session — may want SOAP, may not |
| **Supplementation** | Probably a log, but it shares NPs with peptide therapy |
| **Spinal X-Rays** | Imaging; a log is plausible but a chiropractor may want an assessment |

Flip any of them on **Admin → Services → Visit documentation**. A new service is always
created as `SESSION_LOG`, so nothing is silently treated as a full clinical encounter.
(Nothing reads this flag until the provider module in Phase 4.)

---

## 6. Render / database audit (your answer 4)

You asked me to confirm nothing else assumes a Render-managed database.

- **`render.yaml`:** the `databases:` block is gone; the file now provisions the web service
  only. `DATABASE_URL` is `sync: false` (you set it in the dashboard; it is never stored in the repo).
- **Code:** `DATABASE_URL` is the only database variable read anywhere (`src/`, `prisma/`,
  `scripts/`). Nothing reads a `RENDER_*` variable. The only other mentions of Render are
  comments (`seed.ts`, `index.ts`, `demoGate.ts`, `password.ts`) and the README.
- **One real thing you should know:** the build runs `prisma migrate deploy` and the seed, so
  **Render's build servers must be able to reach your staging Postgres**. They have no fixed
  IPs. If the database allow-lists addresses, run migrations from CI or a pre-deploy step
  instead (noted in `render.yaml` and the README).
- **Not Render-the-database, but Render-the-host:** 21 "Book now" links on the marketing site
  hard-code `nextwave-scheduling.onrender.com` (the **web service**, not the database). They
  stay valid while the web service stays on Render; they would need a bulk edit if it moves or is renamed.
- **TLS is untested against a real server.** Production refuses a `DATABASE_URL` that does not
  ask for TLS, but I have never connected to an external Postgres over TLS from here. RDS in
  particular commonly needs its CA bundle supplied — check this when you provision it.

---

## 7. What is real and what is a stub (texts)

| Piece | State |
|---|---|
| Templates, rendering rules, consent model, quiet hours, retries, idempotency, STOP handling | built and tested |
| **A real Twilio adapter** | **not built** — selecting anything but `stub` throws `NotConfiguredError` |
| Mapping Twilio errors to categories | **not built.** The contract is in `src/integrations/types.ts`: an adapter must throw `MessagingError('opted_out' \| 'invalid_recipient' \| 'transient' \| 'rejected')` and must **not** attach the provider's message (Twilio's can echo the recipient's number) |
| Inbound STOP / HELP webhook | **not built.** Twilio blocks sends to opted-out numbers and returns an error; the job turns that into "consent off". A webhook that does it at the moment of the STOP is better — worth doing when the account exists |
| A2P 10DLC registration, Security Edition BAA | yours, in progress |

**When you register the campaign**, register these exact messages as the samples (they live in
`src/integrations/templates.ts`; change one there and the registration must match):

> NextWave Wellness: Hi *Ingrid*, your appointment on *Saturday, Oct 10* at *9:00 AM* is confirmed. Reply STOP to opt out.
>
> NextWave Wellness: Hi *Ingrid*, a reminder of your appointment on *Saturday, Oct 10* at *9:00 AM*. Reply STOP to opt out.

**Your call:** the practice name is the one fixed string beyond your three fields. I kept it
because a text should be identifiable and carrier registration expects brand identification.
If you want it gone, it is one constant.

---

## 8. Behaviour changes and assumptions

**Behaviour changes you should know about**

1. **The "Schedule" nav entry now opens the new calendar**, not the legacy grid.
2. **Front desk and admin can now see a calendar of every patient's name and appointment** for
   up to 14 days at a time, and the full directory. Providers cannot (answer 1).
3. **Check-in is the front desk's job until Phase 4**: there is no "seen" step yet, so a visit
   goes `CHECKED_IN → CHECKED_OUT` and `seenAt` is set at check-out. Phase 4 will set it when
   the provider signs.
4. **A checked-in patient cannot be moved or cancelled** — undo the check-in first. This is
   what stops a patient being both cancelled and checked in; it is enforced with a row lock.

**Assumptions I made**

- A walk-in takes the **15-minute-aligned slot you are in** and occupies the service's full
  duration from that slot's start (10:07 arrival → the 10:00 slot). Availability is evaluated
  as of that slot's start, so a hold that lapsed within the last few minutes can still block
  a walk-in — it errs towards refusing.
- Texts: clinic-local **08:00–21:00 only**; a confirmation is sent when a patient is first
  *eligible* (so an appointment booked last week for someone who consents today is confirmed
  today); no reminder if the appointment is under an hour away or the patient was told less
  than 24 hours before it; the name used is `preferredName`, else first name.
- A reminder retry or lease expiry is **at-least-once** for one narrow case: the process dies
  after Twilio accepts a message and before the row says so. Twilio has no idempotency key, so
  that rare case can duplicate a text; it can never silently drop one.
- Duplicate-patient warning: same phone *and* last name, or same email. It warns and lets the
  desk confirm "different person"; it never blocks and there is **no merge tool**.
- US phone numbers only (10 digits, or 11 starting with 1). Anything else is stored but never texted.
- Patient removal is a **soft delete**, admin only, refused while upcoming appointments exist.
- Calendar: one request is limited to 14 days; cancelled bookings are hidden unless ticked;
  expired holds are never shown.

---

## 9. Known limitations and open risks

- **No drag-and-drop** on the calendar — click an appointment, then Move. A week view with
  "All providers" is crowded by design; pick a provider.
- **Dependency advisories:** unchanged from Phase 1 (five pre-existing, none introduced here).
- **The audit loss window** from Phase 1 §3.3 still applies to the legacy routes' writes and
  to *all* read entries (they are buffered and written after the response). The new routes'
  **writes** do not have it (§3).
- **No patient merge, import or export.** Consent evidence lives in the append-only audit
  trail plus `smsOptInAt` / `smsConsentRecordedById` on the patient — there is no separate
  consent table.
- **Verbal consent recorded by staff** is a legal question, not a technical one (TCPA / carrier
  rules). I built the mechanism to record *how* consent was given; whether verbal is sufficient
  for your campaign is for your attorney.
- **Per-instance memory:** the "log repeat list reads once" window is in-process, like the
  Phase 1 login rate limiter.

---

## 10. Verify by hand

1. **Look at it.** Sign in and use `/app/front-desk`, `/app/front-desk/patients`,
   `/app/schedule`. I confirmed them in the browser pane; you are the judge of whether they
   suit the desk. Try a walk-in while a room is busy and read the message.
2. **Run the job once yourself:** `npm run jobs:run`, then read
   `server/.devdata/sms-outbox.jsonl` — that is exactly what a patient would receive.
3. **Admin → Services:** check the **Visit documentation** selector, and the five in §5.
4. **Decide how the job runs on staging** (§11, item 4) before anyone expects a text.
5. **Production env, unchanged from Phase 1:** `DATABASE_URL` ends `?sslmode=require`;
   `APP_BASE_URL` is the `https://` origin; `MFA_ENCRYPTION_KEY` set.
6. Read `src/lib/scheduling.ts` (its header explains the lock order and why it is a rule) and
   `src/integrations/templates.ts` — the two files this phase's guarantees rest on.

---

## 11. What I need from you before Phase 3

1. **Review and approve this phase** — or tell me what to change.
2. **Confirm the five services in §5**, and the six I mapped.
3. **How should online bookings get texts?** Options: (a) leave it — staff link and record
   consent by hand; (b) add a consent checkbox to the public booking widget (a change to the
   page you said stays as-is, so I have not touched it); (c) capture consent at first visit and
   text from the second. (b) is the only one that texts a first-time online booking.
4. **Where does the job run on staging?** A Render **Cron Job** running `npm run jobs:run`
   every 5 minutes (survives the web service sleeping; one more thing to configure), or
   `JOBS_IN_PROCESS=true` on an always-on instance. I recommend the cron job.
5. **Cancellation / reschedule text?** Not sent today. If you want one, give me the wording
   (same three-fields rule) and it needs registering in the A2P campaign.
6. **Keep "NextWave Wellness:" at the start of each text?** (§7)
7. **A staging database URL** (any Postgres with TLS) so I can verify TLS and migrations from
   the build step rather than assume them.
8. **Phase 3 or the swap?** `SPEC.md` still has Phase 3 (credits and memberships) next. If
   providers need to chart before it finishes, say so and I will swap 3 and 4.
