#!/usr/bin/env bash
# Emits new transcript lines every 20s (one batched event) for a Monitor.
# Usage: watch.sh <transcript_path> [start_line]
f="$1"; n="${2:-0}"
while true; do
  sleep 20
  pgrep -f "earpiece/scripts/sink.py" >/dev/null || echo "ALERT: transcript sink is down"
  m=$(wc -l < "$f" 2>/dev/null || echo 0)
  if [ "$m" -gt "$n" ]; then sed -n "$((n+1)),${m}p" "$f"; n=$m; fi
done
