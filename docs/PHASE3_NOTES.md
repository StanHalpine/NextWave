# Phase 3 — Notes

What was built, what I assumed, what I changed from the plan, and what you need
to verify by hand. Written 2026-10-09 on branch `scheduling-engine`.

**Nothing has been pushed or deployed.** All of this is committed locally
(`e3fb8bb..HEAD`: 15 commits). Every commit typechecks on its own, server and web.
I did apply the three new migrations to your dev database (as in Phase 2); it still
holds only seed data.

Two things need a decision from you before anything ships: **member savings cannot be
applied at check-out** (§7) and **`membership.html` is on the wrong branch for the site** (§3.6).

---

## 1. Carried over from Phase 2 approval — all done

| Item | Status | Where |
|---|---|---|
| Record the two accepted departures in SPEC.md | ✅ | `SPEC.md` rev 1.3 |
| **Consent checkbox on the public widget**, unchecked by default, your exact words; store `consent_at` and the label shown | ✅ — stored as `Booking.smsConsentAt` / `smsConsentLabel` | `public/index.html`, `routes/smsPublic.ts` |
| **Inbound STOP** (consent off, confirmed once) and **HELP** (clinic phone); staff-recorded consent keeps working | ✅ — plus **START** and **C** (§3.5) | `routes/smsInbound.ts`, `lib/smsSuppression.ts` |
| Documentation types: Hormone Optimization, Peptide Therapy, Personal Wellness Planning, Supplementation → SOAP; Spinal X-Rays → session log | ✅ (10 SOAP in total) | migration `…_documentation_types_round_2`, seed |
| **Render Cron Job every 5 minutes** running `npm run jobs:run`; `migrate deploy` moved out of the build | ✅ — but see §3.1 (it changes the web plan) | `render.yaml` |
| **Text templates, your exact strings, in one place** | ✅ | `integrations/templates.ts` → `docs/SMS_TEMPLATES.md` |
| **DST tests for Nov 1 2026** (slots, the 24-hour reminder window, moves); fix anything exposed | ✅ — 19 tests; see below | `tests/dst.test.ts` |

**What the DST tests found.** The engine needed no change: it already does its day arithmetic on
calendar dates through luxon. They cover Saturday (CDT), the 25-hour Sunday and Monday (CST); a shift on
the long day; move-as-if on it; the first and last minute of the long day in the calendar and the
dashboard; moves across the change in both directions; walk-ins; the 08:00–21:00 sending window; and the
reminder window (Monday 07:00 CST → opens Sunday 07:00 but waits for 08:00; Sunday 08:00 CST → opens
**Saturday 09:00 CDT**, 24 *elapsed* hours, not 08:00). Sunday is closed, so the tests open it for their
duration. I temporarily broke two classic ways (a 24-hour "day"; a wall-clock reminder window) and
confirmed the tests fail on them.

The one real defect in this area came from your new wording, not the clock: **"see you tomorrow" would be
false** for an appointment that is *today* (the job down overnight; consent given late). The reminder is now
sent only when the appointment is tomorrow by the clinic's calendar, otherwise a `same_day` skip is recorded.

> **Update (Phase 5):** the `same_day` skip is gone. An appointment that is *today* now gets its own wording
> (`appt_reminder_today_v1`, "see you today at {time}"); see `docs/PHASE5_NOTES.md` §1.5.

---

## 2. Phase 3 scope

| # | Item | Status | Where |
|---|---|---|---|
| 1 | Tiers as **data**: Prevent / Restore / Optimize = 4 / 6 / 8 credits, 90-day rollover | ✅ — `MembershipPlan` rows; dues $99 / $199 / $299 | migration `…_phase3_credits_memberships`; Admin → Memberships |
| 2 | Credit ledger: append-only, one lot per monthly grant with expiry, FIFO, idempotent grant job in `jobs:run` | ✅ | `lib/credits.ts`, `lib/membership.ts`, `jobs/credits.ts` |
| 3 | Perks as entitlement counters per tier; structure + placeholders, list what I need | ✅ structure; **placeholders switched off** (§3.2, §9) | `PlanPerk`, `PlanPerkService`, `PerkUsage` |
| 4 | Credit Tracker tab: balance, lots with expiry, full history, admin manual adjust with reason (audited) | ✅ | `patients/CreditTracker.tsx`, `routes/credits.ts` |
| 5 | Check-out redeems credits for eligible services; balance before and after; non-members pay cash — price recorded, **no payment processing** | ✅ | `lib/checkout.ts`, `schedule/CheckoutDialog.tsx` |
| 6 | Price and credit cost per service on the admin services page | ✅ — a **Credits** field beside Price | `public/admin.js`, `routes/admin.ts` |
| 7 | `membership.html` to the new tiers | ✅ — **on `scheduling-engine`**, see §3.6 | `membership.html` |
| 8 | Every check-out writes a `revenue_event` row (service, price, member/cash, encounter id) | ✅ — table `RevenueEvent` | `lib/checkout.ts` |
| 9 | Tests, including the double-grant guard and FIFO expiry; existing race tests still pass | ✅ | §4 |
| 10 | This file | ✅ | |

The credit costs are your table: Chiropractic Adjustment 2, Red Light Bed 2, Hyperbaric 60 min 4, Hyperbaric
90 min 6, Vitamin Shot 2, IV Drip 6; every other service is cash-only until you give it a cost.

---

## 3. Where I departed from the instructions, and why

### 3.1 The web service moves to a paid Render plan
`preDeployCommand` (where `migrate deploy` now runs) is not available on Render's free plan, and a cron job
has no free plan. The web service also has to be awake to answer the provider's STOP/HELP webhook (a sleeping
free service takes ~30 s to wake). So `render.yaml` sets **both services to `0.5c-512mb`** (Render's entry paid
size). **That is a recurring cost you did not explicitly approve.** I checked the plan IDs and field names
against Render's published blueprint docs; I did **not** run the file through Render. Secrets cannot live in an
environment group (`sync: false` is not allowed there), so `DATABASE_URL`, `APP_BASE_URL`, `MFA_ENCRYPTION_KEY`
and `CLINIC_PHONE` must be entered on **both** services.

### 3.2 Perks are pre-filled from your tier copy, but switched off
You asked for placeholders. Your tier text already says what each tier includes, so rather than zeros I
pre-filled the counters from it and left them **inactive**: nothing offers a perk at check-out until you switch
it on (Admin → Memberships) — monthly vitamin shot (Prevent, Restore) or IV drip (Optimize); quarterly body
composition (all three); guest passes — **per quarter**, as your copy says (0 / 1 / 2). Flip them on once you
confirm. Details in §9.

### 3.3 `Charge` became `RevenueEvent`; no void, no member-savings discounts
You asked for a `revenue_event` row per check-out, which is the spec's `Charge` under another name, so I built
that and not both. The spec's **void** and **`PlanDiscount`** are not in your Phase 3 list and are **not built**.
A mistaken check-out is corrected by an admin credit adjustment; a revenue correction is a Phase 5 question.
Recorded in `SPEC.md` rev 1.4.

### 3.4 Check-out changed shape
Phase 2's check-out was a bare state change. It now **requires** `{ payment: CREDITS | PERK | CASH }` and settles
the visit in one transaction. No visit in your database has been checked out, so nothing is stranded; a visit
checked out under the old endpoint elsewhere would have no revenue event (the API says so rather than inventing one).

### 3.5 Things I added to the texting that you did not specify
- **"Reply C"** is in your confirmation text, so a reply of C has to *do* something. It marks the patient's
  next confirmed appointment as confirmed by them (shown in the appointment dialog) and answers
  *"NextWave Wellness: Thanks {first}, you're all set for {day} at {time}."*
- The **STOP**, **START**, **HELP** and **C** reply wordings are mine (`REPLIES` in `templates.ts`). They are
  in `docs/SMS_TEMPLATES.md` for the campaign form but **you have not approved them**.
- **START** lifts the do-not-text entry. It does not turn a patient's consent back on (STOP turned it off);
  staff re-record it. A booking's own checkbox consent is untouched, so its texts resume.
- A STOP applies to the **number**, not a person: every patient record with that number is switched off.

### 3.6 `membership.html` is a marketing-site file, committed to `scheduling-engine`
You said commit on `scheduling-engine`, so I did — as one isolated commit (`dc83cef`) touching only
`membership.html`, `assets/style.css` (two lines) and `CLAUDE.md`. But the site deploys from `main`, and your
standing note says marketing changes go there. **It needs cherry-picking to go live:**
`git cherry-pick dc83cef` on `main` (say the word and I'll do it, in a throwaway worktree, without touching this branch).
Copy changes I made to your text: the brand is written **NextWave** as on every other page (you wrote
"Nextwave"); "shown when you book" became "listed above" (the booking page does not show credit costs); the credits
table has **no price column** (yours has none); and the old "The math" blocks are replaced by your own
"Approximate monthly value" figures. I updated `CLAUDE.md`, which described the old dialogs.

### 3.7 The consent endpoint is separate from the booking route
You have said repeatedly that the booking code stays untouched. Storing the tick inside `POST /api/bookings` would
have meant editing it, so the widget makes a **second** request — `POST /api/bookings/:id/sms-consent` — after the
booking succeeds. It accepts only wording the server issued, only for a request/confirmed booking made in the
last 30 minutes, once, rate limited, and writes an audit row atomically. **Cost:** if that second request fails
(a network drop between the two), the booking exists without the consent and the patient sees "we couldn't save
your text preference". The failure mode is "no texts", never "texts without consent".

### 3.8 Smaller departures
- Ledger rows, perk uses and expiries carry the **application** clock, not the database's, so a pinned test clock
  and the lot arithmetic agree.
- The legacy admin Services card showed "Spinal &amp; Postural Exam" with a literal `&amp;` (escaped twice).
  Fixed in passing (one token), since I was editing that card.
- Applying the migrations to your dev database: the three new ones carry data (tiers, perk placeholders, credit
  costs, four SOAP flags) as well as tables.

---

## 4. How it was verified

| Check | Result |
|---|---|
| Server test suite (`npm test`) | **284 pass** (was 151): credit ledger 29 · membership/credits/admin API 24 · check-out 26 · text consent 13 · inbound STOP/HELP/C 17 · DST 19 · text job +4 · start-up guards +1 |
| …the whole suite again with the connection pool capped at **3** (`NW_TEST_POOL=3`) | 284 pass |
| Staff-app unit tests (`web/`) | 19 pass (was 16) |
| `npm run typecheck`, `lint:logs`, web typecheck, both production builds | clean |
| **Existing `scripts/race-test.sh`, unmodified**, and the heavier races (40 for one chamber; 30 for IV; 60 interleaved), at the default pool **and capped at 3** | all PASS; no deadlock or pool-timeout lines in the server log |
| Booking-engine diff since Phase 2 | `holds.ts`, `bookings.ts`, `availability.ts` (route and lib), `time.ts`: **0 lines changed** |
| **Double-grant guard** | the job run twice, and by **ten runners at once**, grants one lot; a direct second insert for the same month is refused by the database |
| **FIFO** | a redemption draws the oldest lot first and spills into the next; allocations are recorded; balance = `SUM(delta)` |
| **Expiry** | spendable through the last day, not after; a lapsed lot is never drawn from even before the job runs; the job writes one `EXPIRATION` row per lot, oldest first, and is idempotent |
| **Overdraw** | ten concurrent redemptions of 2 against 8 → exactly four succeed; seven check-outs racing for four visits' worth → exactly four; a redemption racing the expiry job never double-spends. With **no lock at all**, two transactions each taking 3 of 4 → one commit is refused by the deferred database trigger |
| **Check-out** | eight simultaneous submits → one revenue event and the credits taken once; a failed credit redemption leaves the visit checked in and nothing written |
| Sensitivity of the new race test | I removed the patient lock from check-out; the test failed (twice) — then restored it |
| Real browser walk-through (in-app Chromium, on a throwaway schema) | check-out with credits (balance 6 → 4, receipt); a non-member's cash path with credits disabled and the reason shown; Credit tracker with an expiring-soon warning, lots, history; the admin Memberships page; the admin manual-adjust card; the legacy Services card's Credits field; `membership.html` (the tier card and a tier dialog by eye; the credits table's two-column layout by inspecting the page) |
| Your real database afterwards | 14 migrations; **0** accounts / sessions / audit rows / patients / bookings / ledger rows; 3 tiers; 6 perk links, all inactive; 10 SOAP services; no scratch schemas |

**What I did *not* verify** — be aware of these:

- **The webhook signature against a real Twilio request.** I implemented Twilio's documented scheme (HMAC-SHA1 of
  the public URL plus the sorted form fields, base64) and my tests sign requests with **my own** implementation of
  it. That proves the code is self-consistent, not that it matches Twilio byte for byte. Test it with a real
  Twilio-signed request before relying on it.
- **Any real provider, a real TLS database, or Render itself** (§3.1).
- **The in-process job timer** (`JOBS_IN_PROCESS=true`), still not run — only `jobs:run`.
- **Credit tracker, check-out dialog and admin Memberships on a phone or tablet**, or by keyboard / screen reader.
  `membership.html` was looked at in a narrow pane only.
- **Volume.** A handful of patients. The history query computes a window sum per request.
- The Twilio **STOP/HELP replies may also come from Twilio itself**; if its own opt-out handling is on, a patient may
  get two replies (§9).

---

## 5. Behaviour changes you should know about

1. **Front desk must choose how a visit was paid** to check someone out. There is no "just check out" any more.
2. **A checked-out visit cannot be undone.** Corrections are an admin's credit adjustment.
3. **A cancelled member keeps credits already granted** until their last day (your A-11); a **paused** member keeps
   them too, but cannot use perks (perks need an active membership).
4. **An online booking whose box was ticked is now texted without anyone linking it to a patient.** Before, it
   needed a linked, consenting patient.
5. **Staff-recorded consent is now overridden by a newer STOP**, and a STOP turns off consent on every patient with
   that number.
6. The **Schedule's appointment dialog** shows where consent came from (patient profile / booking form) and
   "Replied C".

---

## 6. Assumptions I made

- **Enrolling grants a full month immediately** (no proration) and again on the same day each month, anchored on
  the start date (31 Jan → 28 Feb → 31 Mar). A job that was down makes up missed months, one lot each, up to 12 a run.
  **Resuming from a pause does not make up the gap.**
- A lot's **last usable day is inclusive**: a grant on 13 Oct is spendable through 11 Jan (13 Oct + 90 days).
- **Perks count in calendar months / quarters / years in clinic time**, not from the member's anniversary.
- **Cash price = the list price** (the chosen option's price if there is one, else the service's). The desk may
  enter an amount only when a service has *no* price (peptide therapy, vitamin-shot options). Any other amount is refused.
- For a member's visit the revenue event's `price` is the **list price** (what the visit is worth) with `cash due` = 0.
  A member who chooses to pay cash instead is recorded as **cash**, not as a member sale.
- **Credit cost is per service, not per option.**
- **Dues are collected outside this system** and are not recorded as revenue events (your "no payment processing").
- Re-enrolling after a cancellation grants a fresh month **immediately** (a new membership). Whether that should be
  allowed within the same month is a policy question; nothing here stops it.
- Credits are not "owned" by a membership: they belong to the patient and stay if the membership ends.
- Adjustment reasons are a fixed list (`correction`, `goodwill`, `opening_balance`, `lost_credits`, `other`), not
  free text — free text is where health information ends up in an audit trail.

---

## 7. Known limitations and open risks

> **Update (Phase 4):** the first bullet — member savings at check-out — is superseded: tiers now carry a discount
> percentage and every check-out records list price, discount and net (see `docs/PHASE4_NOTES.md` §1.1; the
> percentages start at 0% until you set them). The em-dash bullet no longer applies: the reminder wording changed
> and is plain GSM-7.
>
> **Update (Phase 5):** the discount is no longer one percentage per tier. It is a percentage **per tier per service
> category**, admin-editable, and **nothing is enabled** until you approve `docs/DISCOUNT_MAPPING.md`
> (`docs/PHASE5_NOTES.md` §1.2).

- **Member savings cannot be applied at check-out.** Your tiers promise 20% off X-rays, 20% off extra credits,
  10% / 15% / 20% off supplements, etc. Nothing applies them: the cash price must equal the list price, so the desk
  has **no way to record a discounted sale**. This is the spec's `PlanDiscount`, which was not in your list. It needs
  a decision (§9) before members are charged.
- **No void or refund**, **no payment processing**, and **no record of membership dues**.
- **Only three kinds of perk are counted.** Your copy also promises an annual biomarker assessment, a quarterly
  provider consultation, peptide & hormone access, and direct provider messaging; none is tracked.
- A **cash price cannot be entered for a service that already has one**, even for a legitimate one-off difference.
- Check-out for a visit with **no patient record** can only be cash.
- The credit-tracker history is ordered by ledger id (insertion order), which equals date order except for rows
  deliberately back-dated.
- **The reminder is Unicode.** The em dash in your reminder ("Reminder — {first}…") is not in the standard SMS
  alphabet, so the *whole message* is sent as Unicode: 70 characters per segment, so it is **2 segments every time**
  (the confirmation is 1, occasionally 2 with a long name). Replacing "—" with "-" makes it 1. I kept your string as given.
- **Verbal consent recorded by staff** is a legal question, not a technical one — worth your attorney's eye along with
  the checkbox wording.
- Dependency advisories: unchanged from Phase 1.

---

## 8. Bugs found and fixed along the way

- **"See you tomorrow" for a same-day appointment** (above) — found by reading the new wording against how the job works.
- **Ledger timestamps used the database clock** while the lot arithmetic used the application's; harmless in
  production, but a pinned test clock showed history dated in the wrong week. Everything now takes the application clock.
- **Two of my own tests were flaky or wrong**, caught by running them repeatedly: one chose a random slot but ran the job
  at a time unrelated to it; one expected a partly-used, then-expired lot to read "used". Both fixed.
- **A botched mutation test:** a failed backup left a deliberately broken `time.ts` in place for one run. I restored it
  from git and confirmed the tree had no source diff.
- Radio buttons stretched to full width (global input style); form fields with hints misaligned; the legacy admin `&amp;`.

---

## 9. What I need from you

1. **Review and approve this phase** — or tell me what to change.
2. **Member savings at check-out.** Build `PlanDiscount` (20% X-rays and extra credits, 10% special services and packages,
   10 / 15 / 20% supplements) so the desk can record them — or let the desk enter an override amount with a reason code
   — or leave discounts to be applied by hand off-system for now? Until you choose, members cannot be charged correctly.
3. **Perk mapping.** Confirm or correct, then I switch them on: monthly vitamin shot (Prevent, Restore) / IV drip
   (Optimize), **1 a month**; quarterly body composition, **1 a quarter**; guest passes **per quarter** — 0 / 1 / 2. Your
   message said "monthly entitlement counters"; your tier copy says guest passes are quarterly, so I followed the copy.
   Should the annual assessment, quarterly consultation, peptide & hormone access and provider messaging be tracked too?
4. **Credit costs.** Confirm the six I seeded from your table, and whether any service with options (vitamin shots,
   biomarker panels) should cost different credits per option.
5. **Policy:** can a member cancel and re-enrol the same month for a fresh grant? Anything on proration or forfeiture on
   cancellation (your A-11 says none)?
6. **`CLINIC_PHONE`** — the clinic's number, for the HELP reply. The app will not start in production with a real
   provider token and no phone.
7. **Approve the four reply wordings** (STOP, START, HELP, C) in `docs/SMS_TEMPLATES.md`, and decide on the em dash.
8. **Twilio:** point its inbound webhook at `https://<your APP_BASE_URL>/api/sms/inbound`, put the auth token in
   `TWILIO_AUTH_TOKEN` on both services, and decide whether Twilio's own STOP/HELP replies stay on (a patient may
   otherwise get two).
9. **Cherry-pick `dc83cef` (`membership.html`) onto `main`** — or tell me to — and note the marketing site has **no
   privacy policy page**, which carrier registration normally asks for.
10. **The paid Render plan** (§3.1): fine to proceed?
11. **Next:** Phase 4 (Provider + SOAP) as planned?
