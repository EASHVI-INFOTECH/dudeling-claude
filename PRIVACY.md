# Privacy

Dudeling for Claude Desktop has no account and no analytics, and its server and whiteboard make no
network requests in normal use.

| What | Where it goes |
|---|---|
| Your microphone (only while Talk is on) | Turned into text on your computer, then discarded. The audio is never saved or sent. |
| What you said (as text) or typed on the board | Given to Claude as part of your conversation, so Anthropic's privacy policy applies to it. |
| What you drew on the board | A picture is kept on your computer, and given to Claude when it looks at the board. |
| What Claude teaches | Handled by Claude like the rest of your conversation. The board keeps a copy on your computer. |
| Dudeling's voice | Made on your computer. If that fails, the board uses only a system voice that runs on your computer, or captions. |

## On your computer

- Lessons, drawings and messages Claude hasn't picked up yet are in
  `~/Library/Application Support/Dudeling` on a Mac and `%LOCALAPPDATA%\Dudeling` on Windows, readable
  only by your user account.
- Lessons untouched for 30 days are deleted the next time a board is opened. Cached speech is deleted
  after a day, the next time speech is made.
- Delete that folder at any time to remove all of it. Uninstalling the extension doesn't delete it.
- Logs (`~/Library/Logs/Dudeling` on a Mac, `%LOCALAPPDATA%\Dudeling\Logs` on Windows) hold timings, board ids and errors, not what was taught or said.

Running Dudeling from source can download the models from Hugging Face the first time. The packed
extension ships them and never downloads.

Questions about privacy: open an issue at https://github.com/EASHVI-INFOTECH/dudeling-claude/issues.
