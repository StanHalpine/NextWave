# Member discounts — proposed mapping (awaiting your approval)

> **Status (2026-10-11): still awaiting your approval; nothing is enabled.** The Phase 5 approval message said *"Discount table:
> [approved as written / or list corrections]. Enable discounts per that table"* — the choice between the two was left in the
> brackets, so I did not guess one. Tell me **"approved as written"** or give the corrections (and settle X-rays at 20% or 25%, §C1),
> and I will enter the categories and percentages. Until then every member pays list price in cash, and perks stay off.

**Nothing is enabled.** The system now stores a discount as **a percentage per tier per service category**,
editable by an admin (Admin → Memberships → *Member discounts by service category*), but **there are no
categories, no service is in one, and no tier has a percentage** until you approve this table. Until then every
member pays list price in cash, exactly as before. Perks stay off.

This document does one thing: it derives the mapping from the **published copy** — `membership.html` first,
as you asked — and lists everything else the site says about member pricing, so you can see where the pages
disagree *before* a customer notices at the desk.

## How a discount works (so the table below reads right)

- It applies **only when an active member pays cash.** Credits and perks are never discounted — a visit paid
  with credits or an included perk records `$0` and no discount.
- It is a **whole percent of the list price**, rounded to the cent with halves up (15% of $19.99 = $3.00).
- The percent is the member's **tier's** percent for the **service's category**. A service is in **one category at
  most**; a service in none is never discounted; a category can be switched off; a tier with no percent for a
  category gets 0%.
- A service with no set price (supplementation, peptide therapy): the desk types the **list** price and the
  discount comes off it. The desk is shown list − discount = net before confirming.
- Every check-out records list price, discount percent, the category, the discount and the net.

## A. What `membership.html` publishes — the proposed mapping

Every tier's page and the "Member-Exclusive Savings" section list these five items:

| # | Category (proposed name) | Services in it today | Prevent | Restore | Optimize | `membership.html` says | Can it be applied? |
|---|---|---|---|---|---|---|---|
| 1 | **Spinal X-rays** | Spinal X-Rays | **20%** | **20%** | **20%** | "20% off spinal X-rays" (all three tiers) | **Yes** — but see conflict C1 |
| 2 | **Supplements** | Supplementation | **10%** | **15%** | **20%** | "10% / 15% / 20% off supplements" ("Prevent 10%, Restore 15%, Optimize 20%") | **Yes**, for the Supplementation *service*. There is no product catalogue, so retail products are not covered (§D2) |
| 3 | **Special services** | *none* — the services page says "Special services in development" | **10%** | **10%** | **10%** | "10% off special services" (all tiers) | **Not yet** — no such service exists. I would create the category empty, so it is ready when they do |
| 4 | *Off-menu package pricing* | — | 10% | 10% | 10% | "10% off off-menu package pricing" | **No** — packages are custom and priced by hand; there is no catalogue item to put in a category (§D3) |
| 5 | *Additional Wellness Credits* | — | 20% | 20% | 20% | "20% off additional Wellness Credits" | **No** — the system has no way to *sell* extra credits (no price, no purchase; Phase 3 limitation, SPEC A-10) |

So **rows 1–3 are what I would enter** (three categories; row 3 empty for now). Rows 4 and 5 are published
promises the system cannot honour at check-out today; I list them so that is a decision, not a surprise.

## B. Other member claims on the site — **not** in the mapping above

The service pages carry member pricing of their own. None of it is in `membership.html`'s list, and some
contradicts it. **I have not put any of it in the proposal**; each is a decision for you.

| Page | What it says | Tiers | Against `membership.html` |
|---|---|---|---|
| **Spinal X-Rays** | "Members save 25%" | all | **Conflict C1:** `membership.html` says **20%** |
| Manual Adjustment | "Members save 25%" | all | Not mentioned there. Adjustments cost 2 credits; this is the *cash* price |
| Red Light Therapy | "Members save 25%" | all | Not mentioned there |
| Hyperbaric Oxygen Therapy | "Members save 25%" (60 and 90 min) | all | Not mentioned there |
| Hormone Optimization | "Members save 25%" | all | Not mentioned there |
| IV Therapy | "Prevent & Restore members save 25%"; 2 a month **included** with Optimize | Prevent, Restore | `membership.html` gives Optimize **1** IV a month (not 2) — **Conflict C2** |
| Vitamin Shots | "Restore and Optimize members save 25% on every shot"; 1 a month **included** with Prevent | Restore, Optimize | `membership.html` gives **Prevent and Restore** a monthly shot, and Optimize an IV — **Conflict C3** |
| Biomarker Testing — *Baseline* ($225) | "Included in Prevent and Optimize memberships. Restore members save 25%." | all | `membership.html`: the annual biomarker assessment is in **Restore and Optimize**, not Prevent — **Conflict C4** |
| Biomarker Testing — *Food Sensitivity* ($350) | "Members save 25%" | all | Not mentioned there |
| Biomarker Testing — *Total Toxin* ($900), *Gut Health* ($900), *Galleri* ($1,050) | "Members save 10%" | all | Not mentioned there |
| Body Composition; Functional Medicine Consult | "Members: included ($0)" | all | Body composition is a quarterly perk in `membership.html`; the consult is "quarterly 1:1 provider consultation" for Restore and Optimize only — **Conflict C5** |

The booking app's seed data copied one of these (IV Therapy's price note: "Members save 25%. Two per month
included with Optimize."), so the desk would see it too.

**If you want the 25% claims to be real**, they would be more categories: e.g. *Chiropractic adjustments, red
light and hyperbaric (25%)*, *Hormone optimization (25%)*, *IV (Prevent, Restore 25%)*, *Vitamin shots
(Restore, Optimize 25%)*, *Food sensitivity (25%)*, *Other lab panels (10%)*. The model handles all of them;
what I cannot do is choose between the pages for you.

## C. The conflicts, in one list

| | Conflict | The two sources | What I need |
|---|---|---|---|
| **C1** | X-ray discount | `membership.html` 20% · X-ray page 25% | Which number is right? I proposed **20%** because you pointed me at `membership.html` |
| **C2** | IV drips included | `membership.html` Optimize: 1 / month · IV page: 2 / month | Perk quantity (perks are still off) |
| **C3** | Vitamin shots | `membership.html` Prevent **and** Restore: 1 / month · shots page: Prevent 1 / month, Restore saves 25% | Perk mapping and the Restore discount |
| **C4** | Baseline panel | `membership.html` Restore + Optimize · panel page: Prevent + Optimize | Which tiers include it |
| **C5** | "Included ($0)" services | consult and body composition pages say members get them free | Which tiers, and how often (perk, or credits?) |

## D. Things this model cannot do (and why)

1. **One percentage per tier per category**, off the list price. It cannot express "25% off, but only 10% if the
   member also…", tiered by quantity, or a different percent by *time of day*.
2. **"Supplements" as retail products.** The only supplement the system knows is the *Supplementation* service
   (no set price). If supplements are sold as products at the desk, they need to be entered as a service with
   a price to be discounted.
3. **"Off-menu package pricing"** is by definition not on the menu: the desk would have to record it as a
   service with a typed list price in the category — which works only if you make a "Package" service.
4. **Additional Wellness Credits.** Selling credits is a different feature (price, payment, a ledger entry).
   Say if you want it; it was not in any phase.
5. A member who pays by **credits** gets no cash discount (there is no cash). If you would rather a credit cost
   less for a member, that is a different rule.

## E. What I need from you

1. **Approve or correct Table A** — three categories and their percentages. In particular: X-rays **20 or 25%**.
2. Is "special services" meant to cover something that exists now (hyperbaric? red light?), or only future
   services? (If an existing service, name it.)
3. Which of the **Table B** 25% / 10% claims are real? Each one you confirm is one more category.
4. The conflicts **C2–C5** (they are about perks, which stay off, but the pages are live today).
5. Whether the pages or `membership.html` should change to agree, once you have decided.

## F. How it will be entered, once you approve

On **Admin → Memberships → Member discounts by service category**: *Add category*, tick its services, type each
tier's percentage, *Save* — each change is audited with its before and after, and takes effect at the next
check-out. I can instead enter them for you with a script that makes the same audited changes. Either way
nothing moves until you say so.
