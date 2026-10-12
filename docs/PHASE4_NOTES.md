# Phase 4 — Notes

What was built, what I assumed, what I changed from the plan, and what you need to verify by hand.
Written 2026-10-10 on branch `scheduling-engine`.

**Nothing has been pushed or deployed.** The booking-app work is committed locally
(`d216583..HEAD`: 8 commits on `scheduling-engine`, each typechecked before it was committed).
The marketing-site work is on a **separate branch off `main`**, `site/privacy-and-sms-terms` (§1.6).
I applied the two new migrations (`…_member_discount`, `…_phase4_provider_documentation`) to your dev
database, as in earlier phases; it still holds seed data only (no bookings, patients or accounts).

Four things need a decision from you before anything ships:
**the clinic's phone number and street address** (`contact.html` has neither, so the legal pages carry
highlighted placeholders — §1.6), **the tier discount percentages** (§1.1 — every tier starts at 0%),
**who may amend a signed note** (§7.1), and **how long audio is kept** (§7.3).

> **Update (Phase 5):** all four are decided and built — see `docs/PHASE5_NOTES.md` §1. The phone and address are
> `(308) 830-1951` and 110 S. 243rd St., Waterloo, NE 68069; discounts are per tier per service category (enabled later
> the same day at Prevent 10% · Restore 15% · Optimize 20%: `docs/DISCOUNT_MAPPING.md`); only the signer can amend and others add addenda; audio is deleted 30
> days after signing.

---

## 1. Carried over from Phase 3 approval

| # | Item | Status | Where |
|---|---|---|---|
| 1 | Member discounts: `discountPercent` per tier; applied at check-out to cash-priced services for **active** members; `RevenueEvent` records list price, discount amount and net price as **separate columns**; admin edits the percentage | ✅ built — **but all three tiers are seeded at 0%** (§1.1) | `lib/pricing.ts`, `lib/checkout.ts`, Admin → Memberships |
| 2 | Cherry-pick `dc83cef` (`membership.html`) onto `main`; merge nothing else | ✅ on **local** `main` as `b86a432`, not pushed (§1.2) | `main` |
| 3 | Render paid plans (web service and cron job) | ✅ approved and recorded; the plan was already the entry paid size (§1.3) | `render.yaml` |
| 4 | "Verify the Twilio signature with a real inbound message" in a new `docs/STAGING_CHECKLIST.md`; don't block on it | ✅ — plus the other things the tests cannot prove | `docs/STAGING_CHECKLIST.md` |
| 5 | New reminder wording; keep the same-day variant; regenerate `SMS_TEMPLATES.md` | ✅ reminder; **there was no same-day variant to keep** (§1.4) | `integrations/templates.ts` |
| 6 | `CLINIC_PHONE` from `contact.html`, env var override kept | ⚠ mechanism built; **`contact.html` has no phone number** (§1.5) | `clinicContact.ts`, `config.ts` |
| 7 | Perk quantities per tier — or leave counters off | ✅ left **off** (your placeholder was unfilled) | — |
| 8 | The four reply wordings, exactly | ✅ | `integrations/templates.ts` |
| 9 | Marketing site: `privacy.html`, `sms-terms.html`, footer links on every page, `sms-opt-in.png` (1200×600) + `sms-opt-in.html` | ✅ on its own branch; **placeholders for phone and address** (§1.6) | branch `site/privacy-and-sms-terms` |

### 1.1 Discounts — what I built, and what I did not guess
Your message said `Tier mapping: [FILL IN — e.g. Prevent 10%, Restore 10%, Optimize 20%]`. The placeholder was
unfilled, and the example does not match your published page (supplements 10 / 15 / 20% by tier; X-rays, extra
credits 20%; special services and packages 10%), so I did not pick numbers: **every tier starts at 0%** and the
admin sets them on Admin → Memberships. Until then members pay list price in cash. Two consequences to be aware of:

- **One percentage per tier is a simplification** of your copy, which has different discounts for different
  things. If you want 20% off X-rays but 10% off supplements for the same tier, that needs a per-service (or
  per-category) discount, not one number per tier. Tell me which you want.
- **I read "cash-priced (non-credit) services" as "paid in cash"**: an active member who pays cash for *any*
  service, including one that costs credits, gets the tier's discount. If you meant only services with no credit
  cost, it is a one-line change.

How it works: whole cents, halves round **up** (15% of $19.99 = $3.00); credits and perks are never discounted;
a paused member, a non-member and a visit with no patient record pay list; for a service with no set price
(peptide therapy) the amount typed is the **list** price and the discount comes off it. The desk sees
list − discount = net before confirming, and the server **refuses** the check-out if its own figure differs from
the one the desk saw (`price_changed`) — so an admin editing a percentage mid-checkout cannot silently change a
price. `RevenueEvent` columns: `listPriceCents`, `discountPercent`, `discountCents`, `netPriceCents` (the old
`priceCents` and `cashDueCents` were renamed — same values, no row rewritten) with a database CHECK that
`net = list − discount` for cash and zero discount / zero money for a member visit. The tier code is now recorded
on any active member's event, including a cash one.

> **Update (Phase 5):** the first bullet above is superseded. A discount is now a percentage **per tier per service
> category** (`DiscountCategory`, `PlanCategoryDiscount`); `MembershipPlan.discountPercent` is gone. None is enabled.
> The second bullet stands: it applies to cash paid by an active member, for any service. See `docs/PHASE5_NOTES.md` §1.2.

### 1.2 `membership.html` on `main`
Cherry-picked as `b86a432`. It **conflicted**: `main` already had an unpushed local commit, `ce91802`
("Update membership tiers…", 11 Aug), that rewrote the same tier cards. You said the owner's copy is the one to
publish, so I took `dc83cef`'s version of the file whole; the result is identical to it. Nothing else from
`scheduling-engine` is on `main`. **Two things to know before you push `main`:** it is **2 commits ahead of
`origin/main`** (`ce91802` as well as the cherry-pick). `main` also carries about two dozen marketing commits
(photos, layout) that `scheduling-engine` does not have — I merged nothing in either direction.

### 1.3 Render
`render.yaml` already used `0.5c-512mb`, which is Render's entry paid size (what the dashboard calls Starter).
Render's current blueprint spec does not accept the word `starter` for either service type, so I kept the size
name and recorded your approval in the comments. I checked this against Render's published docs, not against Render.

### 1.4 The reminder, and the "same-day variant"
`appt_reminder_24h_v3`: *"NextWave Wellness: Reminder for {first}: see you tomorrow at {time}. Reply STOP to opt
out."* It has no em dash, so it is **plain GSM-7, one segment** (the Phase 3 note about it costing two segments no
longer applies). The four replies are your exact wording (`reply_*_v2`); the **C** reply now carries only the first
name. Template ids moved to v3 / v2 because the text changed.

**There is no same-day variant, and I did not invent one.** What I built in Phase 3 was a *skip*: a reminder for an
appointment that is today is not sent (it would say "tomorrow"), and a `same_day` skip is recorded. If you want
those patients to get a reminder, here is wording in your punctuation style — **not enabled, and it would need
adding to the A2P campaign** — *"NextWave Wellness: Reminder for {first}: see you today at {time}. Reply STOP to opt
out."*

> **Update (Phase 5):** the same-day variant now exists: `appt_reminder_today_v1` ("Reminder for {first}: see you today at
> {time}. Reply STOP to opt out."), used when the appointment is today. The `same_day` skip described here is gone.

### 1.5 `CLINIC_PHONE`
`contact.html` publishes three email addresses and "Address to be confirmed" — **no phone number**. The server does
not read the HTML at run time (the deployed service is built from `server/` alone), so the published number is
copied into `src/clinicContact.ts` and a **test fails if the two disagree**, in either direction (a number added to
the page with no copy here, or a copy the page no longer shows). That copy is empty today. `CLINIC_PHONE` still
overrides it, and the app still refuses to start in production with a real Twilio token and no phone.

> **Update (Phase 5):** `CLINIC_PHONE` now defaults to `(308) 830-1951` (the env var still overrides) and the sender to
> `+18665241007` (`TWILIO_FROM_NUMBER`); `contact.html` carries the same and a test keeps them level.

### 1.6 The marketing site — separate branch, one decision from you
Branch `site/privacy-and-sms-terms`, **off `main`**, two commits on top of the cherry-pick:
`privacy.html` and `sms-terms.html` (the site's own banner / horizon / learn-more pattern, head, nav and footer
copied from `contact.html`); **Privacy** and **SMS Terms** links in the footer of **all 19 existing pages**
(added by script and counted per file: 19 of 19, `../` prefix on the 14 service pages); and `assets/img/sms-opt-in.png`
(exactly 1200×600) with its source `assets/img/sms-opt-in.html` (the render command is in the file's top comment).
`CLAUDE.md` documents all of it.

- **The phone number and street address are missing** from `contact.html`, so both pages show highlighted
  `[clinic phone number]` / `[street address]` placeholders (`grep -rn data-fill *.html`). **Do not publish
  until they are replaced** — the SMS terms need the HELP number.
- The image is a picture of the booking page's consent card; I also changed the **real widget** (on
  `scheduling-engine`) to match it — a card titled "Appointment notifications", the checkbox with the stored wording
  **unchanged**, and a line linking the SMS terms and privacy policy — so the image cannot show something patients
  do not see. A test checks the card's structure; I checked the label in the HTML against `SMS_CONSENT_LABEL`
  character for character.
- **I drafted both legal pages from what the system actually does, and I am not a lawyer.** Have counsel read
  them (and the HIPAA Notice of Privacy Practices reference, which assumes you have such a notice). The effective
  date is `October 10, 2026`, set by hand — change it when you publish. The privacy policy contains one sentence
  that audio is recorded only with the patient's permission; it also names Web3Forms, Adobe Fonts and Google Fonts
  because the site's pages call them.
- To publish: push `main` (which deploys the membership page and the two unpushed commits, §1.2), then merge the
  site branch's PR. I pushed nothing.

---

> **Update (Phase 5):** the placeholders are filled and the legal pages are published on `main` (pushed); Twilio verification
> has been submitted.

## 2. Phase 4 scope

| # | Item | Status | Where |
|---|---|---|---|
| 1 | Provider queue: checked-in patients filtered by the signed-in user's provider role; multi-role users can switch; pending documentation per encounter | ✅ | `lib/providerViews.ts`, `pages/Provider.tsx` |
| 2 | Documentation workspace opens from the queue: SOAP editor on the existing amend-only model (semantics unchanged); session-log short form (duration, provider, notes) | ✅ | `lib/documentation.ts`, `pages/Documentation.tsx` |
| 3 | Method A: per-provider macros per section, one click; admin-defined shared sets | ✅ | `routes/macros.ts`, `pages/AdminMacros.tsx` |
| 4 | Method B: browser records, uploads through `FileStorage`, `AiScribe` returns transcript + draft SOAP; provider must review and edit; never auto-signed; audio and transcript **references** stored, never logged; canned stub | ✅ | `lib/scribe.ts`, `provider/ScribePanel.tsx` |
| 5 | Signing records user, role, timestamp; amendments after signing follow the existing model | ✅ | `NoteSignature`, `routes/notes.ts` (amend, unchanged) |
| 6 | Front desk sees that documentation exists and is signed, never its text; admin reads, does not write | ✅ | `lib/appointmentView.ts`, `middleware/clinical.ts` |
| 7 | MFA: TOTP enrolment required for provider roles before they can open the workspace | ✅ — enforced twice (§3.3) | `config.ts`, `middleware/clinical.ts` |
| 8 | Audit every read and write of clinical notes, audio and transcripts | ✅ (§3.10 closes one gap) | §4 |
| 9 | Tests: role filtering, signing, amendment, scribe flow with the stub, MFA gating; existing race tests still pass | ✅ | §4 |
| 10 | This file, with the AWS resources and variables the real adapters need | ✅ | §6 |

---

## 3. Where I departed from the plan, and what I decided

### 3.1 Two stores instead of changing the note model
The spec (§4.4) planned `SoapNote` + `SoapNoteRevision` tables and read-only legacy note endpoints. You told me to
build on the existing amend-only `VisitNote` **without changing its amendment semantics**, so I did not touch it:

- **`DocumentationDraft`** is a mutable scratchpad (one per visit, optimistic `version`). Nothing in it is a
  clinical record, so editing it never touches the amendment chain, and autosave does not write an "amendment"
  every few seconds.
- **Signing** copies the draft into ordinary `VisitNote` rows (S, O, A, P — or one GENERAL note for a session log),
  writes the append-only **`NoteSignature`**, deletes the draft and marks the visit `SEEN`, in one transaction under
  the Booking row lock (the same lock order the check-out uses: Booking first, nothing else).
- After that, the only change is the existing `POST /api/visit-notes/:id/amend`: a new row pointing at the old one,
  reason required, original kept. I added one **additive** thing to it: `VisitNote.durationMin`, carried through an
  amendment (or corrected by one), so a session log's duration is covered by the same model.
- **The database now enforces it**: UPDATE, DELETE and TRUNCATE are rejected on `VisitNote` and `NoteSignature`.
  This was already true in the application (no endpoint edited a note); a signed record should not rest on that
  alone. `dev:reset` switches the triggers off for its one transaction, as it already did for the ledger.

### 3.2 Who may do what
- **Front desk**: no clinical routes at all (403, recorded). On appointments they get
  `documentation: { status: NONE | DRAFT | SIGNED, signedAt }` and nothing else.
- **Provider**: may *read* any visit's documentation (as the existing history route already allows) and *write*
  only visits booked with **their own role** (chiropractor / NP / nurse ↔ the booked staff member's role). A visit
  with **no provider assigned** (a room-only service) can be documented by any provider role — otherwise it would be
  invisible to everyone. Signing needs the account linked to an **active** provider record, as the old routes did.
- **Admin**: read only (`read_only`). An admin who also holds a provider role writes **as that role** and the
  signature says so.
- A provider holds **at most one provider role** per login today (SPEC A-4). The role switcher and the `role` field
  on writes handle several, but that path is not exercised by any account that can exist; the working multi-role
  case is **provider + admin**, which is tested.

### 3.3 MFA — enforced twice
`MFA_REQUIRED_ROLES` defaults to `ADMIN` + the three provider roles (the "Phase 4 gate" the old comment promised),
so a provider with no authenticator is sent to enrol at sign-in. **And** every clinical route checks the
authenticator itself — enrolled, and used in this session — whatever that variable says. A test switches the policy
off and shows the clinical routes still refuse (`mfa_enrollment_required`).

### 3.4 Patient consent to recording — an addition
You didn't list it; the schema already had `Encounter.scribeConsentAt`, and recording a clinic visit needs consent,
so **no audio can start until the provider confirms the patient agreed**, recorded (and audited) on the encounter.
The UI is a checkbox before "Start recording". The server enforces it, so a client that skips it gets
`consent_required`.

### 3.5 "Provider must review and edit before signing"
Enforced as far as software can: a draft that began as an AI draft **cannot be signed unless the sign request
carries `reviewedAiDraft: true`** (the sign dialog's checkbox: "I have read all of it, corrected what needed
correcting, and it is accurate"); the draft is never inserted into the note on its own; the editor shows a banner
until signed; and the signature records `aiAssisted` and **whether the provider changed anything**
(`aiDraftUnchanged`). The stub's text is marked `[DEMO DRAFT]` and **signing refuses any note that still contains
it**, so demonstration text can never become a record. **I did not forbid signing an AI draft exactly as written**
— that would just force a pointless edit — but it is recorded; §9 asks if you want it blocked.

### 3.6 The scribe is off in production while a stub backs it
The Phase 1 comment said stub integrations in production "become a refusal in Phase 4". Refusing to *start* would
break your Render staging (which runs with `NODE_ENV=production`). Instead: while `FileStorage` or `AiScribe` is a
stub, **the scribe is switched off in production** (`503 scribe_unavailable`, and the workspace says why), and the
rest of documentation works. `ALLOW_STUB_INTEGRATIONS=true` lifts that for a **staging deployment holding only fake
patients**. Real patient audio can therefore never land on the server's own unencrypted disk.

### 3.7 A recording keeps you signed in
The 15-minute inactivity rule is about a person walking away. A provider talking to a patient for 20 minutes touches
nothing, so the screen would sign them out mid-visit and the upload would fail. While a recording runs the page
tells the server it is active every minute (spec risk R-4 planned this). The absolute 12-hour limit still applies.
It means an unattended screen that is *recording* will not time out — a trade-off you may want to weigh (§9).

### 3.8 Nothing an adapter says is logged
The logger's generic redactor scrubs emails, numbers and quoted strings — **not names**. A test that made a fake
adapter throw "…patient Ingrid Holloway…" showed that message reaching the log. So the scribe logs **only the
error's class, the stage and the session id**, never the message (real Transcribe / Bedrock errors can quote their
input). Audio, transcript and draft text, and their storage keys, appear in no log line; a test scans the output of
the whole flow.

### 3.9 Smaller decisions
- **Draft deleted on signing**: the record is the VisitNote rows; two copies of PHI that could diverge help no one.
  The AI's original draft stays on the `ScribeSession` (until the recording is discarded) so a signed note can be
  compared with its starting point.
- **Queue**: today's checked-in patients (waiting / with provider / seen / checked out) sorted longest-waiting
  first, plus earlier visits **still unsigned in the last 30 days**, apart. "Only mine" is a client-side filter.
  It refreshes every 30 s (GETs do not count as activity, so it cannot keep an idle session alive).
- **Macros**: one-click insertion at the cursor by section (your wording), not typed triggers. A personal set per
  provider; shared sets visible to all provider roles or only the roles listed; 200 per set; 4,000 characters.
  The screen warns not to put patient details in one — nothing can enforce that.
- **Scribe processing runs in the web process**, in the background of the request that queued it; the browser polls.
  A session stuck mid-processing for 15 minutes (a restart) is reported failed (`timed_out`) and can be retried;
  each stage is skipped if its output already exists, and a stage is claimed by compare-and-set so two retries
  cannot both run it.
- **Discarding a recording** deletes the audio, transcript and draft text from storage and the row, keeps a
  `DISCARDED` marker, and is refused once its draft is part of the note.

### 3.10 A gap I found in the existing audit
`GET /api/patients/:id/history` returns clinical note text but was audited only as a read of the *contact record*.
It now also writes a `visit_note` read. (The `Prisma` extension already audits note *writes*.)

---

## 4. Tests

**425 server tests** (up from 284), **43 web tests** (up from 19), all passing at the default pool size **and**
with the pool capped at 3 (`NW_TEST_POOL=3`, where a lock-ordering mistake shows). The existing race tests
(`walkin-race`, the hold and booking races) pass unmodified at both. The files that hold the booking engine —
`holds.ts`, `bookings.ts`, both `availability` files, `time.ts`, `scheduling.ts` — have **no diff** from before this phase.

| File | Tests | Covers |
|---|---|---|
| `provider-queue.test.ts` | 19 | role filtering for all three roles + unassigned visits; who is in the queue (state, status, day); longest-waiting first; documentation status per row; the unsigned backlog; role switching (provider, admin, provider + admin, provider + front desk); the audit row; what the front desk sees (status only, no text) |
| `documentation.test.ts` | 41 | access (anon / front desk / admin read-only / wrong role / unassigned / unlinked account); **MFA gating** (switching the policy off, enrolling mid-session, the middleware itself); draft versioning, shape and validation; **signing** SOAP and session log (attribution, role used, SEEN, draft removed, incomplete, stale, once only, late documentation, demo text); **amendment** after signing (the existing rules, history, duration carry and correction); the database refusing edits; **races** (three simultaneous signs; save-while-signing; two tabs saving); the workspace read; audit rows with no text |
| `scribe.test.ts` | 35 | consent gate; record → upload (no cookie) → transcribe → draft → **nothing signed**; transcript and draft reads audited; fill-empty / replace-all; **never signed without review**; failure → category only, retry, partial retry; stuck sessions; discard; the signed upload URL (tamper, wrong key, expiry, wrong type, one upload); production + stub gating; **no content in logs** |
| `macros.test.ts` | 18 | personal and shared sets, role scoping, privacy between providers, validation, limits, audit, database constraints |
| `checkout.test.ts`, `unit.test.ts`, `texts.test.ts`, `sms-*.test.ts`, `contact-page.test.ts` | updated / new | the discount (rounding table, every member state, `price_changed`, replay, admin edits); the new reminder and replies; the phone-number guard; the new MFA policy |
| `web/src/provider/docs.test.ts` (+ the discount cases in `lib.test.ts`) | 13 (+11) | what blocks signing; minutes parsing; macro insertion at the cursor; note order; role names; recording clock and format |

**Mutation checks.** I broke each of these on purpose and confirmed a test fails (then restored from git):
queue ignores the role · any provider role may write · MFA gate open · admin may write · AI draft signable without
review · demo text signable · sign without the Booking lock · stale draft version ignored · incomplete SOAP signable ·
scribe without consent · transcript read not audited · adapter message logged · scribe on in production with a stub ·
upload signature unchecked · front-desk status leaks · signature mutable at the database · discard keeps the audio.
All 17 were caught.

**By hand, in a browser** against a throwaway schema (dropped afterwards): sign-in with the authenticator; the
queue and the read-only role view; macros added and inserted; autosave; a **real browser recording** (a synthetic
audio stream stands in for a microphone, which this browser has none of) uploaded to the signed URL, transcribed and
drafted; the AI banner; the sign dialog refusing without the review tick and refusing demo text; real text signed;
an amendment with its history; the front desk's view; the session-log form; a 768 px tablet layout. **Not tested:** a
real microphone, iOS Safari's recording format, and anything on a phone — they are on the staging checklist.

---

## 5. Trying it

```bash
cd server && npm run web:build && npm run dev      # then open http://localhost:4000/app
ADMIN_EMAIL=you@example.com npm run seed:admin      # prints a one-time setup link
```
Create a provider in **Admin → Accounts**, linked to a staff record of the matching role, and enrol their
authenticator at first sign-in. Check a patient in from the front desk and open **Provider**. In development the
scribe works against the stubs: it records, "transcribes" and drafts the canned demonstration text (which signing
refuses until you replace it). Writes under `server/.devdata/` are fake files.

---

## 6. What the real AWS adapters need

You asked for exactly what to set up. This is the list; **I have not built the adapters** (no credentials yet). They
will implement the same two interfaces the stubs do (`FileStorage`, `AiScribe`) and plug in through the existing
`IntegrationConfig` switch, so nothing else changes.

> **Verify against AWS's own docs before you click.** The Transcribe Medical parameter and permission names below
> are from my knowledge of the API (the AWS page I tried to read returned no content). The HIPAA eligibility of
> Bedrock, Transcribe (including HealthScribe), S3 and KMS I **did** confirm on AWS's HIPAA-eligible-services page.
> AWS HealthScribe, which does speech-to-text and note generation in one service, exists and is covered by the same
> list; I have stayed with Transcribe Medical + Bedrock because that is what you specified.

### 6.1 What happens, step by step
1. The provider confirms consent; the server creates a `ScribeSession` with a random key `scribe/audio/<uuid>.<ext>`.
2. The browser asks for an upload target and **PUTs the recording directly to S3** (a presigned URL — no cookie,
   no extra headers; the stub already behaves this way). The server never carries the audio.
3. `finish` → the server confirms the object exists, then `AiScribe.transcribe` runs a **Transcribe Medical batch
   job** (`StartMedicalTranscriptionJob`, `Type: CONVERSATION`, `Specialty: PRIMARYCARE`, `LanguageCode: en-US`,
   input `s3://<bucket>/scribe/audio/…`, output `s3://<bucket>/transcripts/<uuid>.json`, KMS-encrypted), polls
   `GetMedicalTranscriptionJob` until it completes (minutes, not seconds), then deletes the job record.
4. `AiScribe.draftSoap` reads the transcript from S3 and asks a **Bedrock** Claude model, via the Converse API, for
   Subjective / Objective / Assessment / Plan as strict JSON; the model id is returned and stored with the draft.
5. The provider reviews, edits and signs (§3.5). Nothing about the draft is trusted.

### 6.2 AWS resources to create
| # | Resource | Settings that matter |
|---|---|---|
| 1 | **AWS account + BAA** | Sign the AWS Business Associate Addendum in your account (AWS Artifact → Agreements; confirm the current process with AWS) **before any real audio**. Use **one region** for everything — one where Transcribe Medical and your chosen Claude model are both available (US regions usually are) |
| 2 | **KMS key** (customer-managed, symmetric) | Used for the bucket and the Transcribe output. Key policy lets the app's IAM identity use it (`kms:GenerateDataKey`, `kms:Decrypt`). Enable automatic rotation |
| 3 | **S3 bucket** (one, two prefixes: `scribe/audio/`, `transcripts/`) | **Block all public access**; default encryption **SSE-KMS** with the key above (bucket key on); a bucket policy **denying any request not over TLS** (`aws:SecureTransport = false`); **CORS** allowing `PUT` from your app's origin with `Content-Type` allowed and `ETag` exposed; **versioning off** (or a lifecycle rule expiring non-current versions after a day) — otherwise "discard" would leave the audio behind as a prior version; a **lifecycle rule** expiring `scribe/audio/` after your retention period (§9) and aborting incomplete multipart uploads; **CloudTrail data events** on the bucket so access is logged outside the app |
| 4 | **IAM identity for the app** | Today the app runs on Render, outside AWS, so this is an **IAM user with an access key and no console access**, attached to **one inline policy** (below). When the app moves onto AWS compute, replace it with a task / instance role and delete the key |
| 5 | **Transcribe Medical** | Nothing to provision — it is an API. Decide the specialty (default `PRIMARYCARE`) |
| 6 | **Bedrock model access** | In the Bedrock console enable the Claude model you choose in the chosen region (accept the provider's terms / use-case form if asked). Leave **model invocation logging off** (or send it only to an encrypted, access-controlled bucket) — it would otherwise copy transcripts |
| 7 | **Budgets / alarms** | An AWS Budget alert and an alarm on repeated failures; Transcribe and Bedrock are billed per use |

The IAM policy (replace the placeholders; Bedrock needs the **foundation-model ARN**, and the
**inference-profile ARN** too if you use a cross-Region profile — then also allow the foundation model in each
Region the profile can route to, and keep those inside the US):

```json
{ "Version": "2012-10-17", "Statement": [
  { "Sid": "Audio",  "Effect": "Allow", "Action": ["s3:PutObject","s3:GetObject","s3:DeleteObject"],
    "Resource": ["arn:aws:s3:::<BUCKET>/scribe/audio/*", "arn:aws:s3:::<BUCKET>/transcripts/*"] },
  { "Sid": "Keys",   "Effect": "Allow", "Action": ["kms:GenerateDataKey","kms:Decrypt"], "Resource": "<KMS_KEY_ARN>" },
  { "Sid": "Transcribe", "Effect": "Allow",
    "Action": ["transcribe:StartMedicalTranscriptionJob","transcribe:GetMedicalTranscriptionJob","transcribe:DeleteMedicalTranscriptionJob"],
    "Resource": "*" },
  { "Sid": "Draft",  "Effect": "Allow", "Action": ["bedrock:InvokeModel"],
    "Resource": ["arn:aws:bedrock:<REGION>::foundation-model/<MODEL_ID>", "arn:aws:bedrock:<REGION>:<ACCOUNT_ID>:inference-profile/<PROFILE_ID>"] }
]}
```
If Transcribe refuses to read the input with the caller's own permissions, it needs a **data-access role** it can
assume to read `scribe/audio/*` and write `transcripts/*` (with the KMS grants); I will add its ARN as a setting then.

### 6.3 Settings and variables
Non-secret settings live in `IntegrationConfig.settings` (visible to an admin; Phase 1 design). **Credentials never
do** — they come from the environment.

| Name | Where | Example | Secret? |
|---|---|---|---|
| `AWS_REGION` | env, web service | `us-east-1` | no |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | env, web service only (the cron job does not touch the scribe) | — | **yes** — enter in the Render dashboard, never in a file or a message to me |
| `FILE_STORAGE.settings.bucket` | `IntegrationConfig` | `nextwave-clinic-prod` | no |
| `FILE_STORAGE.settings.kmsKeyId` | `IntegrationConfig` | the key ARN | no |
| `FILE_STORAGE.settings.uploadTtlSeconds` | `IntegrationConfig` | `900` | no |
| `AI_SCRIBE.settings.transcribeSpecialty` / `.transcribeLanguage` | `IntegrationConfig` | `PRIMARYCARE` / `en-US` | no |
| `AI_SCRIBE.settings.bedrockModelId` | `IntegrationConfig` | the model or inference-profile id from the Bedrock console | no |
| `AI_SCRIBE.settings.transcribeDataAccessRoleArn` | `IntegrationConfig`, only if needed | role ARN | no |
| `IntegrationConfig.provider` for `FILE_STORAGE` / `AI_SCRIBE` | database | `stub` → `s3` / `aws` | no |
| `ALLOW_STUB_INTEGRATIONS` | env | **must be unset** in production | no |

### 6.4 What I need back, and what I'll do
**From you:** the region, bucket name, KMS key ARN and Bedrock model id (the non-secret settings); the BAA signed;
the retention period (§9); the access key entered **directly in Render**. **From me, once you say go:** the
`S3FileStorage` and `AwsAiScribe` adapters; error translation to categories (no provider message ever passed on);
a prompt that demands strict S/O/A/P JSON and rejects anything else; contract tests that run the *same* suite
against the stub and the real adapter; and a script that runs one synthetic recording end to end in staging.

---

## 7. Known limitations and open risks

1. **Any provider can amend any note.** `POST /api/visit-notes/:id/amend` (existing, unchanged) requires a provider
   role but not that you are the author, or hold the booked role. The workspace only *offers* Amend for the booked
   role. You told me not to change the amendment model, so I left it; the audit trail names who amended what.
2. **An AI draft can be signed exactly as written** (recorded, §3.5).
3. **No retention policy or purge job for audio.** It stays until a provider discards it or an S3 lifecycle rule
   (§6.2) removes it. Retention is a clinical-records decision, so I did not pick a number.
4. **Scribe processing is in the web process.** A restart mid-transcription leaves the session until the 15-minute
   check marks it failed; it is retried by a click. Fine at this volume; a queue would be the next step.
5. **A recording lives in browser memory until uploaded.** Closing the tab loses it; the upload can be retried
   while the page is open. There is a 90-minute cap and a 150 MB limit on the stub's upload.
6. **A recording keeps an unattended screen signed in** (§3.7).
7. **The front desk can check a patient out before the note is signed** — it shows a warning, not a block.
8. **One discount percentage per tier** (§1.1), and **perks stay off** until you give the quantities.
9. **Not independently reviewed for HIPAA**, and not run against real devices (staging checklist). Draft and note
   text sit in the database like any other column: encryption at rest is the database host's (RDS later).
10. Dependency advisories: unchanged from Phase 1.

> **Update (Phase 5):** items 1, 3 and 8 are resolved. (1) **Only the signer can amend a note**; any other provider adds an
> addendum; an admin has no write path. (3) **Raw audio is deleted 30 days after signing** by a step of `jobs:run`
> (`AUDIO_RETENTION_DAYS`); the transcript and draft stay. (8) Discounts are per tier per service category (none enabled
> yet); perks stay off. See `docs/PHASE5_NOTES.md` §1.

---

## 8. Bugs found along the way

- **An adapter's error message reached the log, including a name** — found by a test that made a fake adapter
  quote a patient; §3.8.
- **Starting a recording did not start the visit** (it stayed "waiting"); found by the scribe test.
- **After amending the Subjective section it jumped below Plan** — found in the browser. The four notes were
  created at the same instant, so their order was whatever the database returned; they are now one millisecond
  apart, and the page orders by section as well.
- **Stale-session detection fired immediately under the pinned test clock** — it compared a database-stamped time
  with the injectable clock. It now uses the wall clock, the only clock that column honestly shares.
- **The AI-review rule was masked by the content checks** (a draft that needed review reported "demo text" first);
  the review check now comes first.
- **The signer's name on screen differed from the one recorded** (account display name vs provider record); the form
  and the sign dialog now show the name the signature will carry.
- **The queue offered "Open" as the main action on a role the viewer cannot write in**; it says "View".
- **The history route returned note text without a note-read audit row** (§3.10).
- The Home tile for a finished module still said "Coming in Phase 2/3/4" — a `built` flag fixes that.
- Two of my own test expectations were wrong (the amendment history shows each reason against the version it
  replaced; whether a trailing space survives a macro insertion). The second became a small improvement.

---

## 9. What I need from you

1. **Review and approve this phase** — or tell me what to change.
2. **The clinic's phone number and street address.** Add them to `contact.html`, give them to me, and I fill in the
   legal pages, `src/clinicContact.ts` (and the test then keeps them in step) and your `CLINIC_PHONE`.
3. **Tier discount percentages**, and whether one percentage per tier is enough (§1.1). Also confirm "paid in cash"
   covers credit-eligible services.
4. **Perk quantities per tier** (still blank), and the list in the Phase 3 notes §9.3.
5. **Counsel's read of `privacy.html` and `sms-terms.html`** and the effective date; confirm you have a Notice of
   Privacy Practices to reference.
6. **Pushing:** `main` is 2 commits ahead of `origin/main` (§1.2). Say when to push it and open the site PR.
7. **Amendments:** should a note be amendable only by its author, or only by the booked role (§7.1)?
8. **AI drafts:** is signing one unchanged acceptable, as recorded (§3.5)? Should a recording keep an unattended
   screen signed in (§3.7)?
9. **Check-out before signing:** warn (today) or block?
10. **Audio retention:** how long (§7.3)?
11. **AWS:** the items in §6.4. Nothing real is recorded until the BAA is signed and the adapters are connected.
12. **Real devices:** the staging checklist (`docs/STAGING_CHECKLIST.md`) — especially a phone and iOS Safari recording.
13. **Next:** Phase 5 (Accounting + Reports) as planned? It will read `RevenueEvent` — list price, discount, net —
    which has been written by every check-out since Phase 3.
