# NextWave Wellness — Marketing Site

Live at **[nextwave-wellness.com](https://www.nextwave-wellness.com)**
Hosted on **Render**, auto-deploys on every push to `main`.
Repo: `github.com/StanHalpine/NextWave`

Plain HTML/CSS/JS — no framework, no build step, no dependencies. Any file can be edited directly and pushed; Render picks it up automatically.

---

## Structure

```
├── index.html          Home
├── services.html        Chiropractic / Functional Medicine / Longevity
├── membership.html      Tiers, pricing, credit value table
├── about.html            Mission statement, philosophy
├── contact.html          Appointment form + direct contact cards
└── assets/
    ├── style.css         Single shared stylesheet — all pages link to this
    ├── script.js         Shared JS (mobile nav, scroll reveal, horizon animation)
    └── img/
        ├── logo-horizontal-black.png   Header logo
        ├── logo-offset-white.png       Hero + footer logo
        ├── card-chiropractic.jpg       Duotone service photos (homepage cards)
        ├── card-functional-medicine.jpg
        ├── card-longevity.jpg
        └── lakefront-grounds.jpg       Real facility exterior photo
```

Editing `assets/style.css` or `assets/script.js` updates all five pages at once — they're not duplicated per-page.

---

## Design system

| Token | Hex | Use |
|---|---|---|
| `--ink` | `#1C2B2E` | Primary text, dark sections |
| `--sand` | `#EDE7DD` | Main background |
| `--paper` | `#F7F4EE` | Alternate section background |
| `--sage` / `--sage-deep` | `#7C8F7A` / `#5C6E5A` | Chiropractic accent |
| `--lake` / `--lake-deep` | `#4C6B72` / `#354F55` | Functional Medicine accent |
| `--brass` | `#B9A77C` | Signature accent — hairlines, taglines, highlighted tier |

**Typography:** Como (via Adobe Fonts/Typekit, kit `cgt8sod`) for display + body, falling back to Quicksand if the kit doesn't load. IBM Plex Mono for numbers, credits, hours, and eyebrow labels.

**Signature elements:**
- The horizon-line SVG (a single smooth wave, echoing the logo) divides sections in a few places.
- Stock/generic photography gets a duotone treatment matching its section's accent color (see the three service cards on the homepage). Real location/facility photos are kept close to true color instead — only lightly graded for cohesion, not duotoned, since authenticity matters more there than mood-setting.

---

## Contact form

The "Request an Appointment" form on `contact.html` submits via **Web3Forms** (no backend of our own). The access key is embedded directly in the form's hidden `access_key` input — this is safe to expose client-side, it's how Web3Forms is designed to work (the key is scoped to deliver to one inbox, not an account-wide credential).

To change which inbox receives submissions, generate a new key at [web3forms.com](https://web3forms.com) with the new email, then swap the `value` in the hidden `access_key` field across `contact.html`.

**Direct contact cards** (separate from the form) route via `mailto:` links:
- Front Desk (primary contact) → `frontdesk@nextwave-wellness.com`
- Dr. Chase L'Heureux, Chiropractor → `drchase@nextwave-wellness.com`
- Nurse Practitioner → `stanh@nextwave-wellness.com` *(placeholder until the NP is hired and named — see Open Items)*

---

## Deployment

- **Host:** Render (Static Site), connected directly to this GitHub repo
- **Build command:** none — plain static files
- **Publish directory:** repo root
- Every push to `main` triggers an automatic redeploy, live within 1-2 minutes
- Custom domain (`nextwave-wellness.com`) is connected in Render's dashboard with DNS pointed at Render

---

## Open items / known placeholders

- **Nurse Practitioner** — not yet hired/named. Update the "Nurse Practitioner" card on `contact.html` with a real name once known.
- **Membership pricing** — real dollar figures and features are in from the practice's outline, but worth a final confirmation pass before wide promotion.
- **Photography** — several sections (entrance, consultation suite, IV lounge, chiropractic adjustment room on the Services page) still use abstract gradient placeholders, not real photos. Swap these in the same way the homepage service cards and Lakefront Grounds photo were done (see `assets/img/`).
- **Member portal** (login, scheduling, credit balances, biomarker history) — not built. This site is marketing-only. Building this involves real PHI/HIPAA considerations — see the "Reach a decision" note below before starting that work.
- **Practice management platform** — research was done comparing Jane, Zenoti, WellnessLiving, Mindbody, Vagaro, and Prospera.ai for the eventual member/staff system; no platform has been chosen yet.

---

## A note on the member portal

Biomarker results and health history are PHI. Building member accounts, scheduling, and credit tracking isn't a simple extension of this marketing site — it likely requires HIPAA-compliant infrastructure from the ground up (encrypted storage, audit logs, BAAs with any vendor touching that data). For a single-location practice, buying an existing HIPAA-compliant platform (see the practice-management research above) is very likely more practical than building custom. Worth a short consult with a healthcare compliance attorney before committing to either path.
