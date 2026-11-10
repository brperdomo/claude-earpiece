---
name: earpiece
description: Listen to a live Zoom or Microsoft Teams call (web client in Chrome) and coach the user in real time. Streams speaker-labeled captions into the session, posts short nudges, then stops cleanly and drafts a summary and follow-up. Use when the user says "listen to my call", "call started", "earpiece on", or /earpiece.
---

# Earpiece: live call coaching (Zoom and Teams web clients)

Pipeline: meeting captions in a Chrome tab → `recorder.js` in that tab → local `sink.py` → transcript file → a Monitor running `watch.sh` → coaching nudges in this session.

Scripts live in `~/.claude/skills/earpiece/scripts/`.

| | Zoom | Microsoft Teams |
|---|---|---|
| Web client | `app.zoom.us` | `teams.microsoft.com`, `teams.cloud.microsoft` (work/school), `teams.live.com` (personal) |
| Sink port | 8765 (default) | **4318**. Teams' CSP only lets the page reach `http://localhost:4318`, so no other port works. |
| Captions | Host must enable Automated captions | Any participant can turn on live captions |
| Speaker names | Exact in panel mode, inferred in overlay mode | Exact (each caption carries its author) |
| Recorder mode | `panel` or `overlay` | `teams` |

## Requirements
- The Claude in Chrome extension is connected (`list_connected_browsers`).
- The user joins the meeting **in a Chrome tab inside the MCP tab group**, using the web client. The desktop apps won't work. For Teams, open the meeting link and choose "Continue on this browser".
- Recording/transcription consent is the user's responsibility. Both platforms show everyone a captions notice. Don't add new disclaimers unless asked.
- If Chrome asks whether the meeting site may access devices on the local network, the user must allow it, or the recorder can't reach the sink.

## Start
1. **Ask for context, only if the session has none:** who the call is with, the goal, and any prep docs. Use whatever prep already exists in this session or the working directory.
2. **Ask which platform** if it isn't clear from context or the meeting link.
3. **Pick a transcript path:** `<cwd>/earpiece-transcripts/<YYYYMMDD-HHMM>.txt`.
4. **Start the sink** with Bash `run_in_background`:
   - Zoom: `python3 ~/.claude/skills/earpiece/scripts/sink.py "<transcript path>"`
   - Teams: `python3 ~/.claude/skills/earpiece/scripts/sink.py "<transcript path>" 4318`
   If the port is already in use, an old sink is still running (or, for 4318, possibly a local OpenTelemetry collector). Stop it first. On Zoom you may pick another port: pass it as a second argument and run `window.__earpiecePort = <port>` in the tab before injecting the recorder.
5. **Find the meeting tab** with `tabs_context_mcp`. If there's none, navigate a group tab to `https://app.zoom.us/wc/home` (Zoom) or the meeting link (Teams) and have the user join there.
6. **Turn on captions.** Use `javascript_tool`. Fluent/React menus often ignore a bare `.click()`, so dispatch pointerdown, mousedown, pointerup, mouseup and click events.
   - **Zoom** (in the meeting frame, whose iframe src matches `webmeeting` or `/wc/<id>/join|start`): click `[aria-label="Show Captions"]` if present. Then open `[aria-label="More options for captions, menu button"]` and click "View full transcript". If the panel doesn't open (common for non-hosts), continue. The recorder falls back to the overlay.
   - **Teams** (top frame): open More (`button[data-tid="more-button"]` or `#callingButtons-showMoreBtn`), then "Language and speech" (`#LanguageSpeechMenuControl-id`), then "Show live captions" (`#closed-captions-button`). Newer layouts also have a Captions control in the toolbar. Captions are on when `[data-tid="closed-caption-renderer-wrapper"]` exists. If the menu path fails, ask the user to turn captions on (More → Language and speech → Show live captions).
7. **Inject the recorder:** `cat` `recorder.js` and pass its contents directly to `javascript_tool`. Don't load it with `eval` or a `<script>` tag: Teams' CSP and Trusted Types block both. Verify a few seconds later with `({mode: __rec.mode, err: __rec.err, sinkErr: __rec.sinkErr, queued: __rec.q.length})`. Mode should be `panel`/`overlay` (Zoom) or `teams`, and both errors should be empty. A `sinkErr` mentioning the CSP means the wrong port: on Teams, the sink must be on 4318.
8. **Start the Monitor:** `bash ~/.claude/skills/earpiece/scripts/watch.sh "<transcript path>"` with `timeout_ms: 1800000`. Re-arm it on expiry while the call continues, passing the current line count as the second argument.
9. **Tell the user** it's live, the delay (about 20–30 seconds), and to keep the tab open and not reload it.

## During the call
- **At most two one-line nudges per event batch.** Stay silent, or say "nothing to flag", when there's nothing useful.
- **Useful nudges:**
  - the next question to ask;
  - the other side's own words to reflect back, including numbers and names;
  - the option or approach that fits what they just said;
  - a ready-to-say line when they ask something directly;
  - a warning before an over-promise (unverified features, compliance, pricing, roadmap dates).
- **Do the math** when they give volumes or figures, and say what it implies.
- **Speaker labels can be wrong** in Zoom overlay mode, so use context. Lines from the user may be credited to someone else.
- **For deep domain questions,** ask a relevant subagent in the background, with a request for a short answer marked VERIFIED or UNVERIFIED. Relay only the takeaway.
- **The Monitor prints one `ALERT:`/`OK:` line per state change.** Act on alerts once; don't repeat them to the user unless they persist.
  - `transcript sink is down`: restart the sink with the same transcript path and port. The recorder keeps unsent lines queued and delivers them on its own once the sink is back, so no re-injection is needed.
  - `recorder silent` or `no heartbeat from the recorder yet`: the meeting tab reloaded, closed, or the recorder was never injected. Re-inject the recorder.
  - `no meeting frame found` (Zoom): the user left the meeting or is in the lobby. Mention it once.
  - `no live captions on screen` (Teams): captions were turned off or the user left. Turn captions back on, or mention it once.
  - `recorder error: …`: the page structure may have changed. See Known limits.
- **If the page reloads** (rejoin, new meeting), re-inject the recorder.

## Stop (when the user says the call ended)
1. TaskStop the Monitor and the sink task.
2. Run `if(window.__rec){clearInterval(__rec.timer);delete window.__rec}` in the meeting tab.
3. Draft a summary and follow-up in the working directory:
   - **Internal summary:** needs, numbers, decisions, commitments, risks, owners.
   - **Follow-up email draft:** what we heard, recommended approach, what we'll send, what we need from them, next step and timing.
   Never send anything without explicit approval.
4. Tell the user where the transcript is, and offer to delete it (and its `.hb` heartbeat file) once the summary is final.

## Known limits
- Neither platform's page structure is a public API, so selectors can change. If the recorder finds nothing:
  - Zoom: inspect the meeting frame for elements whose class contains `transcript` or `subtitle`.
  - Teams: inspect the top frame for `[data-tid*="closed-caption"]` and `[data-tid*="author"]`.
  Then adapt.
- Zoom panel mode gives exact speaker names. Overlay mode infers names from caption initials and the active-speaker tile.
- Teams' sink port (4318) depends on an allowance in Microsoft's CSP. If Microsoft removes it, the recorder reports a CSP error in `sinkErr`, and Teams capture stops working until a new transport is added.
- Captions mangle product names and acronyms. Interpret them generously.
