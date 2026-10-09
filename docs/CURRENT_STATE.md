# NextWave Wellness — Current State Audit

Audited 2026-10-09 on branch `scheduling-engine` (HEAD `de55888`). The audit
itself was read-only. **Updated the same day after review** with the owner's
decisions (below) and the cleanup they approved; sections that changed are
marked *[updated]*.

**Decisions received**

| Question | Decision |
|---|---|
| ORM | **Keep Prisma.** Prisma Migrate for all new tables (no second migration tool). "No ORM" existed for RDS portability; Prisma on Postgres satisfies that. Existing locking statements and booking/availability code are not to be touched |
| Untracked patient-JWT work | **Discarded** — all four files deleted, three orphan tables dropped (§7) |
| Patient login | **Out of scope for all phases.** Staff roles only; the anonymous booking widget stays as-is |
| Credit tiers | Prevent / Restore / Optimize = **4 / 6 / 8** Wellness Credits, 90-day rollover; `membership.html` to be fixed in Phase 3 |
| Added to Phase 1 | Delete `POST /admin/purge`; fix the five raw-error log handlers; replace the shared token with per-user accounts |

**Scope.** Two things live in this repo:

1. `/` — the static marketing site (plain HTML/CSS/JS, own Render static
   service, deploys from `main`). Out of scope here except where it links to
   the booking app.
2. `/server` — the scheduling prototype this audit is about: Express +
   TypeScript + Prisma + PostgreSQL, serving three vanilla-JS pages.

---

## 1. Headline findings

1. **The prototype is a working booking + front-desk system, not a clinic
   system.** Availability, holds, bookings, approvals, clinical notes and the
   front desk grid all work in dev. There are no user accounts, no roles, no
   audit log, no credits, no messaging, no file storage, no AI, no accounting.
2. **Production is down.** `https://nextwave-scheduling.onrender.com/health`
   does not respond (consistent with the expired free Render Postgres).
3. **~~An uncommitted, non-compiling patient-auth/credits effort~~ was found and
   has been discarded** *[updated]*. Details and reasons in §7. Typecheck is
   now clean (0 errors, was 9) and `prisma migrate` no longer reports drift.
4. **The brief's stack rules conflicted with the repo in a few places** — the
   big one was Prisma vs. "plain SQL migrations, no ORM". *[updated]* Resolved:
   keep Prisma, use Prisma Migrate for all new tables (§8).
5. **None of the brief's HIPAA constraints are met yet.** No audit log, no
   PHI-safe logging, no refuse-to-start TLS check, hard deletes on clinical
   data (§9).
6. **The earlier membership-tier rewrite was never applied.**
   `membership.html` still shows the old 10/12-credit structure. See §10.

---

## 2. Stack as found

| Layer | Found | Notes |
|---|---|---|
| Runtime | Node 24, TypeScript 5.7, ESM | `tsx` in dev, `tsc` → `dist/` for prod |
| HTTP | Express 4.21, `cors`, `zod` validation | All routes under `/api` |
| DB | PostgreSQL 16 (local), Render Postgres (prod, expired) | |
| Data access | **Prisma 6** (client + Migrate) | 9 migrations; 4 raw-SQL `FOR UPDATE` locks |
| Time | Luxon, clinic zone `America/Chicago` | DST-safe; all wall-clock via one module |
| Front end | Vanilla JS/CSS, no bundler | `server/public/*.html` |
| Auth | Shared secret header + optional HTTP Basic gate | No users |
| Deploy | `render.yaml` blueprint (web service + free Postgres) | Build runs `prisma migrate deploy` + seed |
| Tests | `scripts/race-test.sh`, `notes-test.sh` only | No unit/integration test suite |

Dependencies: `@prisma/client`, `cors`, `dotenv`, `express`, `luxon`, `zod`.
Dev: `prisma`, `tsx`, `typescript`, type packages.

---

## 3. Schema (Prisma → Postgres)

Source of truth: `server/prisma/schema.prisma`. Native Postgres enums, UUID
string primary keys (client-generated; seeded IDs are UUID-*shaped* but not
valid hex, e.g. `re500u4c-…`, so do not validate them with `.uuid()`).

| Model | Purpose | Key fields |
|---|---|---|
| `User` | **Patient** (no separate patient table) | name, email, phone. No DOB/address/insurance. Placeholder "Pending guest" rows (email `''`) exist while a hold is in flight |
| `Staff` | Bookable provider **or** front desk person; *not* a login | name, role, `active` (soft delete) |
| `StaffSchedule` | Weekly shifts | dayOfWeek 1–7, `startTime`/`endTime` as `"HH:MM"` strings |
| `Resource` | Room/chair/chamber | name, type, maxCapacity, `active` |
| `Service` | Catalogue entry | slug, category, durationMin, bufferMin, color, priceCents, priceNote, newPatientSlug |
| `ServiceOption` | Priced variants (vitamin shots, lab panels) | label, priceCents |
| `ServiceRoom` | Service ↔ Resource (many-to-many) | composite PK |
| `ServiceStaff` | Service ↔ Staff, explicit per person, never inherited | composite PK |
| `Booking` | Appointment **and** hold | status, start/end, `holdExpiresAt`, resourceId, staffId?, subOption, patientNote |
| `VisitNote` | Clinical note, **amend-only** | bookingId, authorId (currently *claimed*), kind (SOAP + GENERAL), amendsId |

Enums: `StaffRole` (CHIROPRACTOR, NURSE_PRACTITIONER, REGISTERED_NURSE,
FRONT_DESK), `BookingStatus` (HOLD, PENDING_REVIEW, CONFIRMED, DECLINED,
CANCELLED), `NoteKind` (SUBJECTIVE, OBJECTIVE, ASSESSMENT, PLAN, GENERAL).

**Concurrency design (works, load-tested).** Double-booking is prevented by
`SELECT … FOR UPDATE` on the rooms a service can use and on the staff who can
perform it, always `ORDER BY id` so services sharing resources cannot
deadlock. 15 racing holds on one chamber → exactly 1 winner; 25 racing with 5
rooms/3 people → exactly 3. This is the most valuable thing in the repo and
the riskiest to rewrite.

**Migrations.** 9 files under `server/prisma/migrations`. Seed
(`prisma/seed.ts`) is guarded by a `Service` count check so deploys cannot
overwrite admin edits.

**Dev-DB drift (not in git).** `UserAuth`, `Membership`, `CreditLedger`
tables exist in the local dev database, all empty, with **no migration and no
entry in `schema.prisma`**. See §7.

Dev DB currently holds: 15 services, 7 staff, 15 resources, 0 patients, 0
bookings, 0 notes.

---

## 4. Routes

All mounted under `/api` in `src/index.ts`. "Token" = `x-front-desk-token`
shared secret. "Basic" = optional `DEMO_USER`/`DEMO_PASSWORD` gate (a no-op
when unset).

### Patient-facing (public; deliberately outside the Basic gate)
| Route | Purpose |
|---|---|
| `GET /config` | Booking mode / banner / coming-soon |
| `GET /services` | Catalogue + options + prices |
| `GET /availability`, `GET /availability/days` | Slots for a day; per-service bookable days |
| `POST /holds`, `GET /holds/:id`, `DELETE /holds/:id` | Take / resume / release a 10-minute hold. **The hold id doubles as the session token** |
| `POST /bookings` | Promote a hold to a PENDING_REVIEW request with contact details |
| `GET /bookings/:id` | Status of a request. Returns `patientNote` (free text) to anyone holding the UUID |

### Front desk (Token + Basic)
| Route | Purpose |
|---|---|
| `GET /front-desk/schedule` | Day grid: rooms, rostered staff, bookings (with resolved service color) |
| `GET /front-desk/pending` | Review queue |
| `GET /front-desk/staff` | Author picker for notes |
| `PATCH /bookings/:id` | Approve / decline / cancel |
| `POST /bookings/:id/notes`, `GET /bookings/:id/notes` | Clinical notes |
| `POST /visit-notes/:id/amend` | Amend a note (inserts a new row) |
| `GET /patients`, `GET /patients/:id/history` | Patient list / compiled record |

### Admin (Token + Basic)
`/admin/staff` (GET/POST/PATCH/DELETE), `/admin/staff/:id/shifts` (PUT),
`/admin/resources` (GET/POST/PATCH/DELETE), `/admin/services` (GET/PATCH:
duration, buffer, price, rooms, staff, color), `/admin/purge` (GET/POST).

### Previously present, now removed *[updated]*
The untracked patient `/register`, `/login`, `/refresh`, `/me`, `/:id/*`
routes were never mounted and have been discarded (§7).

---

## 5. Pages (`server/public/`)

| Page | Audience | State |
|---|---|---|
| `index.html` + `booking.js/css` | Public patients | Works. Deep-linked from 21 "Book now" buttons on the marketing site via `?service=<slug>[&option=<label>]`. Flow: day calendar → time → details → request. Step-aware Back, first-visit redirect to the Spinal & Postural Exam, hold countdown |
| `dashboard.html` + `dashboard.js/css` | Front desk | Works. Rooms ⇄ Employees toggle; blocks filled by service color, border/pattern by status; pending queue; detail dialog with notes |
| `admin.html` + `admin.js/css` | Admin | Works. Batched save bar. Per-service rooms, people, color; staff + shifts; rooms; destructive purge |

The marketing site (repo root) is separate and must keep working.

---

## 6. What works vs. what is broken or stubbed

**Works (verified in dev this session unless noted):**
- Availability engine: clinic hours, shifts, buffers, room capacity, per-service
  staff/room eligibility, DST-correct Central time
- Holds, expiry (self-healing by timestamp; sweeper is housekeeping only),
  promotion to booking, approval re-check of capacity
- Amend-only clinical notes with required author
- Admin configuration with soft-delete for staff/rooms
- Front desk grid in two views; service/status visual encoding
- Nothing in the app is exercised by an automated test suite

**Broken:**
- Production deployment is unreachable; its free Postgres has expired
- ~~`npm run typecheck` fails with 9 errors~~ *[updated]* — those errors were
  all in the discarded untracked files; typecheck now passes with 0 errors

**Stubbed / not built:**
- Staff and patient accounts in the committed code (shared token only)
- Roles and permissions, session idle timeout
- Audit logging of any kind
- Credits, memberships, ledger, monthly job
- Confirmation/reminder messaging (Twilio or otherwise)
- File storage, audio, speech-to-text, SOAP generation
- Cancel/reschedule by patient, recurring appointments (`isRecurring` is stored
  and never acted on), provider time-off, payments, accounting, reports
- Clinic hours are hard-coded in `config.ts`
- `render.yaml`'s seed comment is stale (describes upsert-only; the seed now
  also skips when services exist)

---

## 7. The uncommitted patient-auth / credits work — **discarded** *[updated]*

Four untracked files plus three out-of-band database tables, apparently from
another session, were found during the audit. **On the owner's instruction
they were deleted and the tables dropped on 2026-10-09.** Nothing was built on
them.

| Item | Why it was not worth keeping |
|---|---|
| `src/lib/jwt.ts` | Fell back to the literal secret `'dev-secret-change-in-production'` when `JWT_SECRET` was unset — a production deploy would have silently signed tokens with a publicly guessable key. `JWT_SECRET` was absent from `.env.example` |
| `src/routes/auth.ts` | Patient register/login. Fixed 15-minute JWT plus a **7-day refresh token with no server-side record**: cannot be revoked and cannot implement "15 minutes of *inactivity*". Logged raw `err` objects |
| `src/routes/patients.ts` | Credit quotas hardcoded to the *old* tiers (0 / 10 / 12) — wrong against the 4 / 6 / 8 rules. Balance read from a snapshot column instead of a ledger. Firebase push endpoint contradicted "Twilio for SMS/voice only" |
| `src/middleware/requirePatient.ts` | Patient bearer-token middleware; patient login is out of scope for all phases |
| Package use | Imported `jsonwebtoken` and `bcryptjs`, **neither declared in `package.json`** — a clean `npm ci` would have broken the build |
| `UserAuth`, `Membership`, `CreditLedger` tables | Existed only in the dev database; no migration, not in `schema.prisma`; made `prisma migrate dev` refuse to run (drift) and offer a full database reset |

**What was done, and how to undo it**
- Before deleting, the tables were confirmed to hold **0 rows** each, and the
  four files plus the tables' DDL were copied to the session scratchpad
  (`…/scratchpad/discarded-auth-work/`). That scratchpad is temporary, not part
  of the repo.
- Stale compiled copies in `server/dist/` (git-ignored build output) were
  removed with them.
- Result: `git status` shows only `docs/`; `npx prisma migrate status` reports
  *"Database schema is up to date"*; `npm run typecheck` reports 0 errors.
- Credits and memberships will be rebuilt in Phase 3 as an append-only ledger
  with lot-based 90-day expiry (SPEC §4.3), not a balance snapshot.

---

## 8. Conflicts with the stack rules in the brief

| Rule | Repo today | Severity |
|---|---|---|
| Plain SQL migrations (node-pg-migrate/Knex), **no ORM** | Prisma Client + Prisma Migrate throughout; 103 model calls plus 4 hand-written `FOR UPDATE` locking statements | **Resolved *[updated]*:** keep Prisma; Prisma Migrate for all new tables (custom SQL such as triggers lives inside Prisma migration files). Portable to Supabase/Render/RDS as standard Postgres |
| Keep existing framework | Express | Compatible |
| Roles: front_desk, provider_chiro, provider_np, provider_nurse, admin | No login roles. `StaffRole` is a job category that maps ~1:1 to three of them, and deliberately is *not* a login | Gap (build) |
| Sessions expire after 15 min inactivity | None (the shared token never expires) | Gap (build, Phase 1) |
| Audit log on every CRUD of patient/appointment/soap_note/credit_ledger | None, including reads | Gap (build) |
| No PHI in logs, errors, URLs, query strings | See §9 | **Violation** |
| Secrets via env; commit `.env.example` | Mostly. `.env.example` exists and `.env` is git-ignored, but it omits `DEMO_USER` and `DEMO_PASSWORD` (the discarded JWT code's hard-coded fallback secret is gone) | Partial |
| Refuse to start in production without DB SSL | Not implemented (`config.ts` only requires `DATABASE_URL` to exist) | Gap (build) |
| Soft-delete only on clinical records | `POST /admin/purge` hard-deletes every `VisitNote`, `Booking` and `User`; the sweeper and `DELETE /holds/:id` hard-delete HOLD rows. Staff and rooms are soft-deleted correctly | **Violation** (purge); holds are arguably non-clinical |
| AWS Bedrock / Transcribe / S3 / Twilio behind interfaces with dev stubs | None exist | Gap (build) |
| Twilio for SMS/voice only | ~~Firebase push endpoint~~ — discarded with the untracked code | Resolved |
| Internal credits ledger + monthly job | Nothing built (the untracked version was discarded) | Gap (build, Phase 3) |

---

## 9. HIPAA constraint audit

| Constraint | Status |
|---|---|
| Opaque IDs only in logs | **Fails.** 5 handlers (`index.ts` sweep, `notes`, `bookings` ×2, `holds`) do `console.error('…', err)` with the raw error object. Prisma validation errors serialise the *entire query arguments* — I watched one print a full request body during this session. A failed patient insert would write name/email/phone to the log |
| No PHI in URLs/query strings | Mostly OK: ids are opaque UUIDs; no names in paths. But `GET /bookings/:id` and `GET /holds/:id` are *capability URLs* — anyone holding the id can read the booking (incl. free-text `patientNote`) |
| Audit row on every CRUD of patient / appointment / soap_note / credit_ledger | **None exist.** No `audit_log` table; reads are unlogged |
| Secrets in env | Largely; see §8 |
| TLS/SSL refuse-to-start | Not implemented |
| Soft delete only on clinical records | **Fails** via `/admin/purge` |
| Per-person attribution | **Fails.** `VisitNote.authorId` is taken from the request body; anyone with the one shared token can write as any provider. Booking approvals record no actor at all |
| Staff credential storage | Front desk token and admin token live in browser `localStorage` (readable by any XSS). `GOING-LIVE.md` A1 already recommends httpOnly-cookie sessions with Argon2id, which the SPEC adopts |

Whether the practice is legally a HIPAA covered entity is still unanswered
(`GOING-LIVE.md` §0); the brief treats the controls as mandatory regardless.

---

## 10. Membership-tier rewrite — still outstanding

The membership-tier rewrite you supplied earlier in this session (Prevent $99 /
Restore $199 / Optimize $299; 4 / 6 / 8 Wellness Credits per month; 90-day
rollover; credit costs per service) **was not applied**. `membership.html`
still carries the previous structure (10/12-credit figures, no "Wellness
Credits" wording). My reply to that message did not do the work and should not
have been left looking complete.

*[updated]* Decision: **fix `membership.html` in Phase 3**, alongside the
credit ledger it describes. The 4 / 6 / 8 numbers are already the ledger's
rules in the SPEC.

---

## 11. Recommendations — outcome *[updated]*

| # | Recommendation | Outcome |
|---|---|---|
| 1 | Keep the availability/locking engine as-is | **Adopted**, and made a standing rule: not to be modified |
| 2 | Resolve Prisma vs plain SQL | **Decided:** keep Prisma, Prisma Migrate for new tables |
| 3 | Discard the untracked patient-JWT auth | **Done** (§7). Staff accounts with server-side sessions replace it in Phase 1 |
| 4 | Reconcile the dev DB | **Done:** three orphan tables dropped; no drift |
| 5 | Fix the PHI-in-logs violation first | **Scheduled** for Phase 1 with the other two audit-driven fixes (delete purge endpoint; per-user accounts) |

## 12. Where this leads

See `docs/SPEC.md` for the page list, schema, API, and five-phase plan. Open
assumptions awaiting your confirmation are listed in SPEC §9.
