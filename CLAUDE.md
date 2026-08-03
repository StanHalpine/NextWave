# NextWave Wellness — Project Notes

Static marketing site. Plain HTML/CSS/JS, no build step, no framework. Open any
`.html` directly in a browser to preview. Deployed at nextwave-wellness.com.

```
index.html  about.html  contact.html  membership.html  services.html
services/          14 service detail pages
assets/style.css   single stylesheet, all pages
assets/script.js   nav, scroll-reveal, dialogs
assets/img/
```

The practice is organized around **three disciplines** — Chiropractic,
Functional Medicine, Longevity. That split drives navigation, page grouping,
and color throughout.

## Conventions

### Every page shares a header/footer

The nav, submenu, and footer are duplicated in all 19 HTML files. There is no
templating. **Any nav or footer change touches all 19 files** — write a Python
script with a regex rather than editing by hand, then verify with a `grep -c`
that every file was hit. A silent partial match is the main failure mode here.

Root pages use `assets/…` and `services/…`; service pages use `../assets/…`
and `../services/…`. Scripted edits must preserve the `../` prefix.

### Discipline → color

| Discipline | `photo-panel` class | Gradient |
|---|---|---|
| Chiropractic | `sage` | `--sage` → `--sage-deep` → `--ink` |
| Functional Medicine | *(none — default)* | `--lake` → `--lake-deep` → `--ink` |
| Longevity | `brass` | `#D8C9A0` → `--brass` → `--ink-soft` |

### Service hero photos

Source PNGs are 2121×900 with **pre-faded transparent left/right edges**, so
they blend into the panel's gradient instead of being cropped hard. The panel
is 16:9 on mobile and 32:9 on desktop; the photo is sized by *height* and
centered, letting the gradient fill the sides on wide screens.

```html
<div class="photo-panel sage ratio-hero service-hero-photo reveal"
     style="background-image:url('../assets/img/Hero_Name.png'),
            linear-gradient(160deg, var(--sage) 0%, var(--sage-deep) 45%, var(--ink) 100%);
            background-repeat:no-repeat, no-repeat;
            background-position:center, center;
            background-size:auto 100%, cover;">
  <span class="frame-tag">Room Name</span>
</div>
```

Swap the gradient to match the discipline. Never change the panel's
dimensions to fit an image — crop inside the existing box.

### Service page structure

```
hero photo → page-banner (crumb, kicker, h1, intro)
→ horizon divider → body copy + pricing + CTAs
→ [optional] Learn More section
→ membership CTA (section-dark)
```

**Pricing** sits directly above the CTA buttons, in
`.service-price.service-price-row`: `.service-price-amount` ($55),
`.service-price-note` (what it covers), `.service-price-badge` (member
discount). Use `.service-price-tiers` only for genuine multi-tier pricing
(hyperbaric 60/90 min). When price varies, put a `.service-price-note` alone —
see peptide therapy.

**Learn More** sections use `.learn-more-intro` (eyebrow + h2 + framing
paragraph) then `.learn-more-body` (`h3` subsections, `.category-list`
bullets; `h4` for sub-groups within a list, as on hormone optimization), then
placeholder `.testimonial-grid` and `.learn-more-media` blocks.

Copy comes from the user verbatim — reflow it into this structure, don't
rewrite it.

### Card grids + lightboxes

Two variants of the same pattern, both using native `<dialog>`:

- `.shot-card` / `.shot-dialog` — vitamin shots. Has a product photo.
- `.test-card` / `.test-dialog` — lab panels. Text-only, plus a one-line
  description; the dialog scrolls internally for long content. Each card
  carries its own Learn more + Book now pair in `.test-card-actions`, since
  booking only makes sense once a specific panel is chosen — which is why
  biomarker-testing has no page-level Book now.

**Button pair styling** (identical for both card types):

```html
<div class="test-card-actions">
  <button type="button" class="btn btn-ghost test-card-cta" data-dialog-target="id">Learn more</button>
  <span class="btn btn-primary test-card-cta btn-disabled" aria-disabled="true">Book now</span>
</div>
```

CSS: `.test-card-actions` (and `.shot-card-actions` — same styles) has `display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; margin-top: 18px;` with `.test-card-cta` as `padding: 10px 20px; font-size: 13px; cursor: pointer;` — allows buttons to wrap on mobile while keeping equal sizing.

Wiring is generic and lives in `script.js`: a button carries
`data-dialog-target="<dialog-id>"`, the close button carries
`data-dialog-close`. Backdrop click and Escape also close. Reuse this for any
future multi-item service.

**Every `.test-dialog` body follows the same three sections**, in order:

1. `<h4>What it is</h4>` — what the test is and does, one paragraph.
2. A details heading that varies by panel (`Included markers`, `What the
   panel reveals`, `How to read a result`) — the clinical specifics.
3. `<div class="test-dialog-benefit">` — who benefits and why it matters.
   Contains an `.eyebrow` ("Why it matters"), an `h4`, a `.category-list` of
   candidate types, and closes with a single `<p class="test-dialog-urge">`.

Section 3 is deliberately styled apart — `--sand` panel, brass top rule, and
a brass left rule on the urge line — so the persuasive copy reads as a
callout rather than more body text. Each test card also carries a one-line
"Best for:" under its price that previews this section.

**Membership tier dialogs** (`membership.html`, `#tier-prevent|restore|optimize`)
reuse `.test-dialog` / `.test-dialog-benefit` verbatim, opened by a "Learn
more" button placed in a `.tier-card-actions` pair next to each "Choose …"
button. The three-section pattern adapts to: (1) `What it is` — who the tier
is for, (2) `What's included` — each perk with its walk-in dollar value
spelled out, (3) `.test-dialog-benefit` "The math" — a concrete sample
month/year showing service value against the monthly dues, closing with a
`.test-dialog-urge` line. Keep the dollar figures tied to real prices on the
service pages (not the `credit-table` on this same page, which uses older
IV naming) — re-derive them if pricing changes.

### Logo usage

Three logo assets, each for a different context:

- `Logo_Horizontal.png` — nav bar, desktop only (`.logo-full`).
- `Waves_2B4C5E.png` — nav bar, mobile only (`.logo-icon`, wave mark alone,
  no text). The two swap at the same 860px breakpoint the mobile nav uses:
  `.logo-full { display:none }` / `.logo-icon { display:block }` under
  `@media (max-width: 860px)`.
- `Logo-Offset-2B4C5E.png` — stacked mark (icon over wordmark), used inside
  page content, in two treatments:
  - **Centered hero** (`.membership-logo`, `clamp(200px, 24vw, 320px)`) —
    home, membership, and about pages. Add `page-banner-centered` to
    `.page-banner` to center the logo, eyebrow, and h1 together; content
    below the horizon divider stays left-justified as normal. `h1` also
    picks up brand teal (`#2B4C5E`) from this class.
  - **Left-justified inline** (`.service-logo`, `clamp(216px, 24vw, 312px)`)
    — contact.html only, above the eyebrow in a normal (non-centered)
    `.page-banner`. Not used on the 14 service detail pages — tried once,
    reverted; those pages stay logo-free.

### PWA / app icon

`manifest.json` (root) + `<link rel="apple-touch-icon" href=".../AppIcon_180.png">`
plus `apple-mobile-web-app-*` meta tags are on all 19 pages, so any new page
needs the same block copied from an existing `<head>` (mind the `../` prefix
on service pages).

### Contact form

`contact.html` submits to Web3Forms. The "Interested in" select is prefilled
from `?interest=<value>`.

**Each service page passes its own slug, and the slug is the page filename
minus `.html`** (`biomarker-testing`, `spinal-xrays`, …). Front desk needs the
exact service, not just the discipline. The select is grouped by discipline
with a "not sure which yet" catch-all per group, plus the membership tiers
(`membership-prevent|restore|optimize`).

**Adding a service page means adding a matching `<option>`** — a slug with no
option silently falls back to the first entry, which looks like it worked. The
cross-check is: every `?interest=` value in the repo must exist as an option
value in `contact.html`.

Inline JS also writes the selected label into the hidden `subject` field, so
the notification email arrives as "Appointment request: Biomarker Testing".

When any membership value is selected, inline JS swaps the page title, the
subhead, and the email subject line to membership-request framing. This is a
placeholder until real signup/billing exists — the copy promises a phone or
email follow-up based on the form's "Preferred contact method" field.

### Copy notes

- Membership CTA on service detail pages reads "One credit balance covers
  every service." On `index.html` and `services.html` — where the three
  disciplines are visible nearby — it stays "…covers all three."
- "Home" is in the mobile hamburger only; hidden on desktop via
  `.nav-item-home` (the logo goes home there).
- The "Become a Member" button always goes to `membership.html`, never
  straight to the contact form.

## Verifying changes

Screenshots in the in-app browser have been unreliable this project — the pane
serves stale CSS and sometimes drops `file://` query strings. Two workarounds:

- Cache-bust before screenshotting:
  `link.href = '../assets/style.css?v=' + Date.now()`
- Scroll-reveal hides content until scrolled; force it with
  `document.querySelectorAll('.reveal').forEach(el => el.classList.add('is-visible'))`

When a screenshot looks wrong, confirm against the DOM before assuming the
code is broken.

## Open items

- **Placeholders still to fill**: testimonial quotes and photo/video blocks in
  every Learn More section (9 pages); the 6 vitamin shot card photos;
  `Photography placeholder` panels on about/contact/services.
- **"Book now" buttons are disabled** (`.btn-disabled`, `aria-disabled`)
  pending a booking system. "Request a consultation" is the live path.
  Exception: functional-medicine-consult and spinal-postural-exam have
  no Book now at all — the two read as redundant on a page that *is* the
  consult/assessment. When booking ships, those pages should get a real Book
  now for picking a time.
- **IV menu** is marked "Coming Soon" — single $185 price until the full menu
  is defined.
- **Unused images** safe to delete: `ChiroHero.png` (duplicate of
  `Hero_ManualAdjustment.png`), `favicon.png` and `logo-horizontal-black.png`
  (superseded by the `_2B4C5E` / `Logo_Horizontal` versions),
  `logo-stacked-white.png`.
- Member portal is referenced as "coming soon" in the footer and on contact.
