# Advertised promotions — design (rev 2.5, proposed)

**Status: DESIGNED, NOT APPROVED TO BUILD.** No code exists for this. Owner decisions on the open questions are recorded in §10.

Feature: show active promotions to patients — in the booking widget (`server/public/booking.js`) and as a small banner on the
marketing site's service pages (`main`, static HTML, nextwave-wellness.com behind Cloudflare), driven by the same data.

## Bottom line

- **No booking-engine file changes.** The widget only displays; the data comes from a new read-only route. `availability.ts`,
  `holds.ts`, `bookings.ts`, `lib/availability.ts`, `lib/time.ts` and `lib/scheduling.ts` are untouched (`lib/time.ts` is imported,
  read-only).
- **The real risk is staging vs production.** The only deployed app, `nextwave-scheduling.onrender.com`, is **staging**
  (`BOOKING_MODE=demo`, fake patients); its default CORS list already includes nextwave-wellness.com, and the "Book now" buttons on
  `main` already link to it. So "off until production exists" cannot rest on host names: **two independent switches**, one on the app
  and one on the site, must both be on before any banner appears.
- **Check-out stays authoritative.** The widget shows an *estimate* with the same rule check-out uses — the single best promotion OR
  the member tier discount, whichever is better, never both (SPEC rev 2.2, decision 1; `lib/moneyMath.ts` `betterOf`).

## 1. Admin control

Two columns on `Promotion` (additive migration):

| Field | Rule |
|---|---|
| `advertise Boolean @default(false)` | Publishes the promotion. **Refused for a product-only promotion**; a mixed one publishes its services only. |
| `publicHeadline String? @db.VarChar(60)` | **Required when `advertise` is on.** Plain text: trimmed, spaces collapsed, 3–60 characters, no `<` `>`, control characters or URLs. Always rendered with `textContent`. |

- The headline is a **name only** ("Red light week"). The "20% off Nov 16–22" part is **generated from the promotion's terms**, so the
  public text cannot contradict them. The internal `name` is never published.
- Both stay editable after a check-out has used the promotion: `nw_promotion_guard` freezes only kind, value, dates and covered
  services/products, so **no trigger change**.
- Admin → Promotions: an "Advertise on website" toggle, the headline field with a counter, and a preview line
  ("Red light week · 20% off Nov 16–22").
- Audited by the names of the fields changed, never their values (existing rule).

## 2. Public endpoint

`GET /api/public/promotions` — new file `src/routes/publicPromotions.ts`; clinic "today" from `clinicToday()` (`lib/time.ts`, read-only).

```json
{ "site": false, "today": "2026-11-12", "timezone": "America/Chicago",
  "promotions": [
    { "headline": "Red light week", "kind": "PERCENT", "value": 20,
      "startsOn": "2026-11-16", "endsOn": "2026-11-22", "phase": "upcoming",
      "services": [{ "id": "…", "slug": "red-light-therapy" }] } ] }
```

- Returns only promotions that are `advertise && active`, `endsOn >= today` and `startsOn <= today + 60 days` (clinic dates).
- Only the fields above: no promotion id, internal name, creator, products or patient data. A test asserts the exact key set.
- `value` is a percent (1–100) or cents (`FIXED_CENTS`). `phase` is `active` or `upcoming`, computed on the server.
- Sorted by promotion id, so the client's "first of the best" is the same choice `betterOf` makes.

**The app-side switch** — `ADVERTISE_PROMOTIONS = off | widget | site`, default **`off`**:

| Value | Behaviour |
|---|---|
| `off` | Always `{ site: false, promotions: [] }` — a normal 200, so callers simply show nothing. |
| `widget` | Real data, `site: false`. **Staging may run this** (decision 2). |
| `site` | `site: true`. **The app refuses to start unless `BOOKING_MODE=live`** (decision 3). Staging (`demo`) can never tell the site to show banners, even if the site's switch pointed at it. |

- **Caching:** `Cache-Control: public, max-age=300` (overriding the `/api` default `no-store`), plus a 60-second in-process memo cleared on
  any admin promotion write. Worst case a disabled or ended promotion shows for about 5 minutes; check-out ignores it either way.
- **Rate limiting:** `withinLimit` (`lib/rateWindow.ts`), about 60 per minute per IP → 429, which callers treat as silent failure. Per
  process, like the existing limiters.
- **CORS:** already global (`cors({ origin: config.corsOrigins, credentials: false })`, default origins the two nextwave-wellness.com
  hosts). GET only; no change.
- **Basic-auth gate:** add `/api/public/promotions` to `PUBLIC_API` in `middleware/demoGate.ts`.

## 3. Booking widget (`public/booking.js`)

- Fetches the feed once, same-origin, after a service is picked. Any failure → exactly today's behaviour.
- **Date strip:** open days a promotion covers get a small brass dot; `title` "20% off — Red light week"; the accessible label adds
  "promotion". Days are matched by the server's clinic-date strings, as open/closed already are. The widget shows anything that falls
  in its 6-week strip (decision 4).
- **Price on the selected-service card:**

| Situation | Shown |
|---|---|
| Picked day is covered | **$55 → $44 est.** · Red light week, 20% off |
| No day picked, or not covered, but a promotion falls in the strip | Red light week: 20% off visits Nov 16–22 |
| Fixed amount | $55 → $40 est. · $15 off (never below $0) |
| No single price (peptide therapy), or option not yet chosen | "20% off" / "$15 off", no arrow; once an option is chosen, the estimate uses its price |

- **Member line, always shown with a promotion** (approved, decision 6):

  > *Members: your membership discount is used instead when it saves you more — the two are never combined. Visits paid with
  > membership credits aren't affected by promotions. Final price is confirmed at check-out.*

- **Rounding:** halves up, as `percentOf`. The estimate math lives in a small shared `public/promoMath.js`, used by the widget and
  checked by server tests against `lib/moneyMath.ts`.

## 4. Marketing site (`main`)

- **Markup:** each of the 14 `services/*.html` pages gets a hidden placeholder just above `.service-price-row`:
  `<div class="promo-banner" data-promo-service="red-light-therapy" hidden></div>`. `Service.slug` equals the page filename for all
  14 (checked). Scripted edit with a `grep -c` check, per `CLAUDE.md`. Styled like the existing callout (`--sand` panel, brass rule).
- **The site-side switch** — one line at the top of `assets/script.js`:

  ```js
  var PROMO_FEED_URL = '';   // '' = OFF. Set to the PRODUCTION app's /api/public/promotions once it exists.
  ```

  **It stays empty** (decision 1: the production address is not decided; planned `app.nextwave-wellness.com`).
- **When set**, the script fetches with `credentials: 'omit'` and a 3-second `AbortController` timeout; requires a 200 JSON response
  with **`site === true`**; validates every field's type and length; fills only the matching page's banner with `textContent`:
  *"Red light week: 20% off Nov 16–22"*. An upcoming promotion appears **7 days before it starts** (decision 4): *"Starts Mon Nov 16."*
  Any failure → no banner, no console errors.
- **Why staging cannot leak onto the site:** the switch is empty by default; staging can never answer `site: true`; and as a third
  guard the script refuses the known staging host `nextwave-scheduling.onrender.com`.
- **Cloudflare:** the banner is fetched in the browser, so cached HTML never needs purging when a promotion changes. If the site ever
  adds a Content-Security-Policy, its `connect-src` must allow the production app.

## 5. Files that would change

| Area | Files |
|---|---|
| App server | `prisma/schema.prisma` + one additive migration; `routes/promotionsAdmin.ts` (two fields); **new** `routes/publicPromotions.ts`; `index.ts` (mount); `config.ts` (the switch and the start-up check); `middleware/demoGate.ts` (one path) |
| Staff app | `web/src/pages/AdminPromotions.tsx` |
| Widget | `public/booking.js`, `public/booking.css`, **new** `public/promoMath.js` |
| Marketing site (`main`, a separate commit) | `assets/script.js`, `assets/style.css`, the 14 `services/*.html` |
| **Booking engine** | **None** |

## 6. Edge cases

| Case | Handling |
|---|---|
| Promotion starts or ends inside the visible 6 weeks | Dots only on covered days; text uses explicit dates, never "this week"; the arrow price only when the picked day is covered. |
| Two promotions, same service and day | The largest saving for that price; ties in id order — the same choice as `betterOf`. |
| Fixed amount | Capped at the price; with no single price, "$15 off" only. |
| Product promotions | Never published; the toggle is refused for product-only promotions. |
| DST and Chicago day boundaries | Everything is a clinic `DATE`, never an instant; "today" comes from the server, not the browser. An 11:30 pm visit on the last day is covered, as at check-out. |
| Pre-existing widget quirk | The date strip starts at the **browser's** today, so a patient outside Chicago near midnight sees a strip shifted by a day. Not caused by this feature; flagged, not fixed. |
| Promotion edited or disabled after a patient saw it | Check-out uses the promotion as it is at check-out. The copy says "est." and "confirmed at check-out". **Honouring the shown price is desk discretion through the existing adjustment rules** (decision 5: up to 20% or $25; beyond that an admin). Snapshotting the estimate on the booking would change `bookings.ts` — not proposed. |
| Edits after a check-out used it | Value and dates are already frozen by `nw_promotion_guard`; a disabled promotion drops off within about 5 minutes. |
| Member discount is better / visit paid with credits | Covered by the member line (decision 6). |
| Feed down, slow, or rate-limited | No banner, no dots; list prices as today. |

## 7. Tests

- **Server** (`tests/public-promotions.test.ts`): which promotions are published (advertised, active, ended, beyond 60 days,
  product-only, mixed); the exact key set; the three switch values and the start-up refusal of `site` unless `BOOKING_MODE=live`; the
  Chicago end of day (late evening of `endsOn`, in UTC terms) and the 2033 DST days; the `Cache-Control` override of `no-store`; 429
  over the limit; CORS allowed for the site's origin and not another; reachable with the basic-auth gate on; admin headline required
  and validated, toggle refused for product-only, both fields editable after use, audit by field names only; shared vectors for the
  estimate math against `lib/moneyMath.ts`. Then all six test configurations on a quiet database.
- **Staff app:** headline validation and preview text (pure functions).
- **Widget and site** (no test harness): manual checklist — switch empty means no request at all; `site: false` shows nothing; timeout
  or malformed response shows nothing; one page at 1280, 1024 and 768px.

## 8. Effort

About **4 days**: schema and routes 1 · admin screen 0.5 · widget and estimate math 1 · marketing site 0.5 · tests and the matrix 1.

## 9. SPEC and docs (when built)

- `docs/SPEC.md`: a **rev 2.5 — advertised promotions** block — the decisions below, the endpoint contract, the two switches, the
  approved copy, "no booking-engine change".
- `docs/STAGING_CHECKLIST.md`: staging runs `ADVERTISE_PROMOTIONS=off` or `widget`, never `site`.
- `CLAUDE.md` on `main`: the `PROMO_FEED_URL` switch, the banner placeholder on all 14 service pages, and "a new service page needs the
  banner placeholder".
- SMS templates: untouched.

## 10. Owner decisions (recorded 2026-11-12)

| # | Question | Decision |
|---|---|---|
| 1 | Production app address | **Not yet decided** (planned `app.nextwave-wellness.com`). **`PROMO_FEED_URL` stays empty.** |
| 2 | Staging in `widget` mode | **Yes** — staging may run `ADVERTISE_PROMOTIONS=widget`. |
| 3 | Mode required for site banners | **`BOOKING_MODE=live` only** (not `beta`). |
| 4 | Upcoming lead time | **Site: 7 days before start. Widget: anything in its 6-week strip.** |
| 5 | Promotion disabled after a patient saw it | **Desk discretion via the existing adjustment rules.** |
| 6 | Copy | **Approved as proposed**, including that visits paid with membership credits aren't affected by promotions. |

**Not approved to build.** Separate from this feature: every "Book now" button on `main` points at the staging host today.
