#!/bin/sh
payload=$(tr -d '\000-\037' 2>/dev/null)
[ -z "$DEVIN_CONDUCTOR_ID" ] && exit 0
[ -z "$DEVIN_CONDUCTOR_EVENTS_DIR" ] && exit 0
mkdir -p "$DEVIN_CONDUCTOR_EVENTS_DIR" 2>/dev/null
# only embed the hook stdin when it still looks like one bounded JSON object, never a truncated one
extra=''
case "$payload" in
  '{'*) [ "${#payload}" -le 65536 ] && extra=",\"payload\":$payload" ;;
esac
printf '{"id":"%s","event":"%s","ts":%s%s}\n' "$DEVIN_CONDUCTOR_ID" "$1" "$(($(date +%s) * 1000))" "$extra" >> "$DEVIN_CONDUCTOR_EVENTS_DIR/events.jsonl" 2>/dev/null
exit 0
