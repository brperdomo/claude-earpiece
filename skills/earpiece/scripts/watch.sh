#!/usr/bin/env bash
# Emits new transcript lines every 20s (one batched event) for a Monitor, plus one
# ALERT/OK line whenever the sink or the in-page recorder changes state.
# Usage: watch.sh <transcript_path> [start_line]
f="$1"; n="${2:-0}"; hb="$f.hb"
start=$(date +%s); sink="up"; rec=""; last_err=""
while true; do
  sleep 20
  now=$(date +%s)

  if pgrep -f "earpiece/scripts/sink.py" >/dev/null; then
    [ "$sink" = down ] && echo "OK: transcript sink is back up"
    sink="up"
  else
    [ "$sink" = up ] && echo "ALERT: transcript sink is down"
    sink="down"
  fi

  # The recorder's heartbeat only arrives while the sink runs.
  if [ "$sink" = up ]; then
    t=0; mode=""; err=""
    [ -f "$hb" ] && read -r t mode err < "$hb"
    case "$t" in ''|*[!0-9]*) t=0 ;; esac
    if [ "$t" -gt 0 ]; then age=$((now - t)); else age=$((now - start)); fi
    if [ "$age" -gt 45 ]; then s="silent"
    elif [ "$mode" = "no-meeting" ]; then s="no-meeting"
    elif [ "$t" -gt 0 ]; then s="ok"
    else s="$rec"; fi
    if [ "$s" != "$rec" ]; then
      case "$s" in
        silent)     if [ "$t" -gt 0 ]; then echo "ALERT: recorder silent for ${age}s (Zoom tab reloaded or closed?)"
                    else echo "ALERT: no heartbeat from the recorder yet (not injected?)"; fi ;;
        no-meeting) echo "ALERT: recorder running but no meeting frame found (left the meeting?)" ;;
        ok)         [ -n "$rec" ] && echo "OK: recorder reporting again (mode: $mode)" ;;
      esac
      rec="$s"
    fi
    if [ -n "$err" ] && [ "$err" != "$last_err" ]; then echo "ALERT: recorder error: $err"; fi
    last_err="$err"
  fi

  m=$(wc -l < "$f" 2>/dev/null || echo 0)
  if [ "$m" -gt "$n" ]; then sed -n "$((n+1)),${m}p" "$f"; n=$m; fi
done
