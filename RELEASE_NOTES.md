# Dudeling 1.0.0-rc.6

A whiteboard tutor inside Claude Desktop, for Apple-silicon Macs and, new and in testing, 64-bit Windows PCs,
in English.

- **New: Windows.** `dudeling-win32-x64.mcpb`, for Windows 10 and 11 on Intel or AMD processors. Please report
  anything odd in Issues, with what the board said and your Windows version.
- Lessons drawn and narrated in sync, one part at a time, with a check question.
- Talk or type on the board to ask, answer or interrupt. While Claude is listening, no Enter is needed.
- The voice and speech recognition run on your computer. No account or key.
- Lessons come back where you left off, for 30 days.

Download `dudeling-darwin-arm64.mcpb` for a Mac or `dudeling-win32-x64.mcpb` for Windows.

Known limits: Claude's turn ends after a number of exchanges or about 3 minutes of silence (press
"Continue in the chat", then Enter); no Intel Mac, ARM Windows, Linux, web, mobile or Cowork; the bundles are
unsigned, so Windows may warn before opening the download.

Verify the download: `shasum -a 256 -c dudeling-darwin-arm64.mcpb.sha256` on a Mac, or in PowerShell
`(Get-FileHash dudeling-win32-x64.mcpb).Hash` and compare it with the `.sha256` file.
