#!/usr/bin/env python3
"""
Turn the disabled "Book now" placeholders on the service pages into live links
into the scheduling engine.

Per the root CLAUDE.md: any change touching every page is a scripted regex
edit, verified afterwards with a grep count. A silent partial match is the
main failure mode here, so this script counts every substitution and refuses
to write a file whose replacement count is not what was expected.

Two kinds of button:

  page-level   <span class="btn btn-primary btn-disabled" ...>Book now</span>
               → ?service=<page-slug>

  card-level   <span class="btn btn-primary shot-card-cta btn-disabled" ...>
               (vitamin-shots, biomarker-testing) — each names a specific shot
               or panel, so it also carries &option=<label>, which the booking
               app stores on Booking.subOption. Without this the front desk
               would see "Vitamin Shots" and not know which one.

Three pages deliberately have no Book now at all and are left untouched:
functional-medicine-consult and spinal-postural-exam (the page *is* the
consult), and peptide-therapy (pricing requires a consultation first).

Usage:
    python3 scripts/wire-book-now.py --base https://booking.example.com
    python3 scripts/wire-book-now.py --base ... --revert
"""

import argparse
import pathlib
import re
import sys
from urllib.parse import quote

SERVICES = pathlib.Path(__file__).resolve().parent.parent / "services"

# Card-level buttons: dialog-target id → human label stored as subOption.
# The label is what the front desk reads, so it matches the card heading.
CARD_OPTIONS = {
    "vitamin-shots": {
        "shot-glutathione": "Glutathione",
        "shot-nad-25": "NAD (25 mg)",
        "shot-nad-50": "NAD (50 mg)",
        "shot-b12": "Vitamin B12",
        "shot-d3-12500": "Vitamin D3 (12,500 IU)",
        "shot-d3-50000": "Vitamin D3 (50,000 IU)",
    },
    "biomarker-testing": {
        "test-baseline": "Baseline",
        "test-toxin": "Total Toxin Testing",
        "test-gut": "Gut Health",
        "test-food-sensitivity": "Food Sensitivity",
        "test-galleri": "Galleri Cancer Test",
    },
}

# Expected number of buttons per page, so a miscount is caught loudly rather
# than silently leaving a page half-wired.
EXPECTED = {
    "biomarker-testing": 5,
    "body-composition": 1,
    "hormone-optimization": 1,
    "hyperbaric-oxygen-therapy": 1,
    "iv-therapy": 1,
    "manual-adjustment": 1,
    "personal-wellness-planning": 1,
    "red-light-therapy": 1,
    "spinal-xrays": 1,
    "supplementation": 1,
    "vitamin-shots": 7,  # 1 page-level + 6 shot cards
    # Deliberately absent — no Book now on these:
    "functional-medicine-consult": 0,
    "spinal-postural-exam": 0,
    "peptide-therapy": 0,
}

DISABLED_RE = re.compile(
    r'<span class="btn btn-primary((?: [a-z-]+)*) btn-disabled" aria-disabled="true">Book now</span>'
)
LIVE_RE = re.compile(
    r'<a href="[^"]*?[?&]service=[^"]*" class="btn btn-primary((?: [a-z-]+)*)">Book now</a>'
)
# Which card a button belongs to: the nearest preceding data-dialog-target.
DIALOG_RE = re.compile(r'data-dialog-target="([a-z0-9-]+)"')


def card_id_before(text: str, pos: int) -> str | None:
    """The dialog id of the card this button sits in, if any."""
    matches = list(DIALOG_RE.finditer(text, 0, pos))
    if not matches:
        return None
    # Only counts as this button's card if it is close by — the Learn more
    # button sits a line or two above its Book now sibling.
    last = matches[-1]
    return last.group(1) if pos - last.end() < 260 else None


def wire(text: str, slug: str, base: str) -> tuple[str, int]:
    options = CARD_OPTIONS.get(slug, {})
    count = 0

    def repl(m: re.Match) -> str:
        nonlocal count
        count += 1
        extra_classes = m.group(1) or ""
        card = card_id_before(text, m.start())
        href = f"{base}/?service={slug}"
        label = options.get(card) if card else None
        if label:
            href += f"&option={quote(label)}"
        return f'<a href="{href}" class="btn btn-primary{extra_classes}">Book now</a>'

    return DISABLED_RE.sub(repl, text), count


def revert(text: str) -> tuple[str, int]:
    count = 0

    def repl(m: re.Match) -> str:
        nonlocal count
        count += 1
        extra_classes = m.group(1) or ""
        return (
            f'<span class="btn btn-primary{extra_classes} btn-disabled"'
            f' aria-disabled="true">Book now</span>'
        )

    return LIVE_RE.sub(repl, text), count


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True, help="Booking app origin, no trailing slash")
    ap.add_argument("--revert", action="store_true", help="Restore disabled placeholders")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    base = args.base.rstrip("/")

    total, failures = 0, []
    for path in sorted(SERVICES.glob("*.html")):
        slug = path.stem
        original = path.read_text()
        new, n = revert(original) if args.revert else wire(original, slug, base)

        expected = EXPECTED.get(slug)
        if expected is None:
            failures.append(f"{slug}: not in EXPECTED — add it before running")
        elif not args.revert and n != expected:
            failures.append(f"{slug}: replaced {n}, expected {expected}")

        if n and not args.dry_run:
            path.write_text(new)
        total += n
        if n:
            print(f"  {slug:<30} {n}")

    print(f"\n{'would change' if args.dry_run else 'changed'}: {total} button(s)")
    if failures:
        print("\nFAILURES:", *failures, sep="\n  ")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
