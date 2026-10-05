---
name: earpiece
description: Listen to a live Zoom call (web client in Chrome) and coach the user in real time. Streams speaker-labeled captions into the session, posts short nudges, then stops cleanly and drafts a summary and follow-up. Use when the user says "listen to my call", "call started", "earpiece on", or /earpiece.
---

# Earpiece: live call coaching (Zoom web client)

Pipeline: Zoom captions in a Chrome tab → `recorder.js` in that tab → local `sink.py` on 127.0.0.1:8765 → transcript file → a Monitor running `watch.sh` → coaching nudges in this session.

Scripts live in `~/.claude/skills/earpiece/scripts/`.

## Requirements
- The Claude in Chrome extension is connected (`list_connected_browsers`).
- The user joins the meeting **in a Chrome tab inside the MCP tab group**, using the Zoom web client (`app.zoom.us`). The desktop app won't work.
- The meeting host has Automated captions enabled. Full transcript is optional but gives better speaker names.
- Recording/transcription consent is the user's responsibility. Zoom shows everyone a captions notice. Don't add new disclaimers unless asked.

## Start
1. **Ask for context, only if the session has none:** who the call is with, the goal, and any prep docs. Use whatever prep already exists in this session or the working directory.
2. **Pick a transcript path:** `<cwd>/earpiece-transcripts/<YYYYMMDD-HHMM>.txt`.
3. **Start the sink** with Bash `run_in_background`:
   `python3 ~/.claude/skills/earpiece/scripts/sink.py "<transcript path>"`
   If port 8765 is already in use, an old sink is still running. Stop it first.
4. **Find the Zoom tab** with `tabs_context_mcp`. If there's none, navigate a group tab to `https://app.zoom.us/wc/home` and have the user join the meeting there.
5. **Turn on captions and the transcript.** With `javascript_tool` in the meeting frame (iframe src matches `webmeeting` or `/wc/<id>/join|start`):
   - Click `[aria-label="Show Captions"]` if it's present.
   - Open `[aria-label="More options for captions, menu button"]` and click "View full transcript". Dispatch pointerdown, mousedown, pointerup, mouseup and click events; a bare `.click()` often does nothing.
   - If the panel doesn't open (common for non-hosts), continue. The recorder falls back to the overlay.
6. **Inject the recorder:** `cat` `recorder.js` and pass its contents to `javascript_tool`. Then verify with `({mode: __rec.mode, err: __rec.err})` a few seconds later. Mode should be `panel` or `overlay`.
7. **Start the Monitor:** `bash ~/.claude/skills/earpiece/scripts/watch.sh "<transcript path>"` with `timeout_ms: 1800000`. Re-arm it on expiry while the call continues, passing the current line count as the second argument.
8. **Tell the user** it's live, the delay (about 20–30 seconds), and to keep the tab open and not reload it.

## During the call
- **At most two one-line nudges per event batch.** Stay silent, or say "nothing to flag", when there's nothing useful.
- **Useful nudges:**
  - the next question to ask;
  - the other side's own words to reflect back, including numbers and names;
  - the option or approach that fits what they just said;
  - a ready-to-say line when they ask something directly;
  - a warning before an over-promise (unverified features, compliance, pricing, roadmap dates).
- **Do the math** when they give volumes or figures, and say what it implies.
- **Speaker labels can be wrong** in overlay mode, so use context. Lines from the user may be credited to someone else.
- **For deep domain questions,** ask a relevant subagent in the background, with a request for a short answer marked VERIFIED or UNVERIFIED. Relay only the takeaway.
- **If `ALERT: transcript sink is down` appears,** restart the sink, then re-inject the recorder.
- **If the page reloads** (rejoin, new meeting), re-inject the recorder.

## Stop (when the user says the call ended)
1. TaskStop the Monitor and the sink task.
2. Run `if(window.__rec){clearInterval(__rec.timer);delete window.__rec}` in the Zoom tab.
3. Draft a summary and follow-up in the working directory:
   - **Internal summary:** needs, numbers, decisions, commitments, risks, owners.
   - **Follow-up email draft:** what we heard, recommended approach, what we'll send, what we need from them, next step and timing.
   Never send anything without explicit approval.
4. Tell the user where the transcript is, and offer to delete it once the summary is final.

## Known limits
- Zoom's page structure isn't a public API, so class names can change. If the recorder finds nothing, inspect the meeting frame for elements whose class contains `transcript` or `subtitle`, and adapt.
- Panel mode gives exact speaker names. Overlay mode infers names from caption initials and the active-speaker tile.
- Captions mangle product names and acronyms. Interpret them generously.
