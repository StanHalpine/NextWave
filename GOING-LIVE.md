# NextWave Scheduling — Launch Readiness

What stands between the current demo and taking real patient bookings.
Written against a ~3-month runway (practice opens once the building is done).

**This is an engineering inventory, not legal advice.** Section D in particular
needs a healthcare attorney or compliance consultant. I can build every
technical control listed here; I cannot tell you that you are compliant.

---

## 0. Answer this first — it changes everything below

**Is the practice a HIPAA covered entity?**

HIPAA applies to a healthcare provider only if they transmit health
information electronically in connection with a **HIPAA-covered transaction** —
chiefly insurance claims, eligibility checks, and benefit coordination.

A **cash-pay-only** practice that never bills insurance electronically is
often *not* a covered entity, and HIPAA's requirements may not attach at all.
NextWave's public pricing ($55 adjustment, membership tiers, "walk-in rate")
reads cash-pay, which makes this a live question rather than an academic one.

This matters enormously for scope:

| | Covered entity | Not a covered entity |
|---|---|---|
| HIPAA Security Rule | mandatory | does not apply |
| BAAs with vendors | mandatory | not required |
| Render HIPAA workspace | required (+20% cost) | optional |
| State privacy law | still applies | **still applies** |
| Duty of care to patients | yes | yes |

**Even if HIPAA does not apply, do not treat this as "no rules."** State
medical-privacy and data-breach statutes apply regardless, patients expect
confidentiality, and clinical records carry professional obligations
independent of federal law. Most of Section A is what you would want anyway.

**Action:** ask your attorney whether the practice will be a covered entity.
Do this early — it determines whether Section B costs you 20% more, and
whether Section D is a legal requirement or a best practice.

---

## A. Application work — I can build all of this

Ordered by dependency, not importance. Item 1 gates several others.

### A1. Per-user staff authentication — **blocking**

Today every staff action authenticates with **one shared token**. Consequences:

- A clinical note records *which staff id was claimed*, not who actually wrote
  it. Anyone with the token can write as any provider.
- No way to revoke one person's access without changing everyone's.
- No record of who viewed a patient record.

Needs: a `StaffAccount` model (separate from `Staff` — a receptionist needs a
login but is not a bookable provider), Argon2id password hashing, server-side
sessions in an httpOnly cookie (not `localStorage`, which any XSS can read),
login rate limiting, idle timeout, and `VisitNote.authorId` sourced from the
session rather than the request body.

*Currently tracked as spec §7.5 / §8.4.*

### A2. Audit logging — **blocking if covered entity**

HIPAA §164.312(b) requires recording access to PHI. **Reads, not just writes** —
opening a patient history is a disclosure and must be logged.

Needs an `AuditEvent` model (actor, action, target, timestamp, IP) written on
every PHI access, plus a way for staff to review it. Cannot be backfilled;
access that happened unlogged is gone.

### A3. Automatic logoff — §164.312(a)(2)(iii)

A front desk screen in a lobby is a PHI exposure. Session idle timeout plus a
client-side lock. Small once A1 exists.

### A4. Role-based access / minimum necessary

Front desk sees the schedule but not clinical notes; providers see notes.
Right now anyone with the token sees everything. Depends on A1.

### A5. Encryption at rest

Render encrypts datastores at rest on HIPAA-enabled workspaces. Verify this is
actually on for your instance rather than assumed. TLS in transit is already
handled by Render.

### A6. Backup & recovery — §164.308(a)(7)

Free-tier Postgres has no meaningful backup story. Needs point-in-time recovery
on a paid plan, plus one **tested** restore. An untested backup is a guess.

### A7. Data retention & disposal

How long are records kept, and what happens at the end? State law usually sets
a minimum for medical records (often 6–10 years; longer for minors). Currently
nothing is ever deleted and nothing expires.

### A8. Patient rights plumbing

If a covered entity: patients can request a copy of their record, request
amendments, and receive an accounting of disclosures. The amend-only
`VisitNote` design already supports amendment history; export and disclosure
accounting are not built.

### A9. Breach detection

Alerting on anomalous access — bulk record reads, off-hours access, repeated
auth failures. Depends on A2.

---

## B. Infrastructure — you own these, I can prepare configs

### B1. Render HIPAA workspace — if covered entity

Render **does** support HIPAA and will sign a BAA self-serve from the
dashboard, but with conditions:

- Requires an **Organization/Enterprise workspace** on a **Scale or Enterprise
  plan**
- **+20% on all usage** in a HIPAA-enabled workspace
- BAA must be signed **before** any PHI touches the platform
- Shared-responsibility: Render covers the platform, you cover the application

Sources: [Render HIPAA docs](https://render.com/docs/hipaa-compliance),
[announcement](https://render.com/blog/introducing-hipaa-enabled-workspaces)

**A BAA does not make your app compliant.** It makes Render's platform usable
for PHI. Section A is still yours.

### B2. Paid Postgres — **hard deadline**

The current free database **expires ~90 days after creation (early November
2026)** and is then destroyed. That may land right around your opening. Move to
a paid plan before then regardless of the HIPAA question.

### B3. Custom domain

`booking.nextwave-wellness.com` → the Render service. Needs a CNAME at your
registrar plus the custom domain added in Render. Once it resolves, one rerun
of `scripts/wire-book-now.py --base https://booking.nextwave-wellness.com`
repoints all 21 buttons.

### B4. Remove the shared Basic Auth gate

`DEMO_USER`/`DEMO_PASSWORD` is a curtain for the demo period. It is replaced
by A1, not kept alongside it.

### B5. Monitoring & uptime alerting

Nothing currently tells you the service is down. A booking page that silently
fails costs appointments.

### B6. Purge demo data before opening

~23 fabricated bookings and 20 invented patients are in the database now. Run
`CONFIRM_PURGE=yes npx tsx scripts/purge-demo-data.ts` before the first real
patient, or the queue mixes invented appointments with genuine ones.

---

## C. Product gaps — not compliance, but you cannot operate without them

| Gap | Why it matters | Effort |
|---|---|---|
| **Confirmation email/SMS** | A patient books and receives *nothing in writing* — no record, no reference. The page says the front desk will call, so someone must actually call. Does not scale past a handful a day. | medium |
| **Cancel / reschedule** | No self-service. Every change is a phone call. | medium |
| **Real staff, shifts, rooms** | All six staff names and every shift are invented. Room counts (4 IV chairs, 2 red-light beds, 2 lab seats) are guesses that **directly cap daily throughput**. | small, needs your data |
| **Real durations & buffers** | Estimates except where a service page states one. Wrong durations mean double-bookings or wasted rooms. | small, needs your data |
| **Provider time-off / blackout dates** | Not modelled. A provider on holiday still shows as available. | medium |
| **Clinic hours as data** | Hard-coded in config; changing them is a deploy. | small |
| **Membership credits** | Tiers exist on the marketing site but the engine knows nothing about them. | large |
| **Recurring appointments** | `isRecurring` is stored but nothing acts on it. | medium |
| **Payment / deposits** | Not built. No-show protection may matter for 90-minute chamber sessions. | large |
| **Service pricing in the API** | `Service` has no price; the booking page cannot quote a total or apply the member discount. | small |

---

## D. Organizational & legal — not code, and not me

Even a perfect application does not make a practice compliant. If you are a
covered entity, these are required; if not, most are still good practice.

- **Security risk analysis** — §164.308(a)(1)(ii)(A). The formal, documented
  assessment everything else hangs off. Usually the first thing an auditor asks
  for.
- **Designated Privacy Officer and Security Officer** — named individuals.
- **Written policies and procedures** — access control, incident response,
  sanctions, device and media handling.
- **Workforce training** — documented, on hire and periodically.
- **BAAs with every vendor touching PHI** — Render, plus email/SMS provider,
  analytics, backups, anyone.
- **Notice of Privacy Practices** — given to patients, posted publicly.
- **Breach notification procedure** — 60-day rule, and HHS notification.
- **Contingency plan** — what the front desk does when the system is down.
- **Physical safeguards** — screen positioning at the front desk, workstation
  locking, device encryption. Relevant while the building is still being fitted
  out; cheaper to design in now than retrofit.

---

## Suggested sequence over three months

**Now → demo period.** Keep `BOOKING_MODE=demo`. Iterate on the booking flow
with fake data. Gather the real inputs for Section C: staff names and shifts,
room inventory, true service durations. Ask your attorney the Section 0
question.

**Month 2.** Build A1 (staff auth) and A2 (audit logging) — they gate the rest
and are the largest pieces. Decide on Render HIPAA workspace based on the
Section 0 answer. Set up the custom domain.

**Month 3.** Confirmation emails, cancel/reschedule, real seed data. Move
Postgres to a paid plan with tested backups. Purge demo data. Policies and
training. Switch to `BOOKING_MODE=beta` with staff booking test appointments
against the real setup.

**Opening.** `BOOKING_MODE=live`, buttons pointed at the custom domain, merge
to `main`.

---

## Where things stand today

**Done and verified:** availability engine with room/staff/buffer constraints,
transactional slot holds under load, booking lifecycle with front desk
approval, amend-only clinical notes with required authorship, patient history
compilation, 21 wired Book now buttons with sub-option pass-through, Central
timezone with DST handling.

**Deliberately not done:** everything in this document.

The gap between "works" and "safe to take real patient data" is Section A plus
Section D. The engine is the smaller half of that.
