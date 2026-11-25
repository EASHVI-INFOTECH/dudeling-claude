# Dudeling 1.0.0-rc.7

Dudeling teaches in English on a shared whiteboard in Claude Desktop. This release improves interruptions, drawing recovery, and lesson storage.

- Short spoken questions can interrupt narration. If transcription fails, the board stays paused so you can repeat the question or type it.
- Claude can request a current picture of the board, including the positions of the shapes already on the canvas.
- New learner drawings remain editable when you reopen a board. Erasing a mark updates the saved drawing.
- Changing topics clears pending questions and sketches from the previous topic. Drawing and answering extend the lesson’s 30-day retention period.
- Longer lessons save incrementally. Replacing a prepared quiz branch frees its drawing budget and cancels its queued speech.
- The Apple-silicon download is about 5.70 MB smaller. It includes the same offline voice and recognition models.

Download `dudeling-darwin-arm64.mcpb` for a Mac or `dudeling-win32-x64.mcpb` for Windows.

Known limits: Claude's turn ends after a number of exchanges or about 3 minutes of silence (press
"Continue in the chat", then Enter); no Intel Mac, ARM Windows, Linux, web, mobile or Cowork; the bundles are
unsigned, so Windows may warn before opening the download.

Verify the download: `shasum -a 256 -c dudeling-darwin-arm64.mcpb.sha256` on a Mac, or in PowerShell
`(Get-FileHash dudeling-win32-x64.mcpb).Hash` and compare it with the `.sha256` file.
