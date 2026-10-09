# Phase 1 — Notes

What was built, what I assumed, what I changed from the plan, and what you need
to verify by hand. Written 2026-10-09 on branch `scheduling-engine`.

**Nothing has been pushed or deployed.** All of this is committed locally.

---

## 1. Your ten scope items

| # | Item | Status | Where |
|---|---|---|---|
| 1 | Prisma migrations: users/roles, sessions, audit_log, encounter, integration config | ✅ applied to your database | `prisma/migrations/20261009120000_phase1_foundation` |
| 2 | Auth: email/password, multi-role, 15-min inactivity, TOTP for admin, server-side revocation | ✅ | `src/routes/auth.ts`, `src/lib/sessions.ts`, `src/middleware/session.ts` |
| 3 | Audit middleware + explicit calls on raw-SQL paths and on reads | ✅ — **but see §3.1: the raw-SQL premise needed adjusting** | `src/lib/audit*.ts`, `src/middleware/auditAccess.ts` |
| 4 | Delete `POST /admin/purge`; `scripts/dev-reset.ts` refusing in production | ✅ | `src/routes/admin.ts`, `scripts/dev-reset.ts` |
| 5 | Fix the five error handlers | ✅ | `src/lib/logger.ts` + the 5 call sites |
| 6 | `AiScribe`, `FileStorage`, `Messaging` interfaces with dev stubs | ✅ stubs only | `src/integrations/` |
| 7 | React + Vite shell: login, admin MFA enrolment, 5-module nav, 14-min idle warning | ✅ | `web/` |
| 8 | Refuse to start in production without DB TLS | ✅ (also: MFA key, https base URL) | `src/config.ts` |
| 9 | Seed the first admin from `ADMIN_EMAIL`, one-time link, never a password | ✅ | `scripts/seed-admin.ts` |
| 10 | README + this file | ✅ | `server/README.md` |

Also done, from your instructions: the shared token is replaced by per-user
accounts; the Basic-auth gate is retired behind a flag (`BASIC_AUTH_GATE`,
default **off**); the existing booking, availability, hold and locking code is
untouched (see §3.2 for the exact diff).

---

## 2. How it was verified

| Check | Result |
|---|---|
| Server test suite (`npm test`) | **67 pass** — unit, auth, access control, notes, audit, start-up guards |
| Staff-app unit tests (`web/`) | 5 pass (the 14 / 15-minute idle policy) |
| `npm run typecheck`, `lint:logs`, web typecheck, both production builds | clean |
| **Existing `scripts/race-test.sh`, unmodified** | **PASS** — 12 racing → exactly 1 winner, 11 clean 409s |
| Heavier races, same engine: 40 racing for one chamber; 30 for IV (4 chairs, 2 nurses); 60 interleaved between two services sharing 2 rooms + 2 NPs | all PASS — 1, 2 and 2 winners, nothing double-booked, **no deadlocks, no pool timeouts** |
| …repeated with the connection pool capped at **3** (a free-tier-sized pool) | all PASS |
| Production start-up guards, run against the compiled build | refuse for: no TLS · no MFA key · bad key length · non-https base URL; start when correct; never echo the connection string |
| Real browser walk-through | setup link → weak password refused → login → forced TOTP enrolment → recovery codes → idle expiry → redirected back to where you were headed → MFA → accounts page → audit log |
| Your real database afterwards | 10 migrations, **0** accounts / sessions / audit rows — all testing ran in throwaway schemas that were dropped |

**What I did *not* verify** — be aware of these:

- **The on-screen 14-minute warning dialog.** The policy is unit-tested and the
  server-side 15-minute expiry was exercised (I aged a session and watched the
  legacy page redirect to login with the idle notice). I did not sit through 14
  real minutes watching the countdown modal. → §5.
- **A real deployment to Render**, real TLS to a real database, or any cloud
  service. Nothing here talks to AWS or Twilio.
- **A real authenticator app.** I generated TOTP codes with the same library.
  Scan the QR with your phone once to confirm.
- Cross-browser behaviour (only the in-app Chromium pane), and accessibility.
- No independent security review of the auth code. It has been tested, not audited.

---

## 3. Where I departed from the instructions, and why

### 3.1 The raw-SQL audit calls — the premise didn't hold

You asked for explicit audit calls because the Prisma wrapper "will not see the
four hand-written raw SQL locking statements." I read all four first. Each is a
`SELECT id … FOR UPDATE` on `Resource` or `Staff`: it reads opaque ids from
tables that are neither PHI nor audited, and writes nothing. There is no PHI
activity in them to record.

The PHI writes **inside those same transactions** (`booking.create/update`,
`user.create`) go through the Prisma client and **are** captured, with the actor.

What the wrapper genuinely cannot see is an attempt **refused before any write**
— a 409 "slot taken", a 410 "hold expired" — because nothing reaches the
database. That is the real gap on those paths, so I closed it: `auditAccess()`
middleware is mounted from `index.ts` on the four routes (and the staff read
routes), recording refusals as `success=false`. Verified: the race test now
leaves exactly **1 `CREATE` and 11 refused attempts** in the audit log.

This is recorded in `SPEC.md` §6. If you still want something attached to the
lock statements themselves, that would mean editing the locking code, which you
told me not to touch — so I didn't.

### 3.2 "Booking code stays untouched" — exactly what changed

You also asked me to fix the five error handlers, three of which live in
`holds.ts` and `bookings.ts`. That necessarily touches those files. The entire
diff to them is **one import line and the log call** (`console.error('…', err)` →
`logger.error('…', err)`):

```
bookings.ts  +import { logger } …   2 log lines changed
holds.ts     +import { logger } …   1 log line changed
```

No logic, no query, and no locking statement changed in either file.

### 3.3 Audit entries are buffered, not written inline

An audit insert made from inside a Prisma transaction needs a *second* pooled
connection. Under the booking race, every connection can end up held by a
transaction waiting on a row lock held by one that is waiting for a connection.
I did not want to introduce that risk into the code you told me not to disturb,
so entries are collected per request and written in one insert **after the
response**. (This is reasoning about the failure mode, not something I measured
failing.)

**Cost:** if the process is killed in the milliseconds between a commit and that
flush, the audit row for that change is lost. For Phase 2+ endpoints that must be
atomic with their audit row, `auditInTx()` exists and writes in the same
transaction. Whether the small loss window is acceptable is a compliance call.

### 3.4 Smaller departures

- **`Encounter` table is in Phase 1** (as you listed), though the SPEC had it in
  Phase 2. Schema only; nothing uses it yet.
- **The per-service SOAP / session-log flag is *not* in this phase's migration.**
  It belongs with Phase 4's tables; the decision is recorded in SPEC.
- **Interface names** follow your message (`AiScribe`, `FileStorage`,
  `Messaging`), not the SPEC's. Real AWS/Twilio adapters do not exist;
  selecting anything but `stub` throws `NotConfiguredError`.
- **`render.yaml`**: `DATABASE_URL` is now `sync: false` instead of wired to the
  blueprint's database. Production refuses a non-TLS URL and Render's generated
  one doesn't include `sslmode=require`; and a blueprint sync would overwrite the
  value you set by hand. The old `databases:` block is **still in the file** —
  if you're using Supabase it will provision an unused database. Your call.
- **Scripts:** deleted `purge-demo-data.ts` (replaced by `dev-reset.ts`) and
  `notes-test.sh` (superseded by the test suite); ported `demo-day.sh` to a real
  login.
- **Patient search is now `POST /api/patients/search`.** The old
  `GET /api/patients?email=` put an email address in the URL — a violation of
  your no-PHI-in-URLs rule — so it was removed rather than left behind.

---

## 4. Behaviour changes you should know about

1. **Front desk can no longer read clinical note text** — only that notes exist
   and how many. (Your A-3 default, enforced.) Previously front desk read and
   wrote notes.
2. **Who can write a note:** only an account holding a provider role *and*
   linked to a provider record. An admin-only account cannot (A-4).
3. **A consequence to decide on:** the legacy dashboard is the only UI that can
   write a note until the Phase 4 provider module, and a provider-only login
   **cannot open the grid** (it would expose every patient). So in Phase 1 only a
   dual-role **Admin + Provider** account can write a note through the UI. The
   API is correct and enforces proven authorship either way. If providers need to
   write notes before Phase 4, say so and I'll give them a scoped view.
4. **Dashboard polling no longer keeps a session alive.** The grid refreshes
   itself every 30 s; counting that as activity would mean an unattended screen
   never times out. Only real input events (a ping) and non-GET requests slide
   the 15-minute clock.
5. Approving/declining/cancelling a booking now records *who* (in the audit log).

---

## 5. Verify by hand

1. **Create your first admin.** Add to `.env`: `ADMIN_EMAIL=<yours>` and
   `MFA_ENCRYPTION_KEY` (from `npm run gen-secrets`; **keep a copy** — losing it
   invalidates every authenticator). Then `npm run seed:admin`, open the printed
   link, set a password, sign in, scan the QR with a real authenticator app.
   *(Your message had the literal text `<ADMIN_EMAIL>` where the address should
   be. The script reads the env var, so I never needed it — and I did not invent
   one.)*
2. **Sit through the idle warning once.** Sign in, leave the tab untouched, and
   confirm the "Still there?" dialog appears at 14:00 and you're signed out at
   15:00. Do the same on `/dashboard.html`.
3. **Production env, before the first deploy:** `DATABASE_URL` ends
   `?sslmode=require`; `APP_BASE_URL` is the `https://` origin; `MFA_ENCRYPTION_KEY`
   is set. The app refuses to start otherwise — that is the intended behaviour.
4. **Restrict the runtime database role in production.** The audit table's
   trigger blocks `UPDATE` / `DELETE` / `TRUNCATE`, but not `DROP TABLE` by the
   table's owner. The role the app connects as should not own the schema.
5. Look at the new pages yourself: `/app/login`, `/app`, `/app/admin/accounts`,
   `/app/admin/audit`. I confirmed them in the browser pane, but you're the
   judge of whether they look right.
6. Read `src/lib/logger.ts` and `src/lib/auditExtension.ts` — the two files the
   PHI guarantees rest on.

---

## 6. Assumptions I made

- `trust proxy = 1` in production (one proxy hop, as on Render) so `req.ip` is the
  real client in the audit trail and rate limiter. Wrong if there are more hops.
- Sessions: 15 min idle, 12 h absolute, one active session per login not enforced.
- Lockout: 5 bad attempts → 15 minutes; plus 40 attempts / 15 min per IP.
- Setup links last 24 hours and are single-use; issuing a new one voids the old.
- Password policy: ≥12 chars, common-password list, not containing the email.
  No composition rules (per NIST 800-63B).
- Repeat **list** reads by one person within 5 minutes are logged once (a screen
  refreshing every 30 s would otherwise write ~2,900 rows/day). Single-record
  reads and patient searches are always logged.
- "At most one provider role per login" — two would need two provider records.
- `Account.email` is lower-cased; uniqueness is therefore case-insensitive.
- No self-service password reset: an admin issues a link. (No email is sent
  anywhere in Phase 1.)

## 7. Known limitations and open risks

- **Dependency advisories.** I patched the one rated **critical** (`proxy-addr`,
  IP spoofing — relevant because audit and rate limiting use `req.ip`) and a
  `body-parser` patch, both within Express's accepted range. **Five remain,
  pre-existing, not introduced here:** `express`/`qs` (moderate, request-parsing
  DoS) and `prisma` → `deepmerge-ts` (high, but CLI config-merging, not
  request-time). Fixing them means an Express and a Prisma upgrade — a separate,
  reviewed change.
- **No Content-Security-Policy header.** The legacy pages use inline styles; a
  strict CSP is worth adding once they're retired.
- **Login rate limiting is in-memory**, per instance. Fine for one instance;
  not shared across several.
- **The audit loss window** in §3.3.
- **Stubs write to local disk** (`server/.devdata/`, git-ignored). Nothing uses
  them yet, and the server logs a warning if a stub is active in production.
  This becomes a hard refusal in Phase 4, the first phase to send PHI through them.
- **Free-tier database.** A real patient record cannot live on a database that
  expires after 90 days. Production needs a paid plan with tested backups.
- **`membership.html` still shows the old tiers.** Scheduled for Phase 3, as you decided.

## 8. Bugs found and fixed along the way

Worth knowing because two of them were mine:

- **The seed crashed on any fresh database** — a bug I introduced in the earlier
  "assign services to people" change: it linked services to staff *before* the
  staff existed. It never showed because the seed only ever ran against an
  already-populated database. Worse, it wasn't transactional, so the crash left
  services committed and the "already configured" guard then treated the
  half-built database as finished. Because your production database must be
  re-created, the first deploy would have hit this. Fixed (staff first, one
  transaction) and verified on a clean schema.
- Two sign-in redirect bugs (the page you were headed to was dropped after the
  MFA step, and after a login with no steps).
- A successful login was attributed to "anonymous" in the audit log.
- An unreadable MFA secret (lost/rotated key) returned a generic 500; it now says
  what happened and how to recover.

---

## 9. What I need from you before Phase 2

1. **Review and approve this phase** — or tell me what to change.
2. **Provider access before Phase 4** (§4.3): do providers need a scoped view to
   write notes sooner?
3. **Your A-5 mapping, concretely.** You said SOAP for chiropractic, NP consult,
   IV therapy, injections and bloodwork; session log for HBOT and red light.
   Which of your 15 services is each? My guess: chiropractic = the 3 chiro
   services; "NP consult" = Functional Medicine Consult (and Hormone Optimization,
   Peptide Therapy, Supplementation, Wellness Planning?); injections = Vitamin
   Shots; bloodwork = Biomarker Testing; Body Composition = ? Needed for Phase 4,
   not 2.
4. **Phase 2 SMS:** do you want confirmation texts in Phase 2? If yes, a Twilio
   account and US carrier (A2P 10DLC) registration, which has lead time — start
   early.
5. **A database plan for production** (provider, paid tier, backups), and a
   decision on the leftover `databases:` block in `render.yaml`.
6. **The first admin's email**, and where you want `MFA_ENCRYPTION_KEY` kept.
