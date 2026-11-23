# Dudeling for Claude Desktop

A tutor that teaches on a whiteboard inside Claude. Ask Claude to teach you something: a board opens in the
chat, draws while it explains out loud, and checks you understood. Talk or type on the board to ask, answer
or interrupt.

- **No API key or account.** Claude is the tutor, on your own Claude plan. A lesson uses that plan's allowance.
- **The voice and ears run on your Mac** (Kokoro and Whisper). See [PRIVACY.md](PRIVACY.md).
- **One file.** You don't need Node, a terminal or a download later.

> **Release candidate.** Tested in Claude Desktop on an Apple-silicon Mac. Please report anything odd in
> [Issues](https://github.com/EASHVI-INFOTECH/dudeling-claude/issues).

## Needs

- An Apple-silicon Mac and Claude Desktop, in an ordinary chat (not Cowork, web or mobile).
- English. About 300 MB of disk.

## Install

1. Download `dudeling-darwin-arm64.mcpb` from [Releases](https://github.com/EASHVI-INFOTECH/dudeling-claude/releases), then double-click it, or drag it into Claude Desktop → Settings → Extensions.
2. Ask for a lesson. When Claude asks to use Dudeling's tools, choose **Always allow**.

Update by installing the newer file the same way. Uninstall in Settings → Extensions; lessons stay in
`~/Library/Application Support/Dudeling` until you delete that folder.

## Try

- "Teach me how a fridge works with Dudeling."
- "Tutor me on compound interest with Dudeling. I keep mixing it up with simple interest."
- "Quiz me on the water cycle on Dudeling's board."

## On the board

| | |
|---|---|
| **Play** | Starts the lesson. Any first click on the board also turns sound on. |
| **Talk** | The microphone. Speak to ask, answer or interrupt; press again to let go of it. |
| **Ask or answer** | The same, typed. Works without a microphone. |
| **Pause / Resume / Skip** | The narration. Skip moves past a check question. |
| **Voice on / Muted** | Mutes the voice; the lesson keeps its timing. |
| **Continue in the chat** | Shown when Claude's turn has ended. It fills the chat box: press Enter to carry on. |

## Known limits

- Claude can make a limited number of tool calls in one turn, and stops listening after about 3 minutes of
  silence. Either way, use **Continue in the chat**.
- When Claude isn't listening, what you say lands in the chat box for you to send with Enter.
- Claude's own voice mode isn't used, and can't be synced with the board.
- The first line after Claude starts can take a few seconds. Slower Macs take longer.
- Lessons untouched for 30 days are deleted.
- Lesson quality depends on the Claude model you use.

## If something's wrong

| You see | Do |
|---|---|
| No board | Check Settings → Extensions → Dudeling is on, then restart Claude. |
| "Mic blocked" | Allow Claude in macOS System Settings → Privacy & Security → Microphone, or type on the board. |
| "Voice on (basic)" | Dudeling's engine didn't load. Restart Claude. |
| "needs a Mac with Apple silicon" | Intel Macs aren't supported. |
| It interrupts itself | Use headphones: the microphone is hearing the speakers. |
| "Not listening" | Press **Continue in the chat**, then Enter. |
| "Use this board here" | The board is open further down the chat. Click to move it here. |
| Anything else | Dudeling's log is in `~/Library/Logs/Dudeling`. It holds no lesson text. |

## Privacy Policy

Dudeling has no account, no analytics and no server of its own, and makes no network requests in normal use.
Your voice is turned into text on your Mac and never saved or sent. What you say, type or draw on the board
goes to Claude as part of your conversation. Lessons stay on your Mac and are deleted after 30 days unused.
Full details: [PRIVACY.md](PRIVACY.md).

## Support

- Problems and questions: [GitHub Issues](https://github.com/EASHVI-INFOTECH/dudeling-claude/issues).
- Security problems: report privately, as described in [SECURITY.md](SECURITY.md).

## Develop

Node 22.18 or newer, on an Apple-silicon Mac.

```sh
npm install && npm run voice    # once: fetches the models
npm test                        # builds the board; protocol, engine and real-Chrome board tests
npm run typecheck
npm run pack                    # the .mcpb, tested after packing
npm run release:check           # all of it on this Mac; publishes nothing
```

To run from source, point Claude Desktop at `node /absolute/path/to/dudeling-claude/server/stdio.ts`. Remove that entry
before testing the packed extension, or Claude runs both.

For the board alone: `npm run dev:view`, then open http://127.0.0.1:5173/host.html. The page talks to its own
copy of the plugin over stdio, with scratch storage. There is no web server in the product.

Release tags are `mcp-v<version>`, never `v*` (that builds the desktop app), and are never marked "latest"
(that's what the desktop updater reads).

```
server/  app.ts tools · listen.ts + inbox.ts conversation · boards.ts + store.ts storage
         engine.ts one engine per computer · engine-thread.ts + engine-worker.ts models · voice.ts queue
view/    main.tsx board · player.ts timing · voice.ts sound · listen.ts microphone
scripts/ pack.mjs · release.mjs · fetch-models.ts
```

## Licence

Copyright (C) 2026 EASHVI INFOTECH. Dudeling is free software under the
[GNU General Public License, version 3 or later](LICENSE): you may use, study, change and share it, and anyone who
distributes a changed version must share its source under the same licence. It includes eSpeak NG (GPL-3.0) and
other open-source parts listed in [licenses/NOTICES.md](licenses/NOTICES.md).

