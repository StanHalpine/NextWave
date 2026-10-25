# Phase 2c — charges (add-on services and products) and card on file

Status: **2c-A APPROVED (SPEC rev 2.3), with the owner's decisions in §12 — they override anything below that disagrees. 2c-B
(card on file) and 2c-C (returns of paid items) are NOT approved.** It builds on Phase 2b (the money layer, SPEC rev 2.2,
`docs/MONEY_LAYER_DESIGN.md`) and rev 2.1 (note ownership).

Ground rules carried over from 2b: **integer cents**; **append-only** history tables (the `nw_reject_ledger_mutation()` triggers);
**Row Level Security enabled on every new table**; **one database transaction per money or state change**; **idempotency keys**
with stored responses; **409 with the fresh state** on a concurrent change; **audit rows with ids and counts only** — no amounts,
no PHI, no card details; the booking, availability, hold, time and scheduling files stay at **zero diff**.

**Recommendation in one paragraph.** Build it in three steps. **2c-A**: a catalog, the Charges window, and charges held as
removable "open" lines until check-out. **2c-B**: card on file as a *record* — brand, last 4, expiry, consent — of a card that
lives in the clinic's terminal or processor; the app never holds card data. **2c-C**: voids and returns of paid items. **Later**:
stock tracking and a real processor integration.

## Chase's requirements

1. A **Charges** button to the LEFT of "Check out…" on the Front Desk card and its dialog, and in the check-out window. It opens
   quick-add buttons for add-on items (e.g. InBody scan, Magnesium glycinate, Vitamin D3); staff click to add them to the
   patient's charges for the day. Prices set later, easy for admins to edit (catalog screen, audited). Example: Ben has an
   adjustment + red light, then adds an InBody scan, Magnesium and Vitamin D3; total owed $235 (placeholder prices).
2. In the check-out window, staff can **edit a service's fee** — the existing 2b desk adjustment (20% / $25 cap, reason code, admin
   above the cap). The list price is never edited.
3. A **Ledger** button inside the check-out window, opening the same patient Ledger.
4. **Card on file**: after a Card or HSA/FSA payment, ask whether the patient wants the card saved. The patient profile and the
   check-out window show that a card is on file.
5. The check-out window's bottom row, in order: **Charges, Ledger, Checkout, Card on File, Cancel**.
6. After payment the Ledger zeroes out and is identical from every entry point (either visit, patient search); add-ons included.

Hard constraint: the app must **never receive, store, log or display a full card number, CVV or track data** (PCI).

## 1. What the code already gives us

- **A charge does not need a booking.** `RevenueEvent.bookingId` is nullable, and the balance (`chargesOf`) counts every
  non-dues charge by `patientId`. An add-on charge therefore enters the balance, the oldest-first allocation, the Ledger and
  Billed vs collected without changing those rules.
- **InBody already exists as a service.** "Body Composition" (`body-composition`) is a $55 service on the InBody Station with
  `requiresNote = false`, and the `quarterly_body_composition` perk covers it.
- **Supplements are partly set up.** The "Supplements" discount category (Prevent 10% · Restore 15% · Optimize 20%) holds one
  member, the bookable "Supplementation" consult. No retail products exist.
- **Check-out requires at least one visit** today (`no_visits` in `routes/money.ts`). That has to relax so a product-only sale is
  possible.

## 2. Data model

**Add-on services reuse the existing `Service` rows, not a copy.** Add `Service.offerAsAddOn Boolean @default(false)`. InBody then
keeps its price, member credits, discount category, perk and promotions in one place.

- A service may be offered as an add-on **only if it needs no note** (`requiresNote = false`): an add-on has no encounter, so there
  is nowhere for a note to go. Enforced in the app and by a database check.
- An add-on **never creates a booking, hold or slot**. The booking-engine files stay at zero diff. One consequence: an add-on
  InBody scan does not reserve the InBody Station; if the station must be reserved, book it as a visit instead.

**Retail products get a new `Product` table**: name, button group (Supplements, Other…), price in cents, active, sort order;
`taxable`; `tierDiscount` (eligible for the member product discount). *As approved (rev 2.3):* credits never pay for a product, so
there is no credit cost; a promotion targets a product through `PromotionProduct`, like a service through `PromotionService`; the
tier percentages for products are one admin-editable setting per tier (`PlanProductDiscount`), not a service discount category. Admins edit it on a catalog screen; every change is audited as before → after
field names. A price change never rewrites past sales: each charge keeps a snapshot of its price.

**Quantity (decided at review).** A line carries a quantity, 1 to 99. A click on an item already open today — same price snapshot, same
performer — adds one to that line rather than a second line; a quantity can also be typed. The list price is unit price × quantity, and
every discount, adjustment and tax is worked out on that line total, rounded per line (so a fixed-amount promotion comes off once per
line). A change is an append-only `OpenChargeQuantity` row; the charge must carry the quantity as it stood (`nw_open_charge_guard`).
Credits pay the service's cost for each unit; a perk covers one unit.

**Clicked items wait as "open charges" until check-out.** New table `OpenCharge`: patient, service or product, quantity, the
clinic day it was added, who added it, who performed it (optional), and — *as approved* — **snapshots of the name, unit price and
tax rate taken when it is added**, which the posted charge carries unchanged. Removing one adds an `OpenChargeRemoval` row; open charges are
never edited or deleted. At check-out each open line becomes a normal charge (`RevenueEvent`), which is permanent.

- Why not post charges at once: a mis-click would then need a void. Most mistakes happen before check-out, and an open line can
  simply be removed.
- If the patient leaves without checking out, the open lines stay visible and can be checked out on a later day.

**Changes to the charge record (`RevenueEvent`)**:

- `lineKind`: `VISIT | ADDON_SERVICE | PRODUCT | DUES`, backfilled from the payment type for existing rows (to be verified against
  the data before the constraint is added).
- `productId`; `quantity` (default 1; list price = unit price × quantity); `openChargeId` (unique, so a line posts once).
- `taxRateMilli` (a snapshot of the rate) and `taxCents`.
- The 2b charge rule stays: list = tier discount + promotion + adjustment + covered + net. **Tax sits outside it; a line owes
  net + tax.**

**Who performed an add-on**: optional, recorded in the existing `RevenueEvent.staffId`, so the Accounting provider filter already
works. Products have no performer.

## 3. How add-on lines fit the money layer

| Topic | Behaviour |
|---|---|
| Balance | `chargesOf` and the commit-time guard (`nw_money_guard`) change from "net" to "net + tax" per line |
| Allocation | Unchanged: oldest first, by charge |
| Combined check-out | The request gains a list of open charges, each with how it is paid (money / credits / perk), the expected net and an optional adjustment. The rule becomes "at least one visit or one charge" |
| Conflicts | The Ledger version includes open charges, so a concurrent "add InBody" gets 409 with the fresh state |
| Promotion date | An add-on's "visit date" is the clinic day it was added (decision 2 of rev 2.2, applied to add-ons) |
| Fee edit (requirement 2) | Exactly the 2b adjustment: typing a new fee records adjustment = price after discounts − the new fee, with the 20%-or-$25 cap, a reason code and an MFA admin above the cap. The list price is never edited |
| Payment reversals | Unchanged |
| Removing a line before check-out | Desk or admin; an append-only removal row, audited |
| Voiding a posted, unpaid add-on | New `ChargeVoid` row; the line then owes nothing. Desk on the same clinic day, MFA admin after (mirrors rev 2.2 decision 6). Visit charges stay non-voidable, as in 2b |
| Return of a paid product (2c-C) | Void plus release of what was paid on it, as a refund (with tender) or account credit — the patient's choice, like an overpayment. Reversing a payment that funded a voided-and-released line is refused; an admin handles that case |

Requirement 6 holds: the Ledger is one endpoint per patient, and add-ons are charges on that patient, so it is identical from
either visit, from patient search and from the new Ledger button. Open lines show in a separate **"Today, not checked out yet"**
box with their own subtotal; they join the balance only when posted.

**Ben's example**, at placeholder prices with no tax:

| Line | Amount |
|---|---|
| Manual Adjustment | $55.00 |
| Red Light | $55.00 |
| InBody (existing $55 price) | $55.00 |
| Magnesium glycinate | $35.00 |
| Vitamin D3 | $35.00 |
| **Total** | **$235.00** |

If the two supplements were taxable at, say, 8.025%, each would carry $2.81 of tax and the total would be $240.62. The $235
assumes no tax.

## 4. Sales tax

- **The rate lives in a `TaxRate` row** (code `SALES`, rate in thousandths of a percent — 5.5% = 5500). No rate is written into
  the code; an admin edits it on the catalog screen, audited. Each open line and charge keeps the rate it was added at, so an
  edit never changes a past charge. *As approved: 5.5%, products only; services are never taxed.*
- **Per line, in whole cents**: `tax = floor((taxable × rate + 50 000) / 100 000)`, where taxable = the line's net after
  discounts and adjustment. Halves round up, like the rest of the money math. A database check enforces the formula.
- **For the accountant to confirm**: per-line versus per-receipt rounding, and whether the clinic's own discounts reduce the
  taxable amount (the formula assumes they do).
- **Display**: a separate "Sales tax" row under the taxable line on the Ledger; a "Sales tax billed" column in the Accounting
  views and CSVs, never counted as revenue.

## 5. Discounts, promotions and credits per item

Each is configurable per item. Proposed defaults:

| | Add-on service (e.g. InBody) | Product *(as approved, rev 2.3)* |
|---|---|---|
| Member tier discount | Inherits the service's discount category | **Yes** when the product is marked eligible: the tier's product percentage (seeded 10 / 15 / 20) — the ONE supplements setting, which the *Supplements* service category also reads |
| Promotions | Yes, via the existing promotion–service link | **Yes**, via `PromotionProduct`; the better of tier and promotion, never both |
| Membership credits | The service's credit cost (InBody: as today) | **Never** (the database refuses it) |
| Perks | Yes (quarterly body composition) | No |
| Desk adjustment | Yes, same cap | Yes, same cap |
| Price above list | Admin (MFA) only, with a reason | Admin (MFA) only, with a reason |
| Sales tax | Never | 5.5% when the product is marked taxable |

## 6. Inventory

**Later.** Stock tracking needs receiving, counts, adjustments, shrinkage and an append-only stock-movement log — a phase of its
own, and not needed to sell a handful of items. For now: an active / out-of-stock switch that hides a button, and units sold per
product in Accounting. The data model leaves room for stock tracking without migrating past sales.

## 7. Accounting

- The revenue views split by line kind: **Visits / Add-on services / Products**, with products showing units, list, discounts,
  net and tax. The existing identity holds per row, with tax outside it.
- **Billed vs collected** gains a **"Tax billed"** column. Collected stays money in, tax included.
- **Tax is reported as billed** (when the sale happens). Splitting tax out of partial payments would need an allocation
  convention; if the accountant files on a cash basis, that is a decision to make now.
- **Review list**: voids and returns get their own subtotal kinds.

## 8. Permissions

| Action | Who |
|---|---|
| Add or remove open charges | Front desk, admin, and providers (for the patient of a visit they may document, before it is checked out) |
| Check charges out | Front desk, admin |
| Void a posted unpaid add-on | Desk on the same clinic day; MFA admin after |
| Return a paid product (2c-C) | Desk on the same clinic day; MFA admin after |
| Catalog, tax rates, add-on switch | Admin (MFA for price and tax changes), audited |
| Record a card on file | Front desk, admin |
| Revoke a card on file | Front desk, admin (patient request), audited |
| See card-on-file status | Front desk, admin; providers do not see it |

## 9. UI

- **Charges window**: a tab per button group (Services · Supplements · Other), each a grid of large buttons showing name and
  price, with a small "taxable" marker. A click adds one; another click adds another. A right-hand panel lists today's open lines
  with quantity +/−, remove, and a performer dropdown for services, then subtotal, tax and total. Search only once there are more
  than about 30 items.
- **Where the Charges button appears**: left of "Check out…" on the Front Desk card and its dialog; on the patient's Ledger (for a
  product-only sale); in the check-out window. Disabled on a walk-in with no patient record ("Link a patient first").
- **Check-out window bottom row**: Charges · Ledger · **Checkout** (primary style, in the middle, as requested) · Card on File ·
  Cancel. Wraps to two rows on a phone.
- **Ledger button**: opens the same Ledger stacked over the check-out window; on close, the check-out window reloads the Ledger
  and its version.
- **Card-on-file chip**: "Card on file · Visa ••4242 · exp 08/28" in the patient profile header and next to the tender choice in
  the check-out window; amber "Card on file expired" once expired.

## 10. Card on file

### 10a. Phase 2c-B: a record of a card held elsewhere

**Recording a card in the app does not save it anywhere.** The card must actually be saved in the clinic's terminal or
processor, which has to support saving cards — otherwise the badge promises something nobody can charge. So the feature stays
**off until the processor is named in settings**.

**Prompt**: after a successful Card or HSA/FSA payment, with no active card on file, the window asks "Does the patient want this
card kept on file?" If yes: (1) save it on the terminal first; (2) enter what the terminal shows, and tick the patient's consent.

**`CardOnFile` record** — append-only, Row Level Security on:

- Card details: brand (from a fixed list), last 4 (exactly 4 digits, `CHECK ~ '^[0-9]{4}$'`), expiry month (1–12) and year.
- Processor: name, from settings; optional reference or token.
- Consent and who: consent time and method (verbal / signed form), who recorded it, when.
- Safeguards: **no free-text field anywhere on the record**. The reference is refused if it contains any run of 12 or more
  digits, ignoring spaces and dashes — stricter than the existing `looksLikeCardNumber` check, because tokens are never long
  digit runs — in the app and by a database check. **No field exists for a full card number, CVV or track data.**

**Revoking**: a `CardOnFileRevocation` row with a reason (patient request, replaced, lost, other). Adding a new card revokes the
old one as "replaced" in the same transaction, so a patient has at most one active card. **Expiry is derived** from month and
year — no scheduled job.

**Audit**: ids only. Brand, last 4 and expiry never go into audit rows or logs.

**PCI scope**: a card's last 4 and expiry, without the full number, are not cardholder data that PCI DSS protects. The app stays
out of PCI scope as long as no field anywhere accepts a full number. The existing card-number refusal covers payment,
adjustment, reversal and refund notes, and extends to any new free-text field.

**Optional link**: `Payment.cardOnFileId`, recording which card a payment used.

### 10b. Later: a real processor integration (Stripe / Square / Clover) — not to be built now

- **How it would work**: an integrated terminal, or the processor's hosted card fields, so the full card number never touches
  our server. The app sends an amount and an idempotency key and gets back a payment id, brand and last 4. Card payments come
  from the processor's result instead of being typed. A saved card becomes the processor's own customer-and-card reference.
- **PCI scope**: typically the shortest self-assessment questionnaire (SAQ A for hosted fields; the P2PE or terminal-specific one
  for card-present). The processor's API key becomes a server secret.
- **Charging a saved card later, without the patient there**: the card networks' stored-credential rules require the patient's
  written authorization (agreement text, when it may be charged, notice). Refunds and disputes go through the processor's API.
  Signed, idempotent webhooks; payouts reconciled against `Payment` rows.
- **BAA**: HIPAA's §1179 exemption generally covers processing payments, and processors often do not sign BAAs. That holds only if
  nothing beyond the payment is sent: no service names or other clinical detail in descriptions or metadata, opaque ids only.
  Receipts or invoices hosted by the processor that list services would be PHI. Counsel to confirm; each vendor's position to be
  checked.
- **HSA/FSA on supplements**: supplements are generally not HSA/FSA-eligible without a letter of medical necessity, which matters
  if the desk records HSA/FSA as the tender for a product. The accountant to confirm.
- **Effort**: larger than 2c-B; it needs a processor account, sandbox keys and a test terminal.

## 11. Phases, migrations, tests, SPEC, effort

| Phase | Migrations | Contents |
|---|---|---|
| **2c-A** | `charges_catalog` (TaxRate, Product, `Service.offerAsAddOn`, `Service.taxRateId`); `charge_lines` (OpenCharge and its removal, the RevenueEvent fields with backfill, ChargeVoid, restated `RevenueEvent_consistent` and money guard) | Catalog screen; Charges window; check-out extension; fee edit; Ledger button; bottom row; Accounting split and tax; voids of unpaid add-on lines |
| **2c-B** | `card_on_file` (CardOnFile, CardOnFileRevocation, `Payment.cardOnFileId`) | Record, revoke, the post-payment prompt, the badges |
| **2c-C** | `charge_release` (new refund source and account-credit kind for voids; released amount on the void) | Returns and voids of paid lines |
| Later | — | Stock tracking; processor integration |

Every new table gets Row Level Security, append-only triggers where it holds history, one transaction per change, idempotency
keys, and audit rows with ids only.

**Test plan**

- **Tax**: boundaries (half-cent cases, 3-decimal rates, quantity > 1, after discounts and adjustment); the database check matches
  the code; rate snapshots unaffected by later edits.
- **Booking-free**: an add-on creates no booking; the booking-engine files stay at zero diff. A service that needs a note cannot
  be offered as an add-on.
- **Discounts and credits**: the per-item flags (no tier discount on a product unless in a category; no credits on products unless
  set); promotions on add-on services by the day added, including Chicago midnight and DST; the perk paying for an InBody add-on.
- **Check-out**: open lines become charges exactly once (a repeated request returns the stored answer; a concurrent add gets 409);
  a product-only sale works; oldest-first allocation across visits and add-ons; the balance always equals the sum of rows
  including tax; the Ledger is identical from every entry point.
- **Fee edit**: the cap at its boundary; a fee above list refused.
- **Voids**: same-day versus next-day permissions; a paid line cannot be voided before 2c-C.
- **Accounting**: the split and tax columns sum correctly; CSV totals; no patient named.
- **Card on file**: refuses 12-or-more-digit runs, a last 4 that is not 4 digits, a bad month; append-only; only one active card;
  expiry derived; card details never in audit or logs.
- **Matrix**: all six configurations, plus mutation checks on the tax formula, the net + tax balance, void permissions and the
  item flags.

**SPEC rev 2.3**: a "Charges: add-on services and products" section (the open → posted lifecycle, the void and return rules,
tax) and Chase's decisions as a table; card on file described as a record with no card data, with the processor prerequisite;
new assumptions for the defaults in §5.

**Effort**, relative to 2b (about 3,900 lines across 44 files, including tests and docs):

| Phase | Estimated size |
|---|---|
| 2c-A | ≈ 3,000–3,500 lines |
| 2c-B | ≈ 700–900 lines |
| 2c-C | ≈ 800–1,000 lines |
| Processor integration | Not sized until a processor is chosen |

## 12. Decisions (Chase, rev 2.3)

Each was an open question with a recommended default; the owner's answers are recorded in SPEC rev 2.3 and below.

1. **The product list, prices and button groups; add-on services.** *Decided:* placeholder products, clearly marked, until the
   real ones are chosen; an admin edits name, price, active, taxable and tier-discount eligibility on a catalog screen, audited.
   Every line snapshots its name and price when it is added. InBody is the body-composition service, offered as an add-on.
2. **Sales tax.** *Decided:* services never taxed; products at 5.5%, an admin-editable rate; on the line's net after discounts and
   promotions; per line in integer cents, halves up; shown separately on the Ledger, the receipt and in Accounting; not revenue.
3. **Tier discounts, promotions and member credits on products.** *Decided:* credits never on products; tier discount on products
   yes, a percentage per tier (Prevent 10 · Restore 15 · Optimize 20, from `membership.html`), admin-editable; promotions may target
   products, the better of tier and promotion, never both. InBody behaves exactly as a booked body-composition visit.
4. **Who may add charges, and the performer.** *Decided:* front desk, admins and providers (providers from their visit workspace);
   open charges removable by the same roles before check-out, audited; a charge added by anyone shows at the desk at once.
   Performer optional.
5. **Raising a fee above list.** *Decided:* admin only, with a required reason. The desk stays down-only within the cap.
6. **Returns and voids; when 2c-C ships.** *Decided:* 2c-C is not approved. In 2c-A an open line is removed before check-out; a
   posted charge is not voided.
7. **Card on file.** *Decided:* not approved (2c-B). The check-out window shows "Card on File" disabled, with a hint that it
   activates once a card processor is chosen.
8. **HSA/FSA for supplements.** *Decided:* allowed, no warning. Receipts and the Ledger itemize every product by name, with its tax.
