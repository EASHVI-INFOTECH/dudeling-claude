/**
 * The board's problems and the player's timeline (no words), to the plugin's log file in batches: chat apps hide a
 * board's own console, and a real run can only be read afterwards from that file.
 */
import type { App } from "@modelcontextprotocol/ext-apps";

type Level = "error" | "warning" | "info";
const FLUSH_MS = 5000;
const MAX_WAITING = 30;

export function createReporter(app: App, embedded: boolean) {
  let entries: { level: Level; message: string }[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    const batch = entries;
    entries = [];
    if (batch.length) void app.callServerTool({ name: "board_log", arguments: { entries: batch } }).catch(() => {});
  };
  return (level: Level, data: unknown) => {
    if (level === "info") console.debug(`[board ${level}]`, data);
    else console.warn(`[board ${level}]`, data);
    if (!embedded) return;
    entries.push({ level, message: String(data).slice(0, 400) });
    if (entries.length >= MAX_WAITING) {
      if (timer) clearTimeout(timer);
      flush(); // a full batch goes now: nothing is dropped
    } else timer ??= setTimeout(flush, FLUSH_MS);
  };
}
