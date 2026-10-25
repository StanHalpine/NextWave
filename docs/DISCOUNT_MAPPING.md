# Member discounts — what is enforced, and where `membership.html` disagrees

> **Status (2026-10-11): approved and enabled.** Decision: *"Use the clean per-tier mapping. Where the published copy conflicts with it, the
> tier percentage wins, including X-rays — apply the tier's rate, not a separate 20% or 25%. Perks stay off."*
>
> **How I read "the clean per-tier mapping"** (please check this one line): **one rate per tier — Prevent 10%, Restore 15%, Optimize 20%** — the only
> tiered rate `membership.html` publishes (its supplements line), applied to **every** discounted category, X-rays included. If you meant something
> else (for example X-rays at a flat 20% as published), say so: it is a two-number change on the admin screen, and §1 and §2 below are the only
> parts of this page that would change.

## 1. What is enforced now

| Category | Services in it | Prevent | Restore | Optimize |
|---|---|---|---|---|
| **Spinal X-rays** | Spinal X-Rays ($250.00) | **10%** | **15%** | **20%** |
| **Supplements** | Supplementation (no set price: the desk types the list price) — *and, since rev 2.3, every retail product marked eligible* | **10%** | **15%** | **20%** |
| **Special services** | *none yet* — no such service exists; the category is ready, and discounts nothing today | **10%** | **15%** | **20%** |

Nothing else is discounted: no other service is in a category. **Perks are off** (every perk counter is switched off and nothing offers or counts them).

**How a discount works** (unchanged, tested):
- It applies only when an **active** member pays **cash**. A visit paid with **credits** or a **perk** is never discounted; a **paused** or cancelled member and a **non-member** pay list price.
- The percent is the member's **tier's** percent for the **service's category**, off the **list** price, to the cent with halves **up** (15% of $19.99 = $3.00). A service is in one category at most.
- The desk is shown **list − discount = net** before confirming, and the server refuses the check-out if its own figure differs from the one shown.
- Every check-out records the list price, the percent, the category, the discount and the net (Accounting shows them).

**Worked examples** (a spinal X-ray, $250.00, paid in cash): Prevent **$25.00** off → **$225.00** · Restore **$37.50** off → **$212.50** · Optimize **$50.00** off → **$200.00**. Supplementation at a typed $19.99: Prevent $2.00 off · Restore $3.00 off · Optimize $4.00 off.

**Supplements: one setting (rev 2.3).** Retail products are discounted per tier too, and the supplements percentages live in **one
place: Admin → Product catalog → *Member discount on products*** (`PlanProductDiscount`, seeded Prevent 10 · Restore 15 · Optimize 20 from
`membership.html` lines 178, 209, 241 and 301–302). The *Supplements* service category reads that setting — its own per-tier rows were
retired by migration `20261025110000_quantity_and_supplements` and cannot be set on the category screen, which shows the shared values
read-only — so the Supplementation service and supplement products always get the same rate. The other categories are unchanged.

**Where it is entered.** In **your dev database** — the only database that exists — through the same operations Admin → Memberships → *Member discounts by service category*
uses (audited: 8 rows, actor `system:apply-discount-table`). **A new database starts with no discounts**: on staging and production run
`npm run discounts:apply` once (it only ever adds, so it is safe to run twice and never overwrites an edit), or enter the table above on the admin screen. The staging
checklist has the step. After that, **the admin screen is where to change anything**.

## 2. Where `membership.html` now disagrees with what is enforced

Line numbers are in `membership.html` as it stands (the cards, the three "Learn more" dialogs, the credit table, and the lower sections).

### 2.1 Discount percentages

| # | What the page says (and where) | What is enforced | Disagree? |
|---|---|---|---|
| D1 | **"20% off spinal X-rays"** — in all three tier dialogs (lines **178, 209, 241**) and the *Imaging* tile, "20% off spinal X-rays — At every membership level" (lines **280–281**) | **Prevent 10%, Restore 15%, Optimize 20%** | **Yes, for Prevent (10 points less than published) and Restore (5 points less).** Optimize agrees. "At every membership level" is false: the rate depends on the tier |
| D2 | **"10% off special services"** — all three dialogs (**178, 209, 241**) and the *Special Services* tile, "At every membership level" (line **291**) | Category exists at 10 / 15 / 20% but **has no services, so nothing is discounted today** | **Yes — the promised 10% is not delivered at all today.** If a service is later put in the category: Prevent 10% agrees; **Restore 15% and Optimize 20% are more than published**; "at every membership level" is false |
| D3 | **"10% off off-menu package pricing"** — all three dialogs and the *Packages* tile, "At every membership level" (line **296**) | **Not enforced.** There is no discount; packages are priced by hand and are not in the system's catalogue | **Yes — published, not delivered** |
| D4 | **"20% off additional Wellness Credits"** — all three dialogs, the *Credits* tile "Go beyond your monthly balance without paying full price" (line **286**), and the credit-table footnote "Additional Wellness Credits are available to members at 20% off" (line **268**) | **Not enforced.** The system has no way to *sell* extra credits (no price, no purchase, no ledger entry for one) | **Yes — published, not delivered** |
| D5 | **"10% / 15% / 20% off supplements — Prevent 10%, Restore 15%, Optimize 20%"** — dialogs (lines **178, 209, 241**: 10% / 15% / 20%) and the *Supplements* tile (lines **301–302**) | **Prevent 10%, Restore 15%, Optimize 20%** on the *Supplementation* service **and on retail products** marked eligible (rev 2.3), from one setting: Admin → Product catalog → *Member discount on products* | **No — agrees.** Retail supplements sold at the desk (the Charges window) are discounted per tier for an active member paying in money; a promotion on the product applies instead when it is better — never both. Membership credits never pay for a product |
| D6 | Every "Member-exclusive savings" line states the discount **without conditions** | It applies **only when an active member pays cash**; credit-paid and perk visits, paused members and non-members get none | **Unstated limit** (not a contradiction, but the copy over-promises). Worth a footnote: "applies to services paid in cash by active members" |

*What the page would say if it matched:* X-rays — "10% / 15% / 20% off spinal X-rays (Prevent / Restore / Optimize)"; supplements as now; special services, packages and additional credits removed until they exist.

### 2.2 Perks (all switched off — nothing in the system gives, counts or limits them)

| # | What the page lists (lines) | Tier | What is enforced |
|---|---|---|---|
| P1 | **"1 monthly vitamin shot"** (108, 124; 176, 203) | Prevent, Restore | **Nothing.** The counter exists (1 a month) but is **off**; check-out will not offer it |
| P2 | **"1 monthly IV drip"** (144; 234) | Optimize | Same: counter exists, **off** |
| P3 | **"Quarterly body composition analysis"** (109, 128, 148; 177, 207, 238) | all three | Same: counter exists (1 a quarter), **off** |
| P4 | **"1 guest pass per quarter"** (129; 208) · **"2 guest passes per quarter"** (150; 240) | Restore · Optimize | Counters exist (Restore 1, Optimize 2, Prevent 0), **off**; a guest pass is used by hand |
| P5 | **"Annual longevity biomarker assessment"** (125, 145; 204, 235) | Restore, Optimize | **No counter exists at all** — not tracked |
| P6 | **"Quarterly 1:1 provider consultation & wellness planning"** (126, 146; 205, 236) | Restore, Optimize | **No counter exists at all** — not tracked |
| P7 | **"Peptide & hormone optimization access"** (127, 147; 206, 237) | Restore, Optimize | Not something the system can count or enforce (a clinical judgement, not an entitlement) |
| P8 | **"Direct provider messaging"** (149; 239) | Optimize | **Not built** — the system has no member-to-provider messaging |

So **every perk the page promises is currently a promise only**. When you want any switched on, give me the quantities per tier and which services redeem each; P5–P8 would need new counters or features.

### 2.3 Credits and dues — where the page agrees, and the one place it does not

| What the page says | Enforced | |
|---|---|---|
| 4 / 6 / 8 Wellness Credits a month (107, 123, 143) | Prevent 4 · Restore 6 · Optimize 8 | Agrees |
| Credits roll over up to **90 days** (line 268, and "How Credits Work") | 90-day lots, oldest used first | Agrees |
| Credit costs: Adjustment 2, Red Light 2, Hyperbaric 60 min 4, 90 min 6, Vitamin Shot 2, IV Drip 6 | The same, exactly | Agrees |
| **$99 / $199 / $299** a month | The tiers' dues, billed monthly with the credits (Accounting shows them as their own line) | Agrees (billed, not collected) |
| **"Your credits apply across chiropractic, functional medicine, and longevity"** (line **318**) | Only a service with a credit cost can be paid in credits: chiropractic adjustment, red light, hyperbaric, vitamin shot and IV. **No functional-medicine service has a credit cost** (consult, biomarker testing, hormone optimization, body composition, supplementation, wellness planning), nor do peptide therapy, the spinal exam or X-rays | **Yes** — credits cannot be used for functional medicine |
| "Approximate monthly value: $183+ / $347+ / $532+" (183, 214, 246) | Not computed or checked by anything | Marketing figures; unaffected by the discounts above (X-rays at the tier rate lowers the X-ray part of Prevent's and Restore's value) |

## 3. The service pages (not `membership.html`, but customers read them too)

These claims are on the service pages and in the seeded booking text. **None is enforced** — each would need its own category, and none was in the approved table. The tier percentage applies instead.

| Page | What it says | Enforced |
|---|---|---|
| Spinal X-Rays | "Members save **25%**" | 10 / 15 / 20% by tier (table above) |
| Manual Adjustment, Red Light, Hyperbaric Oxygen (60 and 90 min), Hormone Optimization | "Members save 25%" | **No discount** (not in a category) |
| IV Therapy | "Prevent & Restore members save 25%"; "2 a month **included** with Optimize" — and the booking app's own price note says the same | **No discount**; the IV perk is off, and `membership.html` gives Optimize **1** IV a month, not 2 |
| Vitamin Shots | "Restore and Optimize members save 25%"; "1 a month **included** with Prevent" | **No discount**; the page and `membership.html` disagree on which tiers get the monthly shot (`membership.html`: Prevent **and** Restore) |
| Biomarker Testing | Baseline $225 "included in **Prevent and Optimize**; Restore saves 25%" · Food Sensitivity "members save 25%" · Total Toxin, Gut Health, Galleri "members save 10%" | **No discount**; `membership.html` puts the annual biomarker assessment in **Restore and Optimize**, not Prevent |
| Body Composition; Functional Medicine Consult | "Members: included ($0)" | **No discount, no perk**; `membership.html` lists body composition quarterly for all three tiers and the consultation quarterly for Restore and Optimize only |

## 4. What the model cannot do

1. **One percentage per tier per category**, off the list price: no "25% but 10% if …", no quantity breaks, no time-of-day rates.
2. ~~**Retail supplements** — only the Supplementation *service* (D5).~~ *Done in rev 2.3:* retail products are discounted per tier (the one setting
   above); see `docs/CHARGES_DESIGN.md`.
3. **Off-menu packages** (D3) and **additional Wellness Credits** (D4): no catalogue item to put in a category, and no way to sell a credit.
4. A member who pays by **credits** gets no cash discount; a cheaper credit cost for members would be a different rule.

## 5. History

The first version of this page was a *proposal* with five conflicts between `membership.html` and the service pages (X-rays 20% vs 25%, IV and vitamin-shot quantities, which tiers include the Baseline panel, "included ($0)" services). Your decision settled the percentages by making the tier's rate win; the perk and
service-page conflicts are listed above (§2.2, §3) because perks are off and the service pages' claims are not enforced.
