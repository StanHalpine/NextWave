#!/usr/bin/env bash
# Fills one day with bookings in a mix of statuses so the grid can be eyeballed.
# Development aid only — never point this at production.
#
# Usage: ./scripts/demo-day.sh 2026-08-05

set -uo pipefail
API="${API:-http://localhost:4000}"
TOKEN="${FRONT_DESK_TOKEN:-dev-front-desk-token-change-me}"
DATE="${1:-$(date -v+2d +%Y-%m-%d 2>/dev/null || date -d '+2 days' +%Y-%m-%d)}"

S=5e401ce0-0000-4000-8000-0000000000
book () {  # book <serviceId> <slot-index> <name> <final-status>
  local svc="$1" idx="$2" name="$3" want="$4"
  local start
  start=$(curl -s "$API/api/availability?serviceId=$svc&date=$DATE" \
    | python3 -c "import json,sys
s=json.load(sys.stdin)['slots']
print(s[$idx]['start'] if len(s)>$idx else '')")
  [ -z "$start" ] && { echo "  skip $name — no slot"; return; }

  local hid
  hid=$(curl -s -X POST "$API/api/holds" -H 'content-type: application/json' \
    -d "{\"serviceId\":\"$svc\",\"start\":\"$start\"}" \
    | python3 -c "import json,sys; print(json.load(sys.stdin).get('holdId',''))")
  [ -z "$hid" ] && { echo "  skip $name — hold refused"; return; }

  if [ "$want" = "HOLD" ]; then echo "  $name → HOLD"; return; fi

  local bid
  bid=$(curl -s -X POST "$API/api/bookings" -H 'content-type: application/json' \
    -d "{\"holdId\":\"$hid\",\"name\":\"$name\",\"email\":\"${name// /.}@example.com\",\"phone\":\"555-0$RANDOM\"}" \
    | python3 -c "import json,sys; print(json.load(sys.stdin).get('bookingId',''))")
  [ -z "$bid" ] && { echo "  skip $name — confirm refused"; return; }

  if [ "$want" != "PENDING_REVIEW" ]; then
    curl -s -o /dev/null -X PATCH "$API/api/bookings/$bid" \
      -H "x-front-desk-token: $TOKEN" -H 'content-type: application/json' \
      -d "{\"status\":\"$want\"}"
  fi
  echo "  $name → $want"
}

echo "Seeding demo bookings for $DATE"
book "${S}01" 2  "Marta Ellis"    CONFIRMED        # Manual Adjustment
book "${S}01" 8  "Devon Park"     PENDING_REVIEW
book "${S}02" 14 "Ruth Alvarez"   CONFIRMED        # Spinal & Postural Exam
book "${S}03" 4  "Ben Okonjo"     CONFIRMED        # Spinal X-Rays
book "${S}04" 6  "Iris Chen"      PENDING_REVIEW   # FM Consult
book "${S}05" 10 "Tomas Reid"     CONFIRMED        # Biomarker Testing
book "${S}05" 10 "Ada Whitfield"  CONFIRMED        # same slot, 2nd lab seat
book "${S}07" 5  "Nora Vance"     CONFIRMED        # Body Composition
book "${S}10" 8  "Julian Marsh"   CONFIRMED        # IV Therapy
book "${S}10" 12 "Priya Nadar"    PENDING_REVIEW
book "${S}11" 3  "Owen Blake"     HOLD             # Vitamin Shots
book "${S}12" 6  "Sasha Green"    CONFIRMED        # Hyperbaric 60
book "${S}14" 9  "Leo Fontaine"   DECLINED         # Red Light
book "${S}15" 11 "Mira Solberg"   PENDING_REVIEW   # Peptide Therapy
echo "Done. Open $API/dashboard.html and go to $DATE"
