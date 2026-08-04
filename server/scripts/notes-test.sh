#!/usr/bin/env bash
# Exercises patient notes, clinical notes, the amend-only rule, and the
# compiled patient history.
#
# Usage: ./scripts/notes-test.sh [date]

set -uo pipefail
API="${API:-http://localhost:4000}"
TOK="${FRONT_DESK_TOKEN:-dev-front-desk-token-change-me}"
DATE="${1:-2026-09-16}"
SVC=5e401ce0-0000-4000-8000-000000000001   # Manual Adjustment
DOC=57aff000-0000-4000-8000-000000000001   # Dr. Alan Reyes
DOC2=57aff000-0000-4000-8000-000000000002  # Dr. Nina Okafor

# Pull a value out of a JSON response by path segments: `get slots 0 start`.
# Failures abort loudly — a silent empty string would make a server error look
# like a script quirk.
get() {
  python3 -c '
import json, sys
d = json.load(sys.stdin)
try:
    for k in sys.argv[1:]:
        d = d[int(k)] if k.lstrip("-").isdigit() else d[k]
except Exception as e:
    sys.exit("  !! " + type(e).__name__ + " " + str(e) + " in " + json.dumps(d)[:200])
print(d)
' "$@"
}

echo "=== 1. Book with a patient note ==="
START=$(curl -s "$API/api/availability?serviceId=$SVC&date=$DATE" | get slots 0 start) || exit 1
HID=$(curl -s -X POST "$API/api/holds" -H 'content-type: application/json' \
  -d "{\"serviceId\":\"$SVC\",\"start\":\"$START\"}" | get holdId) || exit 1
BID=$(curl -s -X POST "$API/api/bookings" -H 'content-type: application/json' \
  -d "{\"holdId\":\"$HID\",\"name\":\"Rosa Lindqvist\",\"email\":\"rosa@example.com\",\"phone\":\"555-0142\",\"patientNote\":\"Lower back pain since a fall in June. Worse in the mornings.\"}" \
  | get bookingId) || exit 1
echo "  booking $BID"

echo "=== 2. Clinical note on an unconfirmed visit (must refuse) ==="
curl -s -X POST "$API/api/bookings/$BID/notes" -H "x-front-desk-token: $TOK" \
  -H 'content-type: application/json' \
  -d "{\"authorId\":\"$DOC\",\"kind\":\"ASSESSMENT\",\"body\":\"too early\"}" | get error

curl -s -o /dev/null -X PATCH "$API/api/bookings/$BID" -H "x-front-desk-token: $TOK" \
  -H 'content-type: application/json' -d '{"status":"CONFIRMED"}'

echo "=== 3. Provider writes SOAP notes ==="
AID=""
while IFS='|' read -r K B; do
  [ -z "$K" ] && continue
  NID=$(curl -s -X POST "$API/api/bookings/$BID/notes" -H "x-front-desk-token: $TOK" \
    -H 'content-type: application/json' \
    -d "{\"authorId\":\"$DOC\",\"kind\":\"$K\",\"body\":\"$B\"}" | get id) || exit 1
  echo "  $K"
  [ "$K" = "ASSESSMENT" ] && AID="$NID"
done <<'NOTES'
SUBJECTIVE|Patient reports lumbar pain, 6/10, worse on waking.
OBJECTIVE|Restricted L4-L5 flexion. No neurological deficit.
ASSESSMENT|Mechanical low back pain, likely facet involvement.
PLAN|Weekly adjustment x4, reassess. Home mobility exercises.
NOTES

echo "=== 4. Amend the assessment (original must survive) ==="
curl -s -X POST "$API/api/visit-notes/$AID/amend" -H "x-front-desk-token: $TOK" \
  -H 'content-type: application/json' \
  -d "{\"authorId\":\"$DOC2\",\"body\":\"Mechanical low back pain with SI joint involvement.\",\"amendReason\":\"Imaging reviewed; refined diagnosis.\"}" \
  | get id | sed 's/^/  amendment /'

echo "=== 5. Amending an already-superseded version (must refuse) ==="
curl -s -X POST "$API/api/visit-notes/$AID/amend" -H "x-front-desk-token: $TOK" \
  -H 'content-type: application/json' \
  -d "{\"authorId\":\"$DOC\",\"body\":\"x\",\"amendReason\":\"y\"}" | get error

echo "=== 6. Compiled patient history ==="
PID=$(curl -s -H "x-front-desk-token: $TOK" "$API/api/patients?email=rosa@example.com" \
  | get patients 0 id) || exit 1
curl -s -H "x-front-desk-token: $TOK" "$API/api/patients/$PID/history" | python3 -c '
import json, sys
d = json.load(sys.stdin)
print("  patient :", d["patient"]["name"], "|  visits:", d["visitCount"])
for v in d["visits"]:
    print("  ---", v["service"], v["start"][:16], "with", (v["provider"] or {}).get("name"))
    print("    patient said :", (v["patientNote"] or "-")[:64])
    for n in v["notes"]:
        print("    %-11s: %s%s" % (n["kind"], n["body"][:54], "  [AMENDED]" if n["amended"] else ""))
        for h in n["history"]:
            print("       superseded:", h["body"][:50])
            print("       reason    :", h["amendReason"])
            print("       written by:", h["author"]["name"])
'

echo "=== 7. Unauthenticated history read (must be 401) ==="
curl -s -o /dev/null -w '  %{http_code}\n' "$API/api/patients/$PID/history"
