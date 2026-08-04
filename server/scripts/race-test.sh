#!/usr/bin/env bash
# Fires N simultaneous hold requests at ONE slot and counts the winners.
#
# X-Ray Suite is the sharpest test available: exactly one room, maxCapacity 1,
# so a correct engine must produce exactly one 201 and N-1 409s. Any second 201
# is a double-booking.
#
# Usage: ./scripts/race-test.sh [date] [concurrency]

set -uo pipefail
API="${API:-http://localhost:4000}"
DATE="${1:-$(date -v+3d +%Y-%m-%d 2>/dev/null || date -d '+3 days' +%Y-%m-%d)}"
N="${2:-12}"
SVC="5e401ce0-0000-4000-8000-000000000003" # Spinal X-Rays → XRAY_SUITE (1 room)

START=$(curl -s "$API/api/availability?serviceId=$SVC&date=$DATE" \
  | python3 -c "import json,sys; s=json.load(sys.stdin)['slots']; print(s[0]['start'] if s else '')")

if [ -z "$START" ]; then
  echo "No slots on $DATE — pick another date."; exit 1
fi

echo "Racing $N concurrent holds for $START"
echo "-------------------------------------------------"

tmp=$(mktemp -d)
for i in $(seq 1 "$N"); do
  curl -s -o "$tmp/body.$i" -w '%{http_code}' -X POST "$API/api/holds" \
    -H 'content-type: application/json' \
    -d "{\"serviceId\":\"$SVC\",\"start\":\"$START\"}" > "$tmp/code.$i" &
done
wait

created=0; conflict=0; other=0
for i in $(seq 1 "$N"); do
  code=$(cat "$tmp/code.$i")
  case "$code" in
    201) created=$((created+1)) ;;
    409|410) conflict=$((conflict+1)) ;;
    *) other=$((other+1)); echo "  unexpected $code: $(cat "$tmp/body.$i")" ;;
  esac
done

echo "  201 Created : $created"
echo "  409 Conflict: $conflict"
echo "  other       : $other"
echo "-------------------------------------------------"
if [ "$created" -eq 1 ] && [ "$other" -eq 0 ]; then
  echo "PASS — exactly one hold won the slot."
else
  echo "FAIL — expected exactly 1 winner and no errors."
fi
rm -rf "$tmp"
