# NextWave Wellness — Clinic System Specification

Version 1.8 · 2026-10-11 · Status: **Phases 1–5 approved. Member discounts are enabled** (Prevent 10% · Restore 15% · Optimize 20%; revision 1.8 below); perks stay off. Revision 1.7 records the Phase 5 approval follow-ups: the Twilio sending adapter, dues as revenue, and the vitamin-shot category. The branch is pushed to `origin/scheduling-engine` (later commits are local); nothing is merged to `main` or deployed. `docs/STAGING_CHECKLIST.md` lists everything that needs a real environment.

> **Revision 1.1 — decisions recorded after approval** (the body below is otherwise
> unchanged from the approved v1; sections touched are marked *[rev 1.1]*):
>
> | Item | Decision |
> |---|---|
> | Staff app UI (A-1) | **React + Vite.** The anonymous booking widget stays vanilla (it is linked from the marketing site). The legacy `dashboard.html` / `admin.html` stay vanilla behind the same login until their modules are rebuilt |
> | Multi-role accounts (A-4) | **Allowed.** An account may hold `ADMIN` plus one provider role (and/or `FRONT_DESK`). Note authorship records the provider role used. `Account.roles` is an array |
> | SOAP vs session log (A-5) | **Per-service flag.** SOAP required for chiropractic, NP consult, IV therapy, injections, bloodwork. HBOT and red light get a short **session log** (time, duration, provider, notes) instead. Flag lands with the Phase 4 migration; the session-log table is Phase 4 |
> | MFA (A-9) | **TOTP mandatory for `admin` in Phase 1. Providers get it before real patient data enters — a Phase 4 gate** (`MFA_REQUIRED_ROLES`) |
> | Perks (A-12) | **Tracked** as monthly entitlement counters, separate from credits (monthly shot or IV, quarterly body composition, guest passes). Phase 3 |
> | Raw SQL audit | The four hand-written `FOR UPDATE` statements are lock-only; see §6 |
> | Basic-auth gate | Retired by default; `BASIC_AUTH_GATE` flag kept for cutover |
> | `Encounter` table | Created in **Phase 1** (schema only); the workflow that drives it is Phase 2 |
> | All other §9 assumptions | Defaults accepted |
>
> **Revision 1.2 — decisions recorded at Phase 2 approval:**
>
> | Item | Decision |
> |---|---|
> | **Phase order** | Phases 3 (Patient Profile + Credits) and 4 (Provider + SOAP) **may be swapped.** If charting is needed before the credit ledger is finished, build Provider + SOAP first. The dependency that makes this safe: Phase 2 now ships the Patient entity and the Encounter workflow, and Phase 4 needs only those — not credits. Cost of swapping: check-out would not yet redeem credits or record a charge, and Accounting (Phase 5) needs `Charge`, so Phase 5 follows Phase 3 either way |
> | Provider scoped view before Phase 4 | **No.** Dual-role (Admin + Provider) accounts cover it |
> | Patient entity | **Moves from Phase 3 into Phase 2**: `Patient`, the POST-search directory, the profile page (demographics + contact), and `Booking.patientId`. The Credit Tracker tab is a placeholder until Phase 3. Membership, credits, ledger and charges stay in Phase 3 |
> | Documentation flag (A-5) | **`Service.documentationType` = `SOAP` \| `SESSION_LOG`, per service and admin-editable.** SOAP: chiropractic adjustment, chiropractic exam / new patient, NP consult, functional medicine consult, IV therapy, injections, bloodwork. Session log: HBOT, red light, body composition, and any other timed modality. **Any service not named defaults to `SESSION_LOG`** and is listed in `PHASE2_NOTES.md` for confirmation. Lands in Phase 2 (the column and its admin control); the note screens that consume it are Phase 4 |
> | Text messages | Confirmation and a 24-hour reminder, via the `Messaging` interface, **stub only**. **Templates may contain only the patient's first name, the appointment date, and the time — no service names, no provider names.** Twilio A2P registration and the Security Edition BAA are the owner's, in progress |
> | Database hosting | `render.yaml` provisions **no** database. The app reads `DATABASE_URL` and nothing else. Staging = an external Postgres; production = AWS RDS later |
> | Basic-auth gate | Already retired by default in Phase 1 (`BASIC_AUTH_GATE`, default off) |

> **Revision 1.3 — decisions recorded at Phase 2 approval:**
>
> | Item | Decision |
> |---|---|
> | Departure: texts sent by a **polling job**, not a hook on booking | **Accepted.** The booking and approval routes are not edited, so there is no "confirmed" event to subscribe to; a job finds confirmed appointments nobody has been texted about. Idempotent via `MessageLog`. A confirmation therefore goes out within one job interval (5 minutes) |
> | Departure: **`GET /api/schedule/slots`** (not in the Phase 2 scope list) | **Accepted.** The engine's own answer for a service and day, optionally *as if one appointment were not there* (for a move), so the browser never converts between time zones |
> | Online consent | **A consent checkbox is added to the public booking widget**, unchecked by default, with the exact label *"Text me appointment confirmations and reminders. Msg & data rates may apply. Reply STOP to opt out."* The consent time and the exact label shown are stored. Consent a staff member records on the patient profile keeps working. Inbound **STOP** sets consent off and is confirmed once; **HELP** is answered with the clinic phone |
> | Documentation type (A-5) | **SOAP:** Hormone Optimization, Peptide Therapy, Personal Wellness Planning, Supplementation (in addition to the six named earlier). **Session log:** Spinal X-Rays |
> | Scheduled jobs | A **Render Cron Job every 5 minutes** runs `npm run jobs:run`. `prisma migrate deploy` (and the seed) move from the build step to Render's `preDeployCommand`, so build servers never need database access |
> | Text wording | Fixed by the owner (two exact strings, below the `{first}` `{day}` `{time}` placeholders). Both live in one file, `src/integrations/templates.ts`, with a generated copy in `docs/SMS_TEMPLATES.md` for the A2P campaign form |
> | Before Phase 3 | Tests for the **2026-11-01 DST change** in `America/Chicago` covering the slots endpoint, the 24-hour reminder window, and appointment moves |
> | **Phase 3 scope (owner)** | Tiers stored as data. Credit ledger append-only, one lot per monthly grant, FIFO, idempotent monthly grant job (in `jobs:run`). Perks as monthly/quarterly entitlement counters per tier, built with placeholders until the owner supplies the exact mapping. Credit Tracker tab. Check-out redeems credits for credit-eligible services and shows balance before and after; non-members pay cash (price recorded, **no payment processing**). Price and credit cost per service on the admin Services page. `membership.html` updated. **Every check-out writes a `revenue_event` row** (service, price, payment type member/cash, encounter id). This replaces the spec's `Charge` table; void and `PlanDiscount` are not in this phase |

> **Revision 1.4 — Phase 3 as built** (where it differs from §4.3 / §5.3 below, which are kept as the original design):
>
> | Item | As built |
> |---|---|
> | `Charge` | **Replaced by `RevenueEvent`** (the owner's term): one append-only row per check-out — service, price, member/cash, encounter. `UNIQUE(encounterId)`. A database CHECK refuses a self-contradictory row. **Void is not built**; a mistaken check-out is corrected by an admin credit adjustment (a revenue correction is a Phase 5 question) |
> | `MembershipPlan` | As specified, **seeded by the migration** (not the seed script, so an existing database gets it too): Prevent / Restore / Optimize, 4 / 6 / 8 credits, 90-day rollover, **$99 / $199 / $299** dues. `extraCreditPriceCents` is **not** built |
> | `PlanDiscount` | **Not built** (not in the owner's Phase 3 scope: the member-savings percentages are marketing copy only; nothing applies them at check-out) |
> | `CreditLedger` / `CreditAllocation` | As specified, with `CreditAllocation.grantId → lotId`. `LedgerReason` is `MONTHLY_GRANT · ADJUSTMENT · REDEMPTION · EXPIRATION` (`PURCHASE` and `REVERSAL` are not needed yet). Ledger rows carry the **application** clock. Database triggers: append-only (UPDATE / DELETE / TRUNCATE rejected), a lot/removal shape check, and a **deferred constraint trigger that refuses a commit that would overdraw a lot** |
> | Perks (A-12) | **Tracked.** `PlanPerk` (per tier: key, label, MONTHLY / QUARTERLY / ANNUAL, quantity, active) + `PlanPerkService` (services that redeem it) + append-only `PerkUsage`. Counted in **calendar** months / quarters / years, clinic time. Pre-filled from the owner's tier copy but **inactive** until the owner confirms the mapping |
> | Check-out | `POST /api/fd/appointments/:id/check-out` now requires `{ payment: CREDITS \| PERK \| CASH }`, runs in one transaction (lock order Booking → Patient → Membership), and is idempotent. `GET …/checkout-preview` feeds the screen |
> | Jobs | `membership grants` and `credit expiry` run inside `npm run jobs:run` (not separate `credits:*` commands) |
> | Admin | Tiers and perks are edited on **Admin → Memberships**; price and credit cost per service on the legacy **Catalogue** Services card (`Service.creditCost`, audited before → after) |
> | Not in this phase | Payment processing of any kind (cash is *recorded*); membership dues (collected outside the system, not recorded as revenue); member-savings discounts; void |

> **Revision 1.5 — decisions recorded at Phase 3 approval, and Phase 4 as built.**
>
> *Decisions at Phase 3 approval:*
>
> | Item | Decision |
> |---|---|
> | Member discounts | *[superseded by rev 1.6: now per tier per service category]* **`MembershipPlan.discountPercent`**, applied at check-out to **cash** payments by **active** members, editable on Admin → Memberships. `RevenueEvent` records **list price, discount and net price as separate columns** (`priceCents` / `cashDueCents` became `listPriceCents` / `netPriceCents`, plus `discountPercent` and `discountCents`). The owner left the tier mapping blank, so every tier starts at **0%**. This **supersedes** the "member savings cannot be applied" limitation in rev 1.4 |
> | Perks | Quantities left blank by the owner → counters stay **off** |
> | `membership.html` | Cherry-picked onto `main` (only that commit). It conflicted with an unpushed local commit on `main`; the owner's copy replaced it |
> | Render | Paid plans approved: the entry size (`0.5c-512mb`) for the web service and the cron job |
> | Texts | Reminder is now `appt_reminder_24h_v3`: *"NextWave Wellness: Reminder for {first}: see you tomorrow at {time}. Reply STOP to opt out."* The STOP / START / HELP / C replies are the owner's exact wording (`reply_*_v2`). `CLINIC_PHONE` keeps its environment override and defaults to the number published on `contact.html` — which publishes none yet |
> | Marketing site | `privacy.html`, `sms-terms.html`, Privacy / SMS Terms footer links on every page, and `sms-opt-in.png` + `sms-opt-in.html`, on a **separate branch off `main`** from the booking app |
> | Staging | `docs/STAGING_CHECKLIST.md`: verify the Twilio signature with a real inbound message (not blocking) |
>
> *Phase 4 as built* (where it differs from §4.4 / §5.4 / §7, which are kept as the original design):
>
> | Item | As built |
> |---|---|
> | Notes | **No `SoapNote` / `SoapNoteRevision`.** The owner's instruction was to build on the existing amend-only `VisitNote` model **without changing its amendment semantics**, so: a mutable **`DocumentationDraft`** (the scratchpad), **signing copies it into `VisitNote` rows** (S, O, A, P — or one GENERAL note for a session log) and writes an append-only **`NoteSignature`** (account, provider role used, time, which notes). Corrections after signing are the existing amendment. `VisitNote` gains a nullable `durationMin` (session logs) so a duration correction is an ordinary amendment. The database now **rejects UPDATE/DELETE/TRUNCATE on `VisitNote` and `NoteSignature`** |
> | Legacy `VisitNote` endpoints "made read-only" | *[rev 1.6: the amend route is now signer-only, and other providers add addenda]* **Not done.** They are the existing model the owner told me not to change; the amend route still lets any provider amend any note (§7 of the notes) |
> | Queue | `GET /api/provider/queue?role=` — by **provider role** (not `scope=mine\|specialty`): today's checked-in patients for the role plus visits with **no provider assigned**, with each visit's documentation status, and earlier unsigned visits (30 days). Role switching for multi-role accounts; an admin may view any role read-only |
> | Workspace | `/api/provider/visits/:id/{documentation,start,draft,sign}` (the spec's `/encounters/:id/soap…` paths). Optimistic `version` on the draft. A SOAP note needs all four sections (write N/A where one does not apply); a session log needs duration and notes |
> | Macros | **One-click insertion by section**, not typed `trigger` expansion (the owner's wording). `MacroSet` is `PERSONAL` (one per provider) or `SHARED` (admin-defined, all provider roles or the listed ones); `Macro` has a title, a section and a body of at most 4,000 characters |
> | Scribe | `ScribeSession` holds **keys only**. Patient consent is recorded on the existing **`Encounter.scribeConsentAt`** by the provider before any audio can start (not a column on the session). Upload is a **signed URL** (the stub's stand-in for a presigned S3 PUT; the browser sends no cookie). Processing runs in the background and the browser polls. A draft is **never inserted or signed on its own**; signing one needs `reviewedAiDraft: true`; the signature records `aiAssisted` and whether the provider changed anything. Stub text is marked `[DEMO …]` and **cannot be signed** |
> | Integrations in production | While FileStorage or AiScribe is a stub, the scribe is **off** in production (`ALLOW_STUB_INTEGRATIONS` lifts that for a fake-patient staging deployment). This replaces the Phase 1 plan to refuse to start |
> | MFA | `MFA_REQUIRED_ROLES` now defaults to `ADMIN` + the three provider roles, and every clinical route checks the authenticator itself regardless of that setting |
> | Front desk | `Appointment.documentation = { status: NONE \| DRAFT \| SIGNED, signedAt }` — never text |
> | Not built | *[rev 1.6: the purge job is built — 30 days after signing]* The audio **purge job** (retention is the owner's decision, §9 of the notes); a typed-trigger macro manager; a provider-only "Mine" scope beyond an "Only mine" filter |

> **Revision 1.6 — decisions recorded at Phase 4 approval, and Phase 5 as built.**
>
> | Item | As built |
> |---|---|
> | Member discounts | **A percentage per tier per service category**, admin-editable (`DiscountCategory`, `PlanCategoryDiscount`, `Service.discountCategoryId`; `RevenueEvent.discountCategory` is a snapshot). **Supersedes** `MembershipPlan.discountPercent` (rev 1.5), which is gone. Applied at check-out to **cash** paid by an **active** member; credits and perks are never discounted. *[rev 1.8: now enabled]* **Nothing was enabled**: no categories, no percentages, perks off, until the owner approved `docs/DISCOUNT_MAPPING.md` (derived from `membership.html`, with its five internal conflicts listed) |
> | Amendments | **Only the provider who signed a note can amend it**; any other provider adds an **addendum** (`NoteAddendum`: append-only, linked to the note, never changes it). An administrator has **no** write path. The amendment model and its versioning are unchanged. **Supersedes** "any provider can amend any note" (rev 1.5 row on the legacy `VisitNote` endpoints) |
> | Audio retention | Raw audio is deleted **`AUDIO_RETENTION_DAYS` (default 30) after the note is signed**, by a step of `jobs:run`; each deletion is audited. The transcript and the AI draft **stay with the visit**, which **supersedes** assumption A-7's 90-day transcript. Replaces "Not built: the audio purge job" in rev 1.5 |
> | Reminder | A same-day wording, `appt_reminder_today_v1`, is used when the appointment is today; the Phase 3 `same_day` skip is gone |
> | Clinic phone and sender | Defaults `(308) 830-1951` (`CLINIC_PHONE` overrides) and `+18665241007` (`TWILIO_FROM_NUMBER` overrides; must be E.164). `contact.html` carries the same, and a test keeps them level |
> | **Phase 5 · Accounting** | `/app/accounting`, **admin only**: one page with four views — *Monthly by service*, *Daily*, *Members vs. non-members*, *Custom* (date range, service, payment type, provider, and how to total). Built on **`RevenueEvent`** (not `Charge`). Columns: visits, **list**, **discount**, **net**, **covered by membership** (= list − discount − net: the list value of a credit or perk visit, per A-13), credits redeemed. `GET /api/accounting/{options,monthly,daily,members,custom}`; **not** the `revenue/…` paths or the `POST …/analytics/query` builder of §5.5 (a fixed set of filters and groupings instead) |
> | **Phase 5 · Reports** | `/app/reports`, **front desk and admin** (A-14; providers see neither): *New memberships* (by tier, `Membership.startedOn`), *Walk-ins by day* and *by hour*, *Weekend visits* (Saturday + Sunday, A-17), *Service demand* (booked / attended / no-shows). `GET /api/reports/{signups,walkins-day,walkins-hour,weekend,demand}`. The six demand categories follow **A-6 by service slug, in code** (`lib/reportFormat.ts`) rather than a `Service.reportGroup` column; vitamin shots, body composition and any new service are **Other** *[rev 1.7: vitamin shots now have their own category]* |
> | Every view | A date range that starts on the **current month in the clinic calendar**, a totals row, a CSV export (`?format=csv`; BOM, `CRLF`, plain decimals, formula-safe). **Aggregates only — no patient, booking or encounter is named or identified**, in JSON or CSV. Every view is audited as `READ` and every export as `EXPORT` (`accounting_report`, `clinic_report`) with its range and filters; views are not de-duplicated. Unknown parameters are refused. A range is clinic-local days, both ends inclusive, at most five years |
> | Schema (Phase 5) | `RevenueEvent.staffId` (the provider the visit was booked with, snapshotted at check-out; existing rows backfilled from their bookings) and indexes `RevenueEvent(staffId, occurredAt)`, `Booking(source, startTime)`, `Membership(startedOn)`. **No `Service.reportGroup`.** Measured at 50,000 encounters: slowest view 127 ms, every current-month query on an index (`npm run perf:reports`; `docs/PHASE5_NOTES.md` §4) |
> | **Time zones and raw SQL** | Every `DateTime` column is a UTC `timestamp`. **Raw SQL must bind an instant with `utcTimestamp()`** (`lib/sqlTime.ts`): a bare `Date` is compared in the *database session's* zone, which is wrong by the offset on any non-UTC database. Three queries from Phases 2–3 had it and are fixed. The test database now runs in `Asia/Kolkata` unless `NW_TEST_TZ` says otherwise |
> | Revenue basis | *[superseded by rev 1.7: dues are now a separate line in every Accounting view]* **Membership dues are not in Accounting**: nothing records them (A-13 assumed they would be). Revenue is what was recorded at check-out |
> | Not built | *[rev 1.7: the Twilio adapter and dues are built]* A **Twilio sending adapter** (texts still go to the stub; only the inbound webhook, its signature check and the wording are real), the **AWS adapters**, a dues record, void/refund, print/PDF, a free-form analytics builder |

> **Revision 1.8 — member discounts enabled.**
>
> | Item | As built |
> |---|---|
> | Discount table | **One rate per tier — Prevent 10%, Restore 15%, Optimize 20% — on every discounted category, X-rays included** (the owner: "the tier percentage wins … apply the tier's rate, not a separate 20% or 25%"). Categories: **Spinal X-rays** (the Spinal X-Rays service), **Supplements** (Supplementation) and **Special services** (no service yet, so it discounts nothing today). Nothing else is discounted. **Perks stay off** |
> | How it is entered | Through the admin screen's own operations (`lib/discountConfig.ts`), applied by `lib/discountTable.ts` / `npm run discounts:apply`: audited, **only ever adds** (an existing category is left as an administrator has it; a service already in another category is not taken from it). Entered in the **dev database**; **a new database starts with no discounts** — run the script once, or enter the table on the admin screen (staging checklist stage 5) |
> | Published copy | Where `membership.html` disagrees with what is enforced, the **enforced rate wins**; the full list, with line numbers, is `docs/DISCOUNT_MAPPING.md` §2 (X-rays 20% flat vs the tier rate; special services, packages and additional credits promised but not enforced; every perk promised but off; credits "across functional medicine" when no functional-medicine service has a credit cost). The marketing page is **not** changed by this |

> **Revision 1.7 — decisions recorded at Phase 5 approval.**
>
> | Item | As built |
> |---|---|
> | Member discounts | *[superseded by rev 1.8: enabled]* **Not enabled.** The approval message left its choice unfilled (*"[approved as written / or list corrections]"*), so the table in `docs/DISCOUNT_MAPPING.md` stays a proposal — no category, no percentage, perks off — until the owner says which. It also has five internal conflicts the owner must settle (X-rays 20% vs 25% …). The model and the admin screen are built and tested |
> | Twilio sending | **`TwilioMessaging`** behind the `Messaging` interface (`src/integrations/twilio.ts`). Used **only when both `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` are set and `NODE_ENV` is not `test`**; otherwise the stub. `POST` to the Messages endpoint with `To`, `From`, `Body`, `StatusCallback`. Failures become a category plus the **numeric** Twilio code — never its message text. **21610** (recipient opted out) turns consent off, suppresses the number and audits it, whether Twilio refuses the send or reports it later. Logs carry message SIDs, statuses and numeric codes only, never a body or a number. Supersedes "Not built: a Twilio sending adapter" (rev 1.6) |
> | Status callbacks | `POST /api/sms/status`, verified exactly like `/api/sms/inbound` (`lib/twilioWebhook.ts`; 503 in production with no token). Records `MessageLog.deliveryStatus` and `providerErrorCode`, forward only (callbacks are unordered and repeat), audits each change, shows it on the appointment. Every message is sent with its own `StatusCallback` address, so nothing is configured in the Twilio console for it |
> | Membership dues | **A `RevenueEvent` of payment type `DUES`, status `BILLED`**, written when each month's credits are granted (`grantDue`: enrolment, resume, and the monthly job), for the tier's price at the time, dated the first day of the period in the clinic's calendar, one per (membership, period). No visit: encounter, booking and service are null (`RevenueEvent_kind` CHECK). A $0 tier bills nothing; a paused or cancelled membership is not billed. **Billed, not paid** — collection is outside the system. Supersedes "dues are not in Accounting" (rev 1.6) and completes A-13 |
> | Accounting and dues | Every Accounting view carries a **separate dues table** (screen, JSON, and a second CSV section), totalled by month, day or tier where that means something for dues and as one line otherwise. Dues are excluded from every service-revenue query, so they never add into service totals or visit counts. A service, provider or cash/credit filter leaves them out; a `DUES` payment filter leaves only them |
> | Service demand | A seventh category, **Vitamin shots & injections** (the `vitamin-shots` service — the only one the site calls an injection). Body composition is now the only seeded service in **Other**. Peptide therapy stays in Consults per A-6 |
> | Push | `scheduling-engine` is pushed to `origin/scheduling-engine`. **Not merged to `main`**, not deployed |
> | Not built | Collecting dues (no payment record; billed only), a way to re-send a text that failed for good, a real AWS adapter pair |

Companion to `docs/CURRENT_STATE.md` (what exists today). This document turns
the approved flowchart into pages, schema, API, and a five-phase plan.

---

## 0. Ground rules (decided)

| Topic | Decision |
|---|---|
| Framework | Keep Express + TypeScript |
| Database | PostgreSQL; **Prisma kept**; **Prisma Migrate for every new table** (no plain-SQL migration tool). Custom SQL (triggers, partial indexes) goes *inside* Prisma migration files via `--create-only` |
| Existing engine | **Do not modify** the locking statements (`holds.ts`, `bookings.ts`) or the booking/availability code. New features attach beside it |
| Users | Staff only. Roles: `front_desk`, `provider_chiro`, `provider_np`, `provider_nurse`, `admin`. **No patient login in any phase.** Patients are managed by the front desk |
| Public widget | Anonymous booking widget (`/`) stays exactly as-is |
| Credits | Prevent / Restore / Optimize = **4 / 6 / 8** Wellness Credits per month, **90-day rollover** |
| Prior work | Untracked patient-JWT auth and the three orphan tables were **discarded** (see CURRENT_STATE §7) |
| Front end | Continue vanilla JS multi-page (no bundler, no framework), matching the existing pages — see assumption A-1 |

Cross-cutting HIPAA rules from the brief apply from the first commit and are
mapped to concrete mechanisms in §6.

---

## 1. Roles and access

Wire values are lowercase (`@map`); Prisma identifiers uppercase, as with the
existing enums.

| Role | Linked `Staff` row | Sees |
|---|---|---|
| `front_desk` | optional | Front Desk, Schedule, Patient directory/profile, Credits, Reports |
| `provider_chiro` | **required**, `StaffRole.CHIROPRACTOR` | Provider queue + SOAP, own schedule, read-only profile for patients in their scope |
| `provider_np` | **required**, `NURSE_PRACTITIONER` | same, NP queue |
| `provider_nurse` | **required**, `REGISTERED_NURSE` | same, nurse queue |
| `admin` | optional | Everything, plus Admin (accounts, audit log, catalogue, plans). **Cannot author SOAP notes** (assumption A-4) |

`Account` (login) is deliberately separate from `Staff` (bookable provider): a
receptionist needs a login but is never bookable, and a provider's bookable
identity must outlive a password reset. Provider accounts must link to a
`Staff` row whose `role` matches — enforced at account creation.

### Module access matrix

| Module | front_desk | provider_* | admin |
|---|---|---|---|
| 1 Front Desk (dashboard) | ✅ | — | ✅ |
| Patient directory / profile / credits | ✅ | read-only demographics, scoped (see §2) | ✅ |
| 2 Schedule | ✅ edit | read own | ✅ |
| 3 Provider (queue, SOAP) | — | ✅ own specialty | read-only |
| 4 Accounting | — | — | ✅ |
| 5 Reports | ✅ | — | ✅ |
| Admin | — | — | ✅ |

Minimum-necessary: **front desk can see that a clinical note exists but not its
text**; providers and admins can read notes. This changes today's dashboard,
where the front desk reads notes (assumption A-3).

---

## 2. Page list

All staff pages require a session. Unauthenticated requests redirect to
`/login`. "Pop-up" in the flowchart is implemented as a page opened from the
nav bar (assumption A-2).

### Public (unchanged)
| Route | Purpose |
|---|---|
| `/` | Anonymous patient booking widget (+ `?service=`, `?option=` deep links). **No change** |

### Foundation
| Route | Roles | Purpose |
|---|---|---|
| `/login` | public | Staff sign-in (email + password). Generic error text; no account enumeration |
| `/change-password` | any signed-in | Forced on first login and after admin reset |
| `/app` | any | Landing: redirects to the user's default module |
| *(shell)* Main Navigation Bar | any | Five module entry points (below), role-filtered, plus user menu, sign-out, idle countdown. Injected on every staff page by a shared `shell.js` |

### 1 · Front Desk
| Route | Roles | Purpose |
|---|---|---|
| `/app/front-desk` | front_desk, admin | **Dashboard**: three columns — *Today's Appointments* (confirmed, not yet arrived) · *Checked In* · *Seen / Checked Out*. Check-in, no-show, walk-in, check-out actions; the pending-approval queue stays as a side panel |
| `/app/front-desk/patients` | front_desk, admin | **Patient Management → Patient Database Directory**: search, create |
| `/app/front-desk/patients/:id` | front_desk, admin; providers scoped | **Patient profile**, tabs: *Demographics & Contact* · *Credit Tracker* · *Visits* |
| `/app/front-desk/patients/:id#credits` | front_desk, admin | Credit Tracker: balance, lots with expiry dates, ledger, membership status, manual adjustment (admin) |

### 2 · Schedule
| Route | Roles | Purpose |
|---|---|---|
| `/app/schedule` | front_desk, admin; providers read own | **Schedule Calendar**: day grid by room or employee (today's `dashboard.html`, re-homed), plus week view per provider. Create appointment (phone/walk-in), cancel, reschedule. Existing `/dashboard.html` URL keeps working and redirects here |

### 3 · Provider
| Route | Roles | Purpose |
|---|---|---|
| `/app/provider` | provider_*, admin (view) | **Checked-In Patient Queue**, filtered by the provider's specialty. Toggle *Mine / All {specialty}* |
| `/app/provider/encounters/:id/soap` | provider_* | **SOAP Note Entry Workspace** — Method A (macro sets) and Method B (AWS Bedrock AI scribe) |
| `/app/provider/macros` | provider_*, admin (shared sets) | Create/edit custom macro sets |

### 4 · Accounting (admin only)
| Route | Purpose |
|---|---|
| `/app/accounting` | Accounting Reports Menu |
| `/app/accounting/monthly-revenue` | A1 Monthly revenue by service |
| `/app/accounting/daily-revenue` | A2 Daily revenue breakdown |
| `/app/accounting/member-vs-nonmember` | A3 Member vs non-member revenue |
| `/app/accounting/analytics` | A4 Custom financial analytics |

### 5 · Reports (front_desk, admin)
| Route | Purpose |
|---|---|
| `/app/reports` | Practice Management Reports Menu |
| `/app/reports/new-memberships` | R1 New membership sign-ups per month |
| `/app/reports/walk-ins` | R2 Walk-in volume tracker |
| `/app/reports/weekend-visits` | R3 Weekend visit metrics |
| `/app/reports/service-demand` | R4 Service demand: Chiro, HBOT, Red Light, IV, Consult, Bloodwork |

### Admin (admin only)
| Route | Purpose |
|---|---|
| `/app/admin` | Existing `admin.html` content (staff & shifts, rooms, services incl. rooms/people/color). `/admin.html` keeps working |
| `/app/admin/accounts` | Create/deactivate accounts, set role, link `Staff`, reset password, unlock |
| `/app/admin/audit` | Audit log viewer (filter by actor, resource, date) |
| `/app/admin/membership` | Plans, credit cost per service, member discounts |

**URL hygiene.** No patient names, dates of birth, phone numbers or search
terms in any URL, query string, or page `<title>`. IDs are opaque UUIDs. All
patient search is `POST` with a JSON body.

---

## 3. Flowchart traceability

Every node in the approved flowchart maps to something below.

| Node | Implemented as | Phase |
|---|---|---|
| User Sign-In / Authentication / Role-Based Access | `/login`, `Account`, `Session`, role middleware | 1 |
| Main Navigation Bar | `shell.js` nav, 5 entries | 1 |
| 1. Front Desk | `/app/front-desk` | 2 |
| Front Desk Pop-Up Dashboard | same page | 2 |
| Left: Today's Appointments | column 1 (`Encounter.status = SCHEDULED`) | 2 |
| Middle: Patients Checked In | column 2 (`CHECKED_IN`, `IN_PROGRESS`) | 2 |
| Right: Seen / Checked Out | column 3 (`SEEN`, `CHECKED_OUT`) | 2 |
| Patient Management Button / Patient Database Directory | `/app/front-desk/patients` | 3 |
| Select Patient Profile | `/app/front-desk/patients/:id` | 3 |
| Demographics & Contact Details | profile tab 1, `Patient` | 3 |
| Credit Tracker Sub-Tab | profile tab 2, `CreditLedger` | 3 |
| Auto Add/Subtract Monthly Membership Credits | scheduled job: monthly grant + 90-day expiry; redemption at check-out | 3 |
| 2. Schedule / Schedule Calendar Pop-Up | `/app/schedule` | 1 (interim: existing grid), 2 (calendar) |
| 3. Provider / Checked-In Patient Queue | `/app/provider` | 4 |
| Role Filter / Provider Specialty | queue filtered by `Staff.role` of the booking's provider | 4 |
| Chiro / NP / Nurse Scheduled Patients | the three specialty views of the same queue | 4 |
| Select Patient Pending SOAP Note | queue rows with no signed note | 4 |
| SOAP Note Entry Workspace | `/app/provider/encounters/:id/soap` | 4 |
| Method A: Custom Provider Macro Sets | `MacroSet`, `Macro` | 4 |
| Method B: AWS Bedrock HIPAA AI Scribe Recording | `ScribeSession` + Transcribe Medical + Bedrock | 4 |
| 4. Accounting / Menu / A1–A4 | `/app/accounting/*` over `Charge` | 5 |
| 5. Reports / Menu / R1–R4 | `/app/reports/*` over `Membership`, `Booking`, `Encounter` | 5 |

---

## 4. Database schema

Conventions: UUID string primary keys (as existing); timestamps are
`timestamptz`; money is integer cents; **clinical records carry `deletedAt`**
and are never hard-deleted; the Prisma client is extended to filter
`deletedAt IS NULL` by default. Existing tables are unchanged except where
listed in §4.6 (all additive, nullable or defaulted).

### 4.1 Phase 1 — Foundation

```prisma
enum AccountRole {
  FRONT_DESK     @map("front_desk")
  PROVIDER_CHIRO @map("provider_chiro")
  PROVIDER_NP    @map("provider_np")
  PROVIDER_NURSE @map("provider_nurse")
  ADMIN          @map("admin")
}

model Account {
  id                 String      @id @default(uuid())
  email              String      @unique          // login id
  displayName        String
  passwordHash       String                        // Argon2id
  role               AccountRole
  staffId            String?     @unique           // required for PROVIDER_*
  active             Boolean     @default(true)    // soft delete
  mustChangePassword Boolean     @default(true)
  failedLoginCount   Int         @default(0)
  lockedUntil        DateTime?
  lastLoginAt        DateTime?
  passwordChangedAt  DateTime?
  createdById        String?
  createdAt          DateTime    @default(now())
  updatedAt          DateTime    @updatedAt
  staff    Staff?    @relation(fields: [staffId], references: [id])
  sessions Session[]
}

model Session {
  id             String    @id @default(uuid())
  accountId      String
  tokenHash      String    @unique        // SHA-256 of the opaque cookie value; raw token never stored
  csrfToken      String
  createdAt      DateTime  @default(now())
  lastActivityAt DateTime  @default(now()) // sliding 15-minute idle window
  expiresAt      DateTime                  // absolute cap (default 12 h)
  revokedAt      DateTime?
  ipAddress      String?
  userAgent      String?
  account Account @relation(fields: [accountId], references: [id], onDelete: Cascade)
  @@index([accountId])
  @@index([lastActivityAt])
}

enum AuditAction {
  CREATE
  READ
  UPDATE
  DELETE
  EXPORT
  LOGIN
  LOGIN_FAILED
  LOGOUT
  LOCKOUT
  PASSWORD_CHANGE
  PASSWORD_RESET
}
model AuditLog {              // append-only; a DB trigger rejects UPDATE and DELETE
  id             BigInt      @id @default(autoincrement())
  occurredAt     DateTime    @default(now())
  actorAccountId String?                       // null = public widget / system job
  actorRole      String?
  action         AuditAction
  resourceType   String                        // 'patient' | 'appointment' | 'soap_note' | 'credit_ledger' | …
  resourceId     String?                       // opaque id; null for list reads
  success        Boolean     @default(true)
  requestId      String?
  ipAddress      String?
  meta           Json?                         // NON-PHI only: counts, changed FIELD NAMES, never values
  @@index([resourceType, resourceId])
  @@index([actorAccountId, occurredAt])
  @@index([occurredAt])
}
```

### 4.2 Phase 2 — Schedule + Front Desk

```prisma
enum BookingSource {
  ONLINE
  PHONE
  WALK_IN
  FRONT_DESK
}
enum EncounterStatus {
  SCHEDULED
  CHECKED_IN
  IN_PROGRESS
  SEEN
  CHECKED_OUT
  NO_SHOW
}
/// The visit itself. Separate from Booking so the existing approval lifecycle
/// (HOLD/PENDING/CONFIRMED/…) is untouched and the front-desk columns have
/// their own state machine.
model Encounter {
  id             String          @id @default(uuid())
  bookingId      String          @unique
  status         EncounterStatus @default(SCHEDULED)
  checkedInAt    DateTime?
  checkedInById  String?          // Account
  startedAt      DateTime?        // provider opened the SOAP workspace
  startedById    String?
  seenAt         DateTime?        // note signed (or provider marked seen)
  checkedOutAt   DateTime?
  checkedOutById String?
  noShowAt       DateTime?
  scribeConsentAt DateTime?       // patient agreed to AI recording (Phase 4)
  createdAt      DateTime        @default(now())
  updatedAt      DateTime        @updatedAt
  deletedAt      DateTime?
  booking Booking @relation(fields: [bookingId], references: [id])
  @@index([status, checkedInAt])
}
```

### 4.3 Phase 3 — Patient Profile + Credits

> *Original design. **As built: see Revision 1.4 at the top of this document** (`Charge` → `RevenueEvent`, no `PlanDiscount`, perks tracked).*

```prisma
enum ContactMethod {
  PHONE
  SMS
  EMAIL
}
enum MembershipStatus {
  ACTIVE
  PAUSED
  CANCELLED
}
enum LedgerReason {
  MONTHLY_GRANT
  PURCHASE
  REDEMPTION
  EXPIRATION
  ADJUSTMENT
  REVERSAL
}
enum PaymentMethod {
  CASH
  CARD
  CREDITS
  COMP
  OTHER
}
enum ChargeKind {
  SERVICE
  MEMBERSHIP_DUES
  EXTRA_CREDITS
  OTHER
}
enum DiscountKind {
  XRAY
  EXTRA_CREDITS
  SPECIAL_SERVICES
  PACKAGES
  SUPPLEMENTS
}
model Patient {
  id                String        @id @default(uuid())
  firstName         String
  lastName          String
  preferredName     String?
  dateOfBirth       DateTime?     @db.Date
  sex               String?
  phone             String
  email             String?
  addressLine1      String?
  addressLine2      String?
  city              String?
  state             String?
  postalCode        String?
  emergencyName     String?
  emergencyPhone    String?
  emergencyRelation String?
  preferredContact  ContactMethod @default(PHONE)
  smsOptIn          Boolean       @default(false)
  smsOptInAt        DateTime?
  frontDeskNote     String?       // non-clinical (e.g. "prefers mornings")
  createdById       String
  createdAt         DateTime      @default(now())
  updatedAt         DateTime      @updatedAt
  deletedAt         DateTime?
  @@index([lastName, firstName])
  @@index([phone])
}
// Deliberately NOT collected: SSN, insurance (cash practice), payment card data.

model MembershipPlan {
  id                   String   @id @default(uuid())
  code                 String   @unique       // 'PREVENT' | 'RESTORE' | 'OPTIMIZE'
  name                 String
  priceCents           Int                    // 9900 / 19900 / 29900
  creditsPerMonth      Int                    // 4 / 6 / 8
  rolloverDays         Int      @default(90)
  extraCreditPriceCents Int?                  // price of one additional credit (not yet specified)
  active               Boolean  @default(true)
  sortOrder            Int      @default(0)
  discounts PlanDiscount[]
}

model PlanDiscount {            // member savings: 20% X-rays, 10–20% supplements, …
  planId  String
  kind    DiscountKind
  percent Int
  plan MembershipPlan @relation(fields: [planId], references: [id])
  @@id([planId, kind])
}

model Membership {
  id          String           @id @default(uuid())
  patientId   String
  planId      String
  status      MembershipStatus @default(ACTIVE)
  startedOn   DateTime         @db.Date
  nextGrantOn DateTime         @db.Date        // next monthly credit date (clinic timezone)
  pausedAt    DateTime?
  cancelledAt DateTime?
  createdById String
  createdAt   DateTime         @default(now())
  updatedAt   DateTime         @updatedAt
  @@index([patientId])
  @@index([status, nextGrantOn])
  // + partial unique index in the migration SQL: one ACTIVE/PAUSED membership per patient
}

/// Append-only. Never updated or deleted (DB trigger). Corrections are
/// REVERSAL / ADJUSTMENT rows. Balance = SUM(delta).
model CreditLedger {
  id             BigInt       @id @default(autoincrement())
  patientId      String
  membershipId   String?
  reason         LedgerReason
  delta          Int                          // + grant/purchase, − redemption/expiry
  lotExpiresOn   DateTime?    @db.Date        // set on grants/purchases: occurredOn + 90 d
  periodStart    DateTime?    @db.Date        // MONTHLY_GRANT idempotency key
  encounterId    String?
  chargeId       String?
  actorAccountId String?                       // null = scheduled job
  reasonCode     String?                       // short controlled vocabulary, NOT free text
  createdAt      DateTime     @default(now())
  @@unique([membershipId, periodStart, reason])  // a re-run cannot double-grant
  @@index([patientId, createdAt])
}

/// Which grant lot a redemption drew from (FIFO by expiry), so expiry can
/// compute what is left in each lot without mutating any row.
model CreditAllocation {
  id              BigInt @id @default(autoincrement())
  redemptionId    BigInt
  grantId         BigInt
  amount          Int
  @@index([grantId])
}

model Charge {
  id               String        @id @default(uuid())
  encounterId      String?
  patientId        String?
  serviceId        String?
  kind             ChargeKind
  listCents        Int
  discountCents    Int           @default(0)
  paidCents        Int                            // cash/card actually collected
  creditsRedeemed  Int           @default(0)
  paymentMethod    PaymentMethod
  wasMember        Boolean       @default(false)  // snapshot at time of sale
  membershipPlanId String?
  occurredAt       DateTime      @default(now())
  recordedById     String
  voidedAt         DateTime?
  voidedById       String?
  voidReason       String?
  createdAt        DateTime      @default(now())
  @@index([occurredAt])
  @@index([patientId])
  @@index([serviceId, occurredAt])
}
```

### 4.4 Phase 4 — Provider + SOAP

```prisma
enum SoapStatus {
  DRAFT
  SIGNED
}
enum SoapSource {
  MANUAL
  MACRO
  AI_SCRIBE
}
enum SoapSection {
  S
  O
  A
  P
  ANY
}
enum ScribeStatus {
  RECORDING
  UPLOADED
  TRANSCRIBING
  GENERATING
  READY
  FAILED
  DISCARDED
}
model SoapNote {                 // one per encounter; changes after signing are revisions
  id               String     @id @default(uuid())
  encounterId      String     @unique
  authorAccountId  String                       // from the session, never the request body
  providerStaffId  String
  status           SoapStatus @default(DRAFT)
  source           SoapSource @default(MANUAL)
  subjective       String     @default("")
  objective        String     @default("")
  assessment       String     @default("")
  plan             String     @default("")
  currentRevision  Int        @default(0)
  signedAt         DateTime?
  createdAt        DateTime   @default(now())
  updatedAt        DateTime   @updatedAt
  deletedAt        DateTime?
  revisions SoapNoteRevision[]
}

model SoapNoteRevision {         // immutable (DB trigger); created on sign and on every amendment
  id              String   @id @default(uuid())
  noteId          String
  revisionNo      Int
  subjective      String
  objective       String
  assessment      String
  plan            String
  authorAccountId String
  amendReason     String?                       // required for revisionNo > 1
  createdAt       DateTime @default(now())
  note SoapNote @relation(fields: [noteId], references: [id])
  @@unique([noteId, revisionNo])
}

model MacroSet {
  id             String   @id @default(uuid())
  ownerAccountId String?                        // null = shared set (admin-managed)
  name           String
  active         Boolean  @default(true)
  createdAt      DateTime @default(now())
  macros Macro[]
}

model Macro {
  id      String      @id @default(uuid())
  setId   String
  trigger String                                // e.g. ".lbp"
  section SoapSection @default(ANY)
  body    String                                // reusable text; must not contain patient data
  active  Boolean     @default(true)
  set MacroSet @relation(fields: [setId], references: [id])
  @@unique([setId, trigger])
}

model ScribeSession {            // transcript and audio live in S3; only keys here
  id            String       @id @default(uuid())
  encounterId   String
  status        ScribeStatus @default(RECORDING)
  consentAt     DateTime                         // patient consent captured BEFORE recording
  consentById   String
  audioKey      String?
  transcriptKey String?
  modelId       String?                          // which Bedrock model produced the draft
  errorClass    String?                          // class only — never a message
  createdById   String
  createdAt     DateTime     @default(now())
  completedAt   DateTime?
  audioPurgedAt DateTime?
  deletedAt     DateTime?
  @@index([encounterId])
}
```

### 4.5 Phase 5 — Accounting + Reports

> *Original design. **As built: see Revision 1.6 at the top of this document** (`RevenueEvent` instead of `Charge`; `RevenueEvent.staffId` and three indexes; no `Service.reportGroup`).*

No new tables beyond indexes: reports and accounting read `Charge`,
`CreditLedger`, `Membership`, `Booking`, `Encounter`. One addition to `Service`
(§4.6). All date bucketing is done in the **clinic timezone**
(`America/Chicago`), not UTC — a 9 pm Central sale belongs to that day.

### 4.6 Changes to existing tables (all additive)

| Table | Change | Phase | Why |
|---|---|---|---|
| `Staff` | `account Account?` back-relation | 1 | Link login to provider |
| `Booking` | `encounter Encounter?` back-relation (Prisma-only, no column) | 2 | Required by Prisma for `Encounter.booking` |
| `Booking` | `source BookingSource @default(ONLINE)` | 2 | Walk-in / phone tracking. Existing code never sets it, so the default applies |
| `Booking` | `createdByAccountId String?`, `rescheduledFromId String?` | 2 | Who booked; reschedule chain |
| `Booking` | `patientId String?` (+ index) | 3 | Link a booking's contact to a canonical patient. Set by new code only |
| `Service` | `creditCost Int?` | 3 | Seed: adjustment 2, red light 2, HBOT-60 4, HBOT-90 6, vitamin shot 2, IV 6; null = not credit-eligible |
| `Service` | `requiresSoapNote Boolean @default(true)` | 4 | Which services need a note (A-5) |
| `Service` | `reportGroup` enum `CHIRO HBOT RED_LIGHT IV CONSULT BLOODWORK OTHER` | 5 | Service-demand grouping (A-6) |
| `VisitNote` | none — superseded by `SoapNote` in Phase 4; kept read-only, removed in a later migration. Its `authorId` is sourced from the session from Phase 1 | 1/4 | Authorship proven |

Existing tables are never dropped or renamed. The Prisma client export in
`src/lib/prisma.ts` is replaced by an **extended** client (audit + soft-delete
filters); no route file changes for this.

---

## 5. API

Existing paths are kept. "S" = session required. All state-changing requests
require the `x-csrf-token` header. Every route below that touches
patient / appointment / SOAP / credit data writes an `AuditLog` row (§6).

### 5.1 Foundation (Phase 1)
| Method · Path | Roles | Purpose |
|---|---|---|
| `POST /api/auth/login` | public | Email + password → httpOnly cookie. Rate limited; account lockout |
| `POST /api/auth/logout` | S | Revoke session |
| `GET /api/auth/me` | S | Role, display name, allowed modules, CSRF token, seconds until idle expiry |
| `POST /api/auth/ping` | S | Activity heartbeat (resets idle window) |
| `POST /api/auth/change-password` | S | |
| `GET/POST /api/admin/accounts` | admin | List / create (temp password, `mustChangePassword`) |
| `PATCH /api/admin/accounts/:id` | admin | Role, active, staff link |
| `POST /api/admin/accounts/:id/reset-password` · `/unlock` | admin | |
| `GET /api/admin/audit` | admin | Filter by actor / resource / date (opaque ids only) |

**Re-authenticated existing routes** (shared token removed): `/api/front-desk/*`,
`/api/admin/*` (staff, resources, services), `PATCH /api/bookings/:id`,
`/api/bookings/:id/notes`, `/api/visit-notes/:id/amend`, `/api/patients*`
(front-desk). **Removed:** `GET/POST /api/admin/purge`. **Unchanged public:**
`/api/config`, `/api/services`, `/api/availability*`, `/api/holds*`,
`POST /api/bookings`, `GET /api/bookings/:id`.

### 5.2 Schedule + Front Desk (Phase 2)
| Method · Path | Roles | Purpose |
|---|---|---|
| `GET /api/fd/dashboard?date=` | fd, admin | Three columns for a day |
| `POST /api/fd/encounters/:bookingId/check-in` | fd, admin | |
| `POST /api/fd/encounters/:id/undo-check-in` · `/no-show` | fd, admin | |
| `POST /api/fd/walk-ins` | fd, admin | Create a same-day booking + encounter (new locked transaction; see Risk R-2) |
| `GET /api/schedule/calendar?from=&to=&groupBy=room\|staff` | fd, admin; provider own | Day/week data |
| `POST /api/schedule/appointments` | fd, admin | Staff-created booking (source PHONE/FRONT_DESK) via the existing availability engine |
| `POST /api/schedule/appointments/:id/reschedule` | fd, admin | Cancel + rebook, linked |
| `POST /api/fd/encounters/:id/check-out` | fd, admin | Phase 2: state only. Phase 3 adds charge + credits |

### 5.3 Patient Profile + Credits (Phase 3)

> *Original design. As built the credit endpoints are `GET /api/fd/patients/:id/credits`, `POST …/credits/adjust` (admin), `POST|PATCH …/membership`, `POST …/perks/:perkId/use`, `GET /api/membership-plans`, the admin `…/membership-plans` routes, and check-out as above. There is no `POST /api/fd/charges/:id/void`.*
| Method · Path | Roles | Purpose |
|---|---|---|
| `POST /api/fd/patients/search` | fd, admin | **POST, body search** — no PHI in URLs |
| `POST /api/fd/patients` | fd, admin | Create |
| `GET/PATCH /api/fd/patients/:id` | fd, admin; provider scoped read | Demographics |
| `DELETE /api/fd/patients/:id` | admin | **Soft** delete |
| `POST /api/fd/patients/:id/link-booking` | fd, admin | Attach a booking contact to the patient |
| `GET /api/fd/patients/:id/visits` | fd, admin; provider | Appointment history (note text only for providers/admin) |
| `GET /api/fd/patients/:id/credits` | fd, admin | Balance, lots + expiry, ledger page |
| `POST /api/fd/patients/:id/credits/adjust` | admin | Manual adjustment (reason code required) |
| `GET/POST/PATCH /api/fd/patients/:id/membership` | fd, admin | Enroll, change plan, pause, cancel |
| `GET /api/membership-plans` · `PATCH /api/admin/membership-plans/:id` | any S · admin | |
| `POST /api/fd/charges/:id/void` | admin | Append a void; never delete |
| *(job)* `credits:monthly-grant`, `credits:expire` | system | Idempotent; see §7 Phase 3 |

### 5.4 Provider + SOAP (Phase 4)
| Method · Path | Roles | Purpose |
|---|---|---|
| `GET /api/provider/queue?scope=mine\|specialty` | provider_* | Checked-in patients awaiting a note |
| `GET /api/provider/encounters/:id` | provider_* | Encounter + patient summary (demographics, relevant history) |
| `POST /api/provider/encounters/:id/start` | provider_* | → `IN_PROGRESS` |
| `GET/PUT /api/provider/encounters/:id/soap` | provider_* | Read / autosave draft |
| `POST /api/provider/encounters/:id/soap/sign` | provider_* | Immutable revision 1; → `SEEN` |
| `POST /api/provider/encounters/:id/soap/amend` | provider_* | New revision; `reason` required |
| `GET/POST/PATCH /api/provider/macro-sets` · `/macros` | provider_*; admin shared | Active-flag deactivate, not delete |
| `POST /api/provider/encounters/:id/scribe` | provider_* | Create session; body carries consent confirmation |
| `POST /api/provider/scribe/:sid/upload-url` · `/finish` | provider_* | Signed upload target (S3 or local adapter); start pipeline |
| `GET /api/provider/scribe/:sid` | provider_* | Poll status |
| `POST /api/provider/scribe/:sid/apply` · `/discard` | provider_* | Pull draft into the note / purge audio |

### 5.5 Accounting + Reports (Phase 5)

> *Original design. **As built: see Revision 1.6** — `GET /api/accounting/{options,monthly,daily,members,custom}` and `GET /api/reports/{signups,walkins-day,walkins-hour,weekend,demand}`, each with `?from&to` and `&format=csv`; no analytics `POST` builder.*
| Method · Path | Roles |
|---|---|
| `GET /api/accounting/revenue/monthly?from&to` · `/daily?from&to` · `/member-vs-nonmember?from&to` | admin |
| `POST /api/accounting/analytics/query` | admin — dimensions × measures × filters, JSON body |
| `GET /api/accounting/*/export` | admin — CSV, audited as `EXPORT` |
| `GET /api/reports/new-memberships` · `/walk-ins` · `/weekend-visits` · `/service-demand` | fd, admin |

Reports return **aggregates only** — no patient identifiers.

---

## 6. HIPAA controls → mechanisms

| Requirement | Mechanism | Phase |
|---|---|---|
| No PHI in logs, errors, URLs | `lib/logger.ts` is the only allowed logger (CI grep fails on `console.*` in `src/`). Errors log **class, a PHI-stripped message, and request ID only**. Prisma errors: code + model name; the `message` is never logged (it embeds query arguments). Zod errors: field paths only. Error responses to clients carry a request reference, never `err.message`. Search is `POST`. | 1 |
| Audit every C/R/U/D on patient, appointment, soap_note, credit_ledger | **Writes:** a Prisma client extension intercepts create/update/upsert/delete (and `*Many`, resolving ids first) on audited models and writes the `AuditLog` row **in the same transaction**. Because it wraps the client, the existing booking code is audited without being edited. Actor and request ID come from `AsyncLocalStorage`; the public widget audits as actor `null`. **Reads:** explicit `audit.read()` in handlers that return PHI; list/search = one row, `resourceId` null, count in `meta`. *Deliberate exemption:* the availability engine reads bookings for occupancy but returns no PHI, so it is not audited (would be noise). Audited models: patient, booking (appointment), encounter, soap_note + revisions, credit_ledger, membership, charge, visit_note, user (booking contact), account. | 1 (+ each model as it lands) |
| *[rev 1.1]* The four hand-written `SELECT … FOR UPDATE` statements (`holds.ts` ×2, `bookings.ts` ×2) | The Prisma client extension cannot see raw SQL, so these were examined individually: each reads only opaque `id`s from `Resource` / `Staff` (neither is PHI nor an audited resource) and writes nothing — they are lock acquisitions. The PHI-bearing writes inside those same transactions (`booking.create/update`, `user.create`) go through the client and **are** audited, with the actor. What no client hook can see is an attempt *refused before any write* — a 409 slot-taken or 410 hold-expired — so those four routes (plus `GET /api/holds/:id`, `GET /api/bookings/:id` and the staff read routes) are covered by route-level `auditAccess()` middleware mounted in `index.ts`, recording refusals as `success=false` and reads as `READ`. The locking code itself is untouched | 1 |
| *[rev 1.1]* Audit entries are buffered per request and flushed in one insert after the response | An inline insert from inside a Prisma interactive transaction needs a second pooled connection; under the booking race every connection can be held by a transaction waiting on a row lock held by one that is waiting for a connection. Buffering removes the possibility. Trade-off: a process killed between a commit and the flush loses that entry. New Phase 2+ code that must be atomic with its audit row uses `auditInTx()` | 1 |
| Never PHI *values* in audit rows | `meta` holds counts and changed field **names** only | 1 |
| Role-based access, minimum necessary | `requireRole(...)` per route; front desk cannot read note text; providers scoped to their queue/patients | 1 → 4 |
| 15-minute inactivity logout | Server-side session, sliding `lastActivityAt`; cookie is opaque, httpOnly, `Secure`, `SameSite=Strict`; client countdown + warning. 12 h absolute cap | 1 |
| Per-person accountability | Per-user accounts; note author = session, request-body author field **dropped**; approvals record the acting account | 1 |
| Password handling | Argon2id (`@node-rs/argon2`, prebuilt — no native build), ≥12 chars, common-password check, lockout after 5 failures / 15 min, forced change on first login | 1 |
| CSRF | `SameSite=Strict` + per-session token in `x-csrf-token`; CORS restricted to an allowlist (today it is `cors()` open) | 1 |
| Secrets in env, `.env.example` committed | Extended with every new variable; **no hard-coded fallbacks** — missing secret = refuse to start | 1 |
| Refuse to start in production without DB TLS | Startup check: `NODE_ENV=production` requires `sslmode=require\|verify-ca\|verify-full` (or `ssl=true`) in `DATABASE_URL` | 1 |
| Soft-delete only on clinical records | `deletedAt` + client extension default filter; `credit_ledger`, `audit_log`, `soap_note_revision` are append-only via DB triggers; `POST /admin/purge` deleted | 1 |
| Immutable audit trail | `audit_log` UPDATE/DELETE rejected by trigger (in the Prisma migration) | 1 |
| Vendor isolation | `StorageProvider` (S3 / local disk), `SpeechToText` (Transcribe Medical / stub), `NoteGenerator` (Bedrock / stub), `MessageSender` (Twilio / console). Selected by env; dev stubs are the default; prod config missing → refuse to start | 1 |
| SMS content | Template IDs only in logs; message text carries no clinical detail; opt-in captured per patient | 2–3 |
| Transcript/audio are PHI | Stored only in S3 (SSE), keyed by opaque id; DB holds keys; audio purge after note is signed (retention window: A-7) | 4 |

Out of the app's hands (yours): BAAs with AWS, Twilio and the database host;
S3/Transcribe/Bedrock regions and logging settings; backups; encryption at
rest verification; policies and training (`GOING-LIVE.md` §B, §D).

---

## 7. Build plan

Each phase ends with: typecheck clean, existing `race-test.sh` still gives
exactly-one-winner, new tests green, a demo against seed data, and your
review before the next phase.

### Phase 1 — Foundation  *(size: L)* — **built; see `docs/PHASE1_NOTES.md`**
**Migrations:** `Account`, `Session`, `AuditLog` (+ immutability trigger), soft-delete columns where clinical tables exist.
**Build:**
- Per-user auth: login/logout/me/ping/change-password, Argon2id, lockout, httpOnly session cookie, 15-min idle + 12-h cap, CSRF header, restricted CORS.
- `requireRole()`; **replace the shared front-desk token** on every existing staff route; `VisitNote.authorId` from session (body field removed); booking approvals record the actor.
- Retire the `DEMO_USER`/`DEMO_PASSWORD` Basic gate for staff routes (individual logins replace it).
- Bootstrap: `npm run create-admin` (prompts; never from env defaults) to create the first admin.
- Navigation shell with the **five module entry points**: Front Desk and the three not-yet-built modules show a "Phase N" placeholder; **Schedule opens the existing grid** so nothing regresses. Existing `/dashboard.html` and `/admin.html` keep working behind login.
- Audit: Prisma client extension (writes) + `audit.read()` helper; audit viewer for admins.
- PHI-safe logger; **fix the five raw-error handlers** (`index.ts` sweep, `notes`, `bookings` ×2, `holds`); CI grep rule banning `console.*`.
- **Delete `POST/GET /admin/purge`** and the admin danger-zone UI; add `scripts/dev-reset.ts` that exits non-zero when `NODE_ENV=production`.
- Service interfaces + dev stubs: `StorageProvider`, `SpeechToText`, `NoteGenerator`, `MessageSender`.
- Production guards: DB-TLS refuse-to-start, no secret fallbacks, complete `.env.example`.
- README: local setup, scripts, role matrix, how to run tests.
- Test harness (Vitest): auth, idle expiry, lockout, RBAC, audit-extension, logger redaction; keep race tests as a gate.
**Exit:** can't reach any staff API without a session; idle session dies at 15 min; a note's author cannot be spoofed; grep finds no raw error logging; race test unchanged.
**Needs from you:** a new database (the old one expired); the first admin's email; MFA decision (A-9).

### Phase 2 — Schedule + Front Desk  *(M → L: now includes the patient directory)* — *[rev 1.2]*
**Migrations:** `Patient`, `MessageLog`; `Booking.source`, `createdByAccountId`, `patientId`; `Service.documentationType`. (`Encounter` shipped in Phase 1. `rescheduledFromId` is not added: a move updates the appointment in place, so its encounter, patient link and history stay attached.)
**Rev 1.2 build additions:** patient directory (POST search) and profile with demographics and contact details; a Credit Tracker placeholder tab; confirmation text and a 24-hour reminder text, sent by an idempotent scheduled job through the stubbed `Messaging` interface, only to patients with recorded SMS consent, and only inside 08:00–21:00 clinic time.
**Build:** three-column Front Desk dashboard; check-in / undo / no-show / check-out (state only); walk-ins; Schedule calendar (day by room/employee — re-homing today's grid — plus week view); staff-created appointments through the existing availability engine; cancel and reschedule; confirmation SMS on approval via `MessageSender` (stub in dev).
**Exit:** an appointment can be created, checked in, and checked out end-to-end by front desk; walk-in racing test (extend `race-test.sh`) still yields no double-booking.
**Needs from you:** Twilio account + A2P 10DLC registration (carrier lead time — start early) if SMS is in scope (A-8).

### Phase 3 — Credits + Membership  *(L)* — **built; see `docs/PHASE3_NOTES.md`** — *[rev 1.2: the Patient entity, directory and profile are built in Phase 2; this phase fills in the Credit Tracker tab. May be swapped with Phase 4.]*
**Migrations:** ~~`Patient`~~ *(Phase 2)*, `MembershipPlan`, `PlanDiscount`, `Membership`, `CreditLedger` (+ append-only trigger, partial unique index), `CreditAllocation`, `Charge`; ~~`Booking.patientId`~~ *(Phase 2)*; `Service.creditCost`.
**Build:** the Credit Tracker tab on the profile; membership enroll/pause/cancel; credit engine — monthly grant (idempotent, unique per membership+period), 90-day expiry job, FIFO redemption at check-out; check-out step records the `Charge` and redeems credits; manual adjustment (admin); worker + scheduler entry point (`npm run jobs`) for the platform cron; **`membership.html` updated to the 4/6/8 structure and new copy**; seed plans and credit costs. *(The reminder SMS job moved to Phase 2.)*
**Exit:** running the monthly job twice grants once; a redemption consumes the oldest lot; balance always equals `SUM(delta)`; ledger rows cannot be updated or deleted at the DB.
**Needs from you:** price of an additional credit (A-10); cancellation forfeiture rule (A-11); whether included perks (monthly shot/IV, quarterly body composition, guest passes) are tracked (A-12).

### Phase 4 — Provider + SOAP  *(L)*
**Migrations:** `SoapNote`, `SoapNoteRevision` (immutable), `MacroSet`, `Macro`, `ScribeSession`; `Service.requiresSoapNote`.
**Build:** specialty-filtered queue (Mine / All); SOAP workspace with autosave; **Method A** macro sets with trigger expansion and a manager page; **Method B** AI scribe — in-browser recording, consent captured first, upload via signed target, Transcribe → Bedrock → structured S/O/A/P **draft that is never auto-signed**; sign → revision 1 → encounter `SEEN`; amend with required reason; legacy `VisitNote` endpoints made read-only; audio purge job. Recording counts as session activity (see R-4).
**Exit:** a note cannot be signed by anyone but its provider; every revision is retained; draft AI text is visibly marked until the provider edits and signs; stubs let the whole flow run with no AWS credentials.
**Needs from you:** AWS account, BAA, Bedrock model access, region, S3 bucket, IAM role (A-7); which services need notes (A-5).

### Phase 5 — Accounting + Reports  *(M)* — **built; see `docs/PHASE5_NOTES.md`**
**Migrations:** indexes; `Service.reportGroup`.
**Build:** A1–A4 and R1–R4, date-range filters, CSV export (audited), timezone-correct bucketing; analytics builder = measures (revenue, count, credits redeemed) × dimensions (service, category, day/month, member status, payment method) × filters.
**Exit:** report totals reconcile to `Charge` rows to the cent; Saturday/DST boundaries bucket correctly.
**Needs from you:** report-group mapping (A-6), revenue basis (A-13), who may see Accounting (A-14).

---

## 8. Risks

| # | Risk | Mitigation |
|---|---|---|
| R-1 | Swapping `prisma` for an extended client (audit + soft-delete) could change behaviour inside the **locking transactions** | The extension only wraps writes; `$queryRaw` lock statements are unaffected. Gate: `race-test.sh` before/after, plus a test that the extended tx client still applies hooks |
| R-2 | Walk-ins need a booking at/after "now", but the engine refuses past slots, and you asked me not to modify it | New endpoint calls `computeDayAvailability(…, now)` (it already takes `now`) to pick a legal slot, then writes inside a **new** transaction that takes locks in the same `ORDER BY id` order. New code, same convention; extend the race test |
| R-3 | Auth swap breaks the working dashboard/admin pages | Phase 1 keeps both URLs, replacing only their token gate with a login redirect; manual regression pass on each existing page |
| R-4 | 15-min idle timeout vs. a provider silently doing hands-on care while recording | Active recording sends heartbeats. This slightly loosens "inactivity" — needs your compliance sign-off |
| R-5 | The free DB expired and will again; a real patient record can't live on a 90-day database | Treat the Supabase/Render free tier as **demo only**; production = paid DB with backups (`GOING-LIVE.md` B2/A6) |
| R-6 | Pooled connections (Supabase pgbouncer) can interfere with Prisma migrations | Run migrations on the direct connection; runtime may use the pooler |
| R-7 | Prisma Migrate cannot express triggers/partial indexes natively | Put the SQL inside migration files via `--create-only`; still Prisma Migrate, as instructed |
| R-8 | Patient merge/duplicate errors in the directory | No auto-merge; suggestions only; merge is an audited admin action in a later phase if needed |

---

## 9. Assumptions and open decisions

Each has a default; say "defaults OK" or override.

| ID | Item | Default |
|---|---|---|
| A-1 | UI stack | Stay vanilla JS multi-page (matches repo, no build step). Swap to React only if you want it; the calendar and SOAP workspace are the heaviest screens |
| A-2 | "Pop-up" in the flowchart | A page opened from the nav bar, not a browser pop-up window |
| A-3 | Front desk and note text | Front desk sees *that* a note exists, not its content |
| A-4 | Admin and SOAP authoring | Admin can read but not author notes. If the owner is also a provider, give them a provider account — or tell me to allow multi-role accounts |
| A-5 | Which services need a SOAP note | All, except Body Composition, Red Light, and Hyperbaric, which default off (admin toggle) |
| A-6 | Report-group mapping | Chiro = adjustment/exam/X-ray · HBOT · Red Light · IV · Consult = FM consult, wellness planning, hormone, peptide, supplementation · Bloodwork = biomarker testing · Other = vitamin shots, body composition |
| A-7 | AI audio/transcript retention | Audio purged 30 days after note signing; ~~transcript 90 days~~ *[rev 1.6: transcript and draft stay with the encounter]*; consent required per encounter. AWS BAA/region/IAM are yours |
| A-8 | SMS in scope | Yes: confirmation (Phase 2) + reminders (Phase 3), opt-in required, no clinical detail in message text |
| A-9 | MFA | Not in Phase 1; strongly recommended for `admin` before real PHI. Say if you want it earlier |
| A-10 | Price of an additional credit | Admin-set field, blank until you give a number (the 20% member discount applies to it) |
| A-11 | Credits on cancellation | No new grants; existing lots run out their 90 days |
| A-12 | Included perks (monthly shot/IV, quarterly body comp, guest passes) | **Not tracked** — credits only. Say if perk tracking should be added to Phase 3 |
| A-13 | Revenue basis for Accounting | *[rev 1.7: dues are BILLED when the month's credits are granted and shown as their own line; collection is not recorded]* Cash basis: dues recorded when collected; credit-redeemed services show $0 cash plus their list value as a separate column. Confirm with your accountant |
| A-14 | Accounting visibility | Admin only; Reports to front desk + admin |
| A-15 | Session length | 15 min idle, 12 h absolute |
| A-16 | Documents upload | Storage interface supports it; no patient-document screen because the flowchart has none |
| A-17 | Weekend metrics | "Weekend" = Saturday (Sunday is closed today); updates automatically if hours change |

---

## 10. What I need before Phase 1 starts
1. Approval of this spec and CURRENT_STATE.md (or edits).
2. Answers to any assumption above you want changed — especially A-1, A-4, A-5, A-9.
3. A new development database URL (the old one expired) and the first admin's email.
4. Confirmation that retiring the shared Basic-auth gate is acceptable (individual logins replace it).
