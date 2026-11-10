# claude-earpiece

A [Claude Code](https://claude.com/claude-code) skill that listens to your live Zoom or Microsoft Teams call and coaches you in real time.

Earpiece streams the meeting's captions, with speaker names, into your Claude Code session. Claude follows the conversation and sends you short nudges: the next question to ask, the customer's own numbers reflected back, a ready-to-say answer, or a warning before you over-promise. When the call ends, it drafts a summary and a follow-up email.

```
10:42:18 | Dana Lee: We onboard maybe 40 new clients a month, and each one takes the team about two days.

Claude ▸ 40 clients × 2 days ≈ 80 staff-days a month on onboarding. Reflect that back.
         Ask: "Which part of those two days is the most manual?"
```

## How it works

```
Zoom / Teams web client (Chrome)  your Mac                        Claude Code
┌──────────────────────┐   POST   ┌───────────────┐   tail   ┌──────────────────┐
│ captions/transcript  │ ───────▶ │ sink.py       │ ───────▶ │ Monitor (watch.sh)│
│ recorder.js          │ loopback │ transcript.txt│  every   │ → coaching nudges │
└──────────────────────┘          └───────────────┘   20 s   └──────────────────┘
```

- **`recorder.js`** runs in the meeting tab.
  - **Zoom:** it reads the **full transcript panel** (exact speaker names) when Zoom shows it, and otherwise falls back to the **caption overlay**, naming speakers from caption initials and the active-speaker tile. It removes repeated text from rolling captions.
  - **Teams:** it reads the **live captions pane**, where every line already carries the speaker's name, and waits for Teams to finish refining each line.

  It sends each finished line to the local sink. Lines stay queued until the sink confirms them, so a sink restart doesn't lose anything, and a heartbeat every ~10 seconds reports that the recorder is still alive.
- **`sink.py`** is a tiny HTTP server, bound to `127.0.0.1` only, that accepts lines only from the Zoom and Teams web origins and appends them to a transcript file. Zoom uses port 8765. Teams uses port 4318, because Teams' Content Security Policy only lets the page reach `http://localhost:4318`.
- **`watch.sh`** batches new lines every 20 seconds into a Claude Code Monitor, so Claude is notified instead of polling. It also raises a single alert when the sink stops, or when the recorder goes quiet (for example, the meeting tab reloaded).

Nothing goes to a third-party service. The transcript stays on your machine, and Claude sees it the same way it sees any other tool output.

## Requirements

- macOS or Linux with Python 3 and Bash
- [Claude Code](https://claude.com/claude-code) with the **Claude in Chrome** extension connected
- Google Chrome
- One of these web clients (the desktop apps aren't supported):
  - **Zoom** (`app.zoom.us`), with **Automated captions** enabled by the meeting host. Turning on "Full transcript" as well gives the best speaker names.
  - **Microsoft Teams** (`teams.microsoft.com`, `teams.cloud.microsoft` or `teams.live.com`), with **live captions** on. Any participant can turn them on, and Claude does it for you.

## Install

```bash
git clone https://github.com/brperdomo/claude-earpiece.git
mkdir -p ~/.claude/skills
ln -s "$(pwd)/claude-earpiece/skills/earpiece" ~/.claude/skills/earpiece
```

Or copy `skills/earpiece` into `~/.claude/skills/` instead of linking it. Start a new Claude Code session so the skill gets picked up.

## Use

1. In Claude Code, say **"earpiece on"** or **"listen to my call"** (or run `/earpiece`). Claude opens a tab in its Chrome tab group.
2. **Join the meeting in that tab**: "Join from your browser" on Zoom, "Continue on this browser" on Teams. If Chrome asks whether the site may access devices on your local network, allow it, because that's how the recorder reaches the local sink.
3. Claude starts the listener, turns on captions, injects the recorder and starts watching.
4. Coaching arrives in the session about 20–30 seconds behind the conversation.
5. Say **"call ended"**. Claude shuts everything down and drafts a summary and a follow-up email. Nothing is sent without your approval.

Tips:
- Give Claude context before the call (who it's with, the goal, your prep notes). The nudges get much better.
- When screen sharing, share a single window, not your whole screen.
- Keep the meeting tab open and don't reload it. If it does reload, Claude gets a "recorder silent" alert and re-injects the recorder.

## Consent and privacy

**You are responsible for complying with recording and transcription laws and your organization's policies.** Some jurisdictions require every participant's consent. Zoom and Teams show participants a notice when captions or transcripts are on, but that may not be sufficient everywhere.

Transcripts are saved locally in `earpiece-transcripts/`. Delete them when you're done if your policies require it.

## Limitations

- **Zoom and Teams web clients in Chrome only.** The desktop apps and Google Meet aren't supported yet.
- The recorder depends on each platform's page structure, which isn't a public API and may change.
- Teams support relies on Microsoft's CSP continuing to allow `http://localhost:4318`. If that changes, the recorder reports a CSP error. The skill tells Claude how to adapt if captions stop coming through.
- In Zoom's overlay mode, speaker names are inferred and are sometimes wrong when people talk over each other.
- Captions garble product names and acronyms.

## License

MIT
