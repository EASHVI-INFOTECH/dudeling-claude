# Testing Dudeling in Claude Desktop

Round 1 first (20 minutes), then stop and report. Round 2 only once round 1 passes.

## Set up (5 minutes)

1. **Quit Claude completely (Cmd+Q).** It rewrites its config while running, and it must not run the source copy too.
2. In Terminal, back up the config and take out the source copy:

   ```sh
   cd "$HOME/Library/Application Support/Claude"
   cp -n claude_desktop_config.json claude_desktop_config.before-dudeling-test.json
   python3 -c 'import json; p="claude_desktop_config.json"; c=json.load(open(p)); c.get("mcpServers",{}).pop("dudeling",None); open(p,"w").write(json.dumps(c,indent=2))'
   ```

3. Open Claude. Double-click `dudeling-darwin-arm64.mcpb` and press Install.
4. In Settings → Extensions → Advanced settings, check **Use built-in Node.js for MCP** is on.
5. Quit and reopen Claude. Put headphones on. Use a new ordinary chat (not Cowork).

Lessons from before this version don't carry over: their boards say they've expired.

## On Windows

Same rounds, with these changes:

- Set up: quit Claude from the tray icon (not just the window). If you ran a source copy, remove `dudeling`
  from `mcpServers` in `%APPDATA%\Claude\claude_desktop_config.json` first. Install `dudeling-win32-x64.mcpb`.
- Try it once on a PC that has never had Visual Studio or the "Microsoft Visual C++ Redistributable"
  installed, if you can: the bundle carries its own copy, and "Voice on (basic)" there means it didn't load.
- Row 11: the microphone icon in the taskbar goes away. Row 16: Settings → Privacy & security → Microphone.
  Row 19: sleep the PC.
- Lessons are in `%LOCALAPPDATA%\Dudeling`, Dudeling's log in `%LOCALAPPDATA%\Dudeling\Logs`, Claude's in
  `%APPDATA%\Claude\logs`.
- Note your Windows version, and whether Windows warned about the download.

## Round 1 (20 minutes): does it work in real Claude?

| # | Do | Pass |
|---|---|---|
| 1 | Ask "Teach me how a fridge works with Dudeling". Choose Always allow when asked. | One board opens |
| 2 | Click **Talk first**, then Play if it still shows | The lesson starts. The button says "Voice on", without "(basic)" |
| 3 | Listen to the first part | Drawing matches the words. No cut-off lines, no long gaps. The voice sounds right |
| 4 | Cut in mid-sentence: "Wait, what's a refrigerant?" | It goes quiet, answers out loud, then repeats the cut-off line. No Enter |
| 5 | Answer the check question wrongly | It corrects you before the next part |
| 6 | Ask 4 more questions, some spoken, some typed on the board | All answered out loud, no Enter |
| 7 | Let it teach at least 3 parts | Nothing stops after the 8th line |
| 8 | When it's your turn, say nothing for 2 minutes, then speak | No error, and still no Enter |
| 9 | Keep going until Claude ends its turn | Note how many exchanges that took. "Continue in the chat" appears within 45 seconds and works |
| 10 | Watch for permission prompts throughout | None after the first Always allow for each tool |
| 11 | Turn Talk off | The orange microphone dot in the menu bar goes away |

For anything that fails, note the row, roughly the time, what the board's status label said, and take a screenshot.

## Round 2 (30 minutes): the rest

| # | Do | Pass |
|---|---|---|
| 12 | "Explain it like I'm five" | Adds to the same board, nothing wiped |
| 13 | Draw on the board and ask "Is this right?" | Claude describes your drawing |
| 14 | "Now teach me about volcanoes" | The same board clears and starts the new topic |
| 15 | Take off the headphones and play 5 lines through the speakers with Talk on | It doesn't interrupt itself |
| 16 | Turn off Claude's microphone access in macOS, then finish by typing | The lesson still works (turn access back on after) |
| 17 | Quit Claude mid-sentence | No crash message |
| 18 | Reopen that chat | The drawing is back, and lines you heard aren't replayed |
| 19 | Sleep the Mac for a few minutes mid-lesson, then wake it | It still talks and updates |
| 20 | One lesson on Claude Free, if you can | Note how much allowance it used |

## Afterwards: back to the source copy

Quit Claude, then:

```sh
cd "$HOME/Library/Application Support/Claude"
python3 -c 'import json; p="claude_desktop_config.json"; c=json.load(open(p)); b=json.load(open("claude_desktop_config.before-dudeling-test.json")); c.setdefault("mcpServers",{})["dudeling"]=b["mcpServers"]["dudeling"]; open(p,"w").write(json.dumps(c,indent=2))'
```

Open Claude and turn the Dudeling extension off in Settings → Extensions, or both copies run.

Lessons from the test are in `~/Library/Application Support/Dudeling`. The log is in `~/Library/Logs/Claude`
and holds no lesson text.

## Later, before any release

- A clean macOS account: no Node, no terminal, install, update, uninstall.
- A downloaded (quarantined) copy: note any warning.
- A board left open for 4 hours.
