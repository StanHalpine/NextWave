# Phase 2b — the money layer

Status: **APPROVED (SPEC rev 2.2), with the owner's decisions in §0 — they override anything below that disagrees.** Built on
rev 2.1 (note ownership). It replaces the L2 and L3 sketches in `docs/SPEC.md` §4.7 / §5.6 / §7, and
builds on rev 2.0's decisions: check-out never waits for a note; partial payments are recorded on the date collected and the
rest carries forward until paid or written off by an admin; admin promotions apply automatically; the front desk may make a
one-off adjustment with a reason code; a list price is never edited. **Tender types are recorded by hand. No card processing,
and no card data in the app.**

Ground rules carried over from the credit ledger and `RevenueEvent`: **integer cents**, **append-only** (the existing
`nw_reject_ledger_mutation()` triggers on UPDATE / DELETE / TRUNCATE), **Row Level Security enabled on every new table** (no
policies; the app is the owner), every write audited in the same transaction (`rec()`), and **nothing that can be derived is
stored** — above all, no stored balance.


## 0. The owner's decisions (Chase, rev 2.2) — these govern

| # | Decision | What it changes below |
|---|---|---|
| 1 | **Promotion vs member tier discount: whichever is better for the patient. Never stacked.** Promotions never stack with each other either: the single best one | §4 |
| 2 | A promotion applies by **the VISIT's clinic date**, not the payment's or the check-out's | §4 |
| 3 | **Front desk adjustment cap: 20% of the visit's list price or $25.00, whichever is less**, with a required reason code. Anything larger only by an **admin on an MFA-verified session**. Enforced on the server | §4 |
| 4 | **Overpayment**: the patient chooses — a **refund** (a `Refund` row, with its tender type) or **account credit in dollars**. Account credit is **completely separate from membership credits** (FIFO lots, 90-day expiry): its own table, its own math, its own label (**"Account credit ($)"** vs **"Membership credits"**). The desk chooses to apply it to future charges at check-out; an admin can refund it | §2.3, §2.7 (new) |
| 5 | **Tender types: Cash, Card, Check, HSA/FSA, Other.** Recorded by hand. No card processing, no card data stored | §2.2 |
| 6 | **Reversing a payment**: the front desk **on the same clinic day** (America/Chicago) it was collected; after that, **admin only** (MFA). A new row referencing the original, never an edit | §2.4 |
| 7 | **Everything checked out before 2b goes live counts as paid in full** — see §3 for how | §3 |
| 8 | **Partial payments** are recorded on the date collected; the remaining balance shows **at the bottom of the Ledger** and carries forward; allocation is **oldest charge first** | §5, §8 |
| — | **Biomarker testing needs no note** (`requiresNote = false`, migration and seed). Uploading results is a later phase, not 2b | — |

**Not in 2b** (not in the approved scope; the design is kept for later): **write-offs** (`ChargeWriteOff`) and **voids** (`ChargeVoid`).
A balance therefore carries forward until it is paid; nothing clears it but a payment or account credit.

**As built, two refinements of the original sketch** (both stricter, neither changes a decision):
- **Idempotency stores the response.** `IdempotencyRecord(key, scope, patientId, requestHash, status, response)`, written in the same
  transaction as the money it describes; a retry with the same key and body returns the stored response byte for byte.
- **Promotions are configuration, not a ledger.** `Promotion` / `PromotionService` cannot be deleted, and once a charge has used a
  promotion its kind, value, dates and scope are frozen **by a database trigger** — only *active* may still change. Every other new
  table is append-only.

---

## 1. What exists today, and the gap

| Exists | Meaning |
|---|---|
| `RevenueEvent` (one per checked-out visit) | **The charge.** List price, tier discount, net. "CASH" means *paid in money at the desk* — but nothing records that the money arrived |
| `CreditLedger` / `CreditAllocation` | Credits, FIFO, append-only, a deferred guard against overdraw. Not money |
| The Ledger (L1) | A read model: today's visits priced as check-out would price them, earlier visits as recorded. **No balance** |

Missing: a record of money **collected**, of what it **paid**, of **reversals and write-offs**, of **promotions and
adjustments**, and therefore any **balance**.

## 2. Tables

All new tables: `ENABLE ROW LEVEL SECURITY`, append-only triggers except where marked *config*, money columns `INTEGER` cents with
`CHECK (… >= 0)` or `> 0`, timestamps UTC, clinic-local dates as `DATE`.

### 2.1 Charges: `RevenueEvent`, extended (not replaced)

The charge stays where Accounting already reads it. Three groups of nullable columns are added, set **at check-out only**:

| Column | Meaning |
|---|---|
| `promotionId`, `promotionCents` | The promotion that applied (§4) and what it took off. Snapshot: a later edit of the promotion changes no charge |
| `adjustmentCents`, `adjustmentReason`, `adjustmentNote` | The desk's one-off adjustment (§4): a reduction, a reason code (enum), an optional short note (≤ 200 chars; never written to the audit log or logs) |
| `batchId` | The combined check-out it was part of (§5), if any |

`RevenueEvent_consistent` is re-stated so a money visit satisfies
`net = list − tierDiscount − promotion − adjustment`, every term ≥ 0, net ≥ 0. A visit paid with credits or a perk still has
net 0 and no promotion or adjustment (credits are not money). The list price column is the service's price at the time — it is
never edited; every reduction is its own column.

### 2.2 `Payment` — money collected

| Column | Notes |
|---|---|
| `id`, `patientId` | |
| `collectedOn DATE` | **The clinic day the money was collected** (decision 4). Accounting's "collected" is by this date |
| `receivedAt`, `recordedById` | The instant and the desk login |
| `tender` | enum **`CASH · CARD · CHECK · HSA_FSA · OTHER`** (decision 5) — a card or an HSA/FSA card is run on the clinic's own terminal; the app sees only the amount. `OTHER` needs a note |
| `amountCents` | `> 0` |
| `reference` | Optional (cheque number, terminal receipt number). The server **refuses anything that looks like a card number** (13–19 digits passing Luhn) |
| `idempotencyKey` | `UNIQUE` (§6) |
| `batchId` | The combined check-out, if it came from one |

### 2.3 `PaymentAllocation` — what a payment paid

`(paymentId, revenueEventId, amountCents > 0)`. A **deferred constraint trigger** (the same pattern as `nw_credit_guard`)
refuses a commit in which a payment allocates more than its amount, or a charge receives more than its net less its write-offs.
Allocation is **oldest charge first** (A-21, decision 8). **Overpayment** (decision 4): what is left after the charges are paid goes,
as the patient chooses, to a **`Refund`** (source `OVERPAYMENT`, its own tender) or to **account credit** (§2.7). A guard checks at
commit that every payment is accounted for exactly: allocations + its overpayment refund + its account credit = its amount.

### 2.4 Reversals and write-offs

| Table | What | Who |
|---|---|---|
| `PaymentReversal` | Undoes one payment entirely (`paymentId UNIQUE`, reason code, note, `reversedOn`). Its allocations count as undone, and the account credit it created is taken back (refused if that credit has already been used). A payment whose overpayment was refunded cannot be reversed | **front desk on the payment's own clinic day; admin (MFA) after that** (decision 6) |
| `Refund` | Money paid back: source `OVERPAYMENT` (at the payment, decision 4) or `ACCOUNT_CREDIT` (an admin refunding a patient's account credit), with its tender | the desk (overpayment, at the payment); **admin, MFA** (account credit) |
| `ChargeWriteOff` | *Not in 2b.* Clears all or part of a charge's outstanding amount | admin, MFA session |
| `ChargeVoid` *(L3, not in 2b)* | Cancels a charge recorded in error | admin, MFA session |

A reversal never edits what it reverses; each references its original, and the original stays visible with a "reversed" mark.

### 2.5 `Promotion` and `PromotionService` — *config*, audited

| Column | Notes |
|---|---|
| `name`, `kind` | `PERCENT` (1–100) or `FIXED_CENTS` (> 0) |
| `value` | Percent or cents |
| `startsOn`, `endsOn` | Clinic-local `DATE`s, both inclusive ("Oct 20–26") |
| `active` | An admin may switch one off at any time |
| `PromotionService (promotionId, serviceId)` | Scope: one or more services (red light, say). A category scope can come later |

Editable by an admin until **the first charge uses it**; after that its kind, value, dates and scope are frozen (deactivate
and create a new one), so the snapshot on each charge always matches a promotion that existed. Every change audited from → to.

### 2.6 `CheckoutBatch` — one combined check-out

`(id, patientId, idempotencyKey UNIQUE, requestHash, createdById, createdAt)`. Append-only. It groups the charges and the payment
one combined check-out wrote, and is what makes a retried request return the same answer (§6).

### 2.7 `AccountCreditEntry` — account credit in dollars (decision 4)

Append-only signed rows: `+` **OVERPAYMENT** (from a payment), `−` **APPLIED** (to a charge, at check-out, when the desk chooses), `−`
**REFUNDED** (an admin refund, with its `Refund` row), `−` **REVERSED** (its payment was reversed). The balance is `Σ delta`, never
stored; a guard refuses a commit that would take it below zero. **It shares nothing with membership credits** — not a table, not a
function, not a column, not a label.

### 2.8 `PreTrackingSettlement` — charges from before payments were tracked (decision 7)

One row per visit charge that existed when the migration ran, written **by the migration** (`INSERT … SELECT`). Such a charge counts as
settled in full. See §3.

## 3. The balance (derived, never stored)

```
outstanding(charge) = net − Σ allocations of payments not reversed − Σ write-offs − (voided ? net : 0)
balance(patient)    = Σ outstanding(charge) over the patient's visit charges
```

Membership **dues are not in it** (A-21; they are billed with the month's credits and collected outside the app). One SQL query
under the patient's row lock when it matters for a write; the same query, unlocked, for the Ledger. Indexes:
`PaymentAllocation(revenueEventId)`, `Payment(patientId, collectedOn)`, `ChargeWriteOff(revenueEventId)`.

**Charges recorded before 2b goes live** were "paid at the desk" with no record of it (decision 7: they count as paid in full). As
built: the migration writes a **`PreTrackingSettlement`** row for every visit charge that exists at that moment, and
`outstanding = 0` for a settled charge. Why this and not the two alternatives:
- **Not a cut-off date in configuration** — a date is only as right as whoever sets it, and a charge written in the minutes between
  the migration and the new code would fall on the wrong side. The migration knows exactly which charges it found.
- **Not synthetic `Payment` rows** — they would put invented tenders and amounts into "collected". The settlement says what is true:
  settled before tracking. Accounting shows it as its own column, so billed − collected for an old month is explained, not missing.

```
outstanding(charge) = net − Σ allocations of payments not reversed − Σ account credit applied − (pre-tracking ? net : 0)
balance(patient)    = Σ outstanding(charge)                        account credit(patient) = Σ AccountCreditEntry.delta
```

## 4. Promotions and one-off adjustments

**At check-out**, for a visit paid in money, the server (never the browser) finds the active promotions whose scope includes the
service and whose dates include **the visit's clinic date** (so a check-out done the next morning keeps the week's price), and
applies the **one** that gives the lowest price (promotions do not stack with each other). A fixed amount is capped at the price.
Credit- and perk-paid visits are not promoted. A percentage rounds like the tier discount (to the cent, halves up).

**With the tier discount: the better of the two, never both** (decision 1). The charge records whichever applied — the tier's
`discountPercent`/`discountCents`, or the promotion's `promotionId`/`promotionCents` — and the other as zero. On a tie the tier
discount is recorded (the price is the same).

**The desk's one-off adjustment**: per visit, at check-out, a reduction in cents (≤ what is left after discounts) plus a
**required reason code** (`SERVICE_RECOVERY · PRICE_MATCH · COURTESY · BILLING_ERROR · OTHER`; `OTHER` needs the note). It is
shown on the check-out screen before confirming, recorded on the charge, audited (the code — no cents, no note text), and listed in
**Accounting → Review** (§7). **Cap (decision 3): the front desk may adjust up to `min(floor(20% × list), $25.00)`**; above that the
server refuses it unless the person is an **admin on an MFA-verified session**. Neither may take a visit below zero.

## 5. Combined check-out with partial payment

`POST /api/fd/patients/:id/checkout` — fd, admin.

```jsonc
{
  "idempotencyKey": "9f1c…",            // one per press of the Confirm button; the screen makes it
  "expectedVersion": "v:4b2e…",          // the Ledger version the screen was showing (§6)
  "visits": [                            // any of today's checked-in visits (CHECKED_IN, IN_PROGRESS, SEEN) — the note is irrelevant
    { "bookingId": "…", "pay": "MONEY", "expectedNetCents": 4400,
      "adjustment": { "cents": 500, "reason": "SERVICE_RECOVERY" } },
    { "bookingId": "…", "pay": "CREDITS" }
  ],
  "payment": { "tender": "CASH", "amountCents": 2000 },   // optional: nothing collected is allowed
  "confirmPartial": true                                    // required when amount < what is due
}
```

One transaction:

1. Lock every named `Booking` row **in id order**, then the `Patient` row, then the `Membership` (the existing order
   Booking → Patient → Membership, extended to several bookings sorted so two combined check-outs cannot deadlock).
2. Re-read the Ledger version; if it is not `expectedVersion` → **409 `ledger_changed`** with the fresh Ledger (§6).
3. For each visit, the **same pricing function** the single check-out uses (refactored out of `checkoutVisit`) computes list,
   tier discount, promotion, adjustment and net; any `expectedNetCents` mismatch → 409 `price_changed` with the new figures.
   Credits and perks are taken exactly as today.
4. Write one `RevenueEvent` per visit (with `batchId`), check each visit out (`checkOut()`, still the only writer of
   CHECKED_OUT).
5. Account credit, if the desk chose to apply some: at most what the patient has and what is due, oldest charge first.
6. If a payment is given: if it is less than what is still due, require `confirmPartial: true` (decision 8) — otherwise 400
   `partial_needs_confirmation` and nothing is written; if it is **more**, require the patient's choice for the rest —
   `overpayment: { as: "REFUND", tender }` or `{ as: "ACCOUNT_CREDIT" }` (decision 4). Write the `Payment` (`collectedOn` = today,
   clinic time) and allocate it **oldest charge first**, so an old carried-forward balance is paid before today's visits.
6. Write the `CheckoutBatch`; audit everything; commit. The deferred allocation guard runs at commit.

The single-visit check-out keeps its route and becomes the same code with one visit. A payment **without** a visit — a patient
settling an old balance — is `POST /api/fd/patients/:id/payments` with the same idempotency and version rules.

## 6. Idempotency and 409-on-concurrent-change

**Idempotency.** Every money write carries an `idempotencyKey` generated by the screen when the confirm dialog opens. The key is
`UNIQUE` on `CheckoutBatch` / `Payment` and is inserted **inside** the transaction, so a crash leaves neither. A retry with the
same key and the same `requestHash` (SHA-256 of the canonical body) returns **200 with what was recorded the first time**,
rebuilt from the rows; the same key with a different body is **409 `idempotency_key_reused`**. A double click therefore records
one payment, the way check-out already records one revenue event.

**Concurrent change → 409.** `GET /api/fd/patients/:id/ledger` returns a `version`: a hash over the patient's charges,
allocations, payments, reversals, write-offs and the encounter state of today's visits. Every write sends the version it was
looking at; the server recomputes it **under the patient lock** and refuses a mismatch with **409 `ledger_changed`** and the
current Ledger, so the desk confirms against what is true now. Examples: a second desk checked out one of the visits a minute
earlier; an admin wrote off part of the balance; the 10-second refresh had not yet caught up. Nothing is ever applied to a
state the person did not see.

## 7. Accounting: billed vs collected

| Column / view | Source | Dated by |
|---|---|---|
| **Billed** | `RevenueEvent.netPriceCents` (visit charges), less voids | check-out date (as today) |
| **Promotions / Adjustments** | `promotionCents`, `adjustmentCents` | check-out date |
| **Collected** | `Payment.amountCents`, less reversals (a reversal counts negative on **its own** date) | `collectedOn` |
| **Written off** | `ChargeWriteOff.amountCents` | write-off date |
| **Outstanding** at the end of the range | derived (§3) | — |

As built in 2b: a **Billed vs collected** view (by day or month: billed, promotions, adjustments, collected = payments − reversals −
refunds each on its own date, settled before tracking) and a **Review** list for admins (each desk/admin adjustment, payment reversal and
refund: date, kind, service, amount, reason, who). Receivables by age is not in 2b. Accounting's rule is
aggregates only — **no patient is named** — so the review list shows no patient; the admin opens the visit from its row, which
is audited as a record read (open question 6). Dues stay their own table, billed only. CSV export as today.

## 8. The Ledger, with a running balance

The L1 sections stay (today's visits with their estimate, credits, dues as information). **Posted entries** — charges,
promotions and adjustments, payments, reversals, write-offs — form one dated list with a running balance, and **the balance
carried forward is the last line**:

```
Ben Okoro — Ledger                                       Updated 2:53 PM · refreshes every 10 s

TODAY · Thu Oct 22                                       (not yet checked out — an estimate, nothing posted)
  9:45  Red Light Therapy · Sofia Marin, RN     Ready to check out · No note needed      $44.00 if paid
                                                Promotion "Red light week" −20%  (−$11.00)
  [ Check out selected… ]

POSTED                                           Charge      Paid    Balance
  Oct 14  Manual Adjustment · Dr. Reyes          $55.00               $55.00
          Payment — cash (partial)                        −$20.00     $35.00
  Oct 20  Hyperbaric Oxygen (60 min)            $110.00              $145.00
          Adjustment — service recovery         −$10.00              $135.00
  Oct 20  Payment — card terminal                         −$100.00    $35.00
  Oct 22  Manual Adjustment · Dr. Reyes          $55.00               $90.00   Note pending
          Payment — cash (partial)                        −$55.00     $35.00
  ───────────────────────────────────────────────────────────────────────────
  BALANCE CARRIED FORWARD                                             $35.00   owed by the patient
                                                    [ Take a payment… ]   (admin: [ Write off… ])

CREDITS   Restore · 4 credits available · 2 expire Nov 3
DUES      billed with each month's credits, collected outside this app — not in the balance
```

Rules: a payment is shown on the day it was **collected**; a reversed entry stays, struck through, with its reversal beneath it;
note status stays visible on each visit and never affects money; nothing on this screen is charged by looking.

## 9. Order of work, and tests

1. **2b-1** Tables, triggers, RLS; the derived balance; the Ledger's posted list and carried-forward line (read only).
2. **2b-2** Payments: single-visit check-out takes a payment (full, partial or none); "Take a payment"; idempotency; 409 on
   version.
3. **2b-3** Combined check-out.
4. **2b-4** Promotions (admin screen) and desk adjustments; Accounting billed vs collected, Receivables, Adjustments for review.
5. **L3** Reversals, write-offs, voids (admin, MFA).

Tests in the style of the existing suite: concurrent combined check-outs of the same patient from two desks (one wins, one 409s,
one payment); a double click and a retried request (one payment, same answer); a changed body under a reused key; partial
payment refused without confirmation; overpayment refused; oldest-first allocation across a carried-forward balance; the
allocation guard (direct SQL that over-allocates fails at commit); append-only triggers on every table; a promotion's dates at
both ends of the clinic day and across the 2026-11-01 fall-back; promotion vs tier discount per the owner's rule; a frozen
promotion; card-number-shaped references refused; Accounting by `collectedOn` across a Chicago midnight; RLS on every new table;
a reversed payment reopens exactly what it paid.

## 10. Open questions for the owner *(answered — see §0; kept for the record)*

1. **Promotion and tier discount together?** Default: the better of the two, not both.
2. **Which date decides a promotion** — the visit's (default) or the check-out's?
3. **A cap on desk adjustments** without an admin (e.g. $25 or 20%)? Default: no cap, every one reviewed. And the reason codes.
4. **Charges from before payments were tracked**: settled by definition (default) or outstanding?
5. **Overpayment / prepayment**: refuse (default) or keep as a credit on account (a new table and a "credit" line on the Ledger)?
6. **Adjustments for review without patient names** in Accounting (default), or a named list somewhere outside Accounting?
7. **Tender types**: cash, cheque, card terminal, other — anything else (HSA/FSA cards run on the terminal count as card)?
8. **Who may reverse a payment** taken the same day — admin only (default, A-19), or the desk within the same day?
