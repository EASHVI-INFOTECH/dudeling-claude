/**
 * The plugin's own log file: Claude Desktop stopped keeping MCP servers' stderr in its log, so without this
 * nothing the plugin or the board reports survives a run. Never any of what was said, typed or taught.
 *
 * ~/Library/Logs/Dudeling/dudeling.log (one file for every copy of the plugin, each line with its pid), cut to
 * dudeling.1.log at 2 MB. Tests keep it beside their own state (DUDELING_STATE_DIR) or in DUDELING_LOG_DIR.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_BYTES = 2_000_000;

export function logDir(): string {
  return process.env.DUDELING_LOG_DIR ?? process.env.DUDELING_STATE_DIR ?? join(homedir(), "Library", "Logs", "Dudeling");
}

export const logFile = () => join(logDir(), "dudeling.log");

/** One line to the log file, and to stderr unless DUDELING_QUIET. Never throws. */
export function log(msg: string) {
  const line = `[dudeling ${new Date().toISOString().slice(0, 23)} ${process.pid}] ${msg}`;
  if (!process.env.DUDELING_QUIET) console.error(line);
  try {
    const file = logFile();
    mkdirSync(logDir(), { recursive: true, mode: 0o700 });
    try {
      if (statSync(file).size > MAX_BYTES) renameSync(file, join(logDir(), "dudeling.1.log"));
    } catch {
      // no file yet
    }
    appendFileSync(file, `${line}\n`, { mode: 0o600 });
  } catch {
    // A log that can't be written must never break a lesson.
  }
}
