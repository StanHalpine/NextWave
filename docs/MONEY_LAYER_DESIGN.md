# Phase 2b — the money layer (design only, not approved)

Status: **design for review. No code, no migration.** It replaces the L2 and L3 sketches in `docs/SPEC.md` §4.7 / §5.6 / §7, and
builds on rev 2.0's decisions: check-out never waits for a note; partial payments are recorded on the date collected and the
rest carries forward until paid or written off by an admin; admin promotions apply automatically; the front desk may make a
one-off adjustment with a reason code; a list price is never edited. **Tender types are recorded by hand. No card processing,
and no card data in the app.**

Ground rules carried over from the credit ledger and `RevenueEvent`: **integer cents**, **append-only** (the existing
`nw_reject_ledger_mutation()` triggers on UPDATE / DELETE / TRUNCATE), **Row Level Security enabled on every new table** (no
policies; the app is the owner), every write audited in the same transaction (`rec()`), and **nothing that can be derived is
stored** — above all, no stored balance.

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
| `tender` | enum `CASH · CHECK · CARD_TERMINAL · OTHER` — `CARD_TERMINAL` means "run on the clinic's own card machine"; the app sees only the amount. `OTHER` needs a note |
| `amountCents` | `> 0` |
| `reference` | Optional (cheque number, terminal receipt number). The server **refuses anything that looks like a card number** (13–19 digits passing Luhn) |
| `idempotencyKey` | `UNIQUE` (§6) |
| `batchId` | The combined check-out, if it came from one |

### 2.3 `PaymentAllocation` — what a payment paid

`(paymentId, revenueEventId, amountCents > 0)`. A **deferred constraint trigger** (the same pattern as `nw_credit_guard`)
refuses a commit in which a payment allocates more than its amount, or a charge receives more than its net less its write-offs.
Allocation is **oldest charge first** (A-21) unless the desk picks specific visits. **Overpayment is refused** in this phase
(there is no "credit on account" yet — see open question 5), so every payment is fully allocated.

### 2.4 Reversals and write-offs

| Table | What | Who |
|---|---|---|
| `PaymentReversal` | Undoes one payment entirely (`paymentId UNIQUE`, reason code, note). Its allocations count as undone; a refund of cash is a reversal | **admin, MFA session** (A-19) |
| `ChargeWriteOff` | Clears all or part of a charge's outstanding amount (`revenueEventId`, `amountCents > 0`, reason code). Decision 4: "carries forward until paid or **written off by an admin**" | **admin, MFA session** |
| `ChargeVoid` *(L3, flagged)* | Cancels a charge recorded in error (`revenueEventId UNIQUE`, reason). Credits it redeemed are returned by an `ADJUSTMENT` lot in the credit ledger, in the same transaction | admin, MFA session |

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

## 3. The balance (derived, never stored)

```
outstanding(charge) = net − Σ allocations of payments not reversed − Σ write-offs − (voided ? net : 0)
balance(patient)    = Σ outstanding(charge) over the patient's visit charges
```

Membership **dues are not in it** (A-21; they are billed with the month's credits and collected outside the app). One SQL query
under the patient's row lock when it matters for a write; the same query, unlocked, for the Ledger. Indexes:
`PaymentAllocation(revenueEventId)`, `Payment(patientId, collectedOn)`, `ChargeWriteOff(revenueEventId)`.

**Charges recorded before 2b goes live** were "paid at the desk" with no record of it. Default: they are **settled by
definition** — the balance counts charges from the go-live date (`MONEY_LAYER_START`, a config date) onward, and the Ledger
labels anything older "before payments were tracked". The alternative (treat them as outstanding) would show every staging
visit as owed. Open question 4.

## 4. Promotions and one-off adjustments

**At check-out**, for a visit paid in money, the server (never the browser) finds the active promotions whose scope includes the
service and whose dates include **the visit's clinic date** (so a check-out done the next morning keeps the week's price), and
applies the **one** that gives the lowest price (promotions do not stack with each other). A fixed amount is capped at the price.
Credit- and perk-paid visits are not promoted.

**Stacking with the tier discount** is the owner's call (open question 1). The default proposed here: the member gets **the
better of** their tier discount and the promotion, not both — the patient never pays more than either alone would give, and
the clinic never gives two discounts it did not decide to combine.

**The desk's one-off adjustment**: per visit, at check-out, a reduction in cents (≤ what is left after discounts) plus a
**required reason code** (`SERVICE_RECOVERY · PRICE_MATCH · COURTESY · BILLING_ERROR · OTHER`; `OTHER` needs the note). It is
shown on the check-out screen before confirming, recorded on the charge, audited (code and cents, no note text), and listed in
**Accounting → Adjustments for review** (§7). An optional cap above which only an admin may adjust is open question 3.

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
5. If a payment is given: refuse more than the balance after step 4 (no overpayment); if it is less, require
   `confirmPartial: true` (A-21) — otherwise 400 `partial_needs_confirmation` and nothing is written. Write the `Payment`
   (`collectedOn` = today, clinic time) and allocate it **oldest charge first** — so an old carried-forward balance is paid
   before today's visits unless the desk chose otherwise.
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

Added to *Daily* and *Monthly*, plus two views: **Receivables** (outstanding by age: 0–30, 31–60, 61–90, 90+ days; counts and
sums) and **Adjustments for review** (each adjustment and write-off: date, service, amount, reason, who). Accounting's rule is
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

## 10. Open questions for the owner

1. **Promotion and tier discount together?** Default: the better of the two, not both.
2. **Which date decides a promotion** — the visit's (default) or the check-out's?
3. **A cap on desk adjustments** without an admin (e.g. $25 or 20%)? Default: no cap, every one reviewed. And the reason codes.
4. **Charges from before payments were tracked**: settled by definition (default) or outstanding?
5. **Overpayment / prepayment**: refuse (default) or keep as a credit on account (a new table and a "credit" line on the Ledger)?
6. **Adjustments for review without patient names** in Accounting (default), or a named list somewhere outside Accounting?
7. **Tender types**: cash, cheque, card terminal, other — anything else (HSA/FSA cards run on the terminal count as card)?
8. **Who may reverse a payment** taken the same day — admin only (default, A-19), or the desk within the same day?
