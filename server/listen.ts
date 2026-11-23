/**
 * The waiting half of reply_and_listen, and of board_updates: look often, answer as soon as there's
 * something, and stop when the caller goes away.
 */
import { setTimeout as sleep } from "node:timers/promises";
import * as boards from "./boards.ts";
import * as inbox from "./inbox.ts";

const CHECK_MS = 200;
/** Claude gives up on a local tool at ~60 s. */
const LISTEN_MS = Math.min(55_000, Math.max(1000, Number(process.env.DUDELING_LISTEN_MS) || 45_000));
/** Nothing heard this many waits in a row: end the turn (~3 min of silence). */
const QUIET_MAX = 4;
/** Including waits while the board was still narrating. */
const WAITS_MAX = 8;
const NARRATING_STALE_MS = 120_000;

export type Heard =
  | { kind: "heard"; messages: inbox.Message[] }
  | { kind: "again"; narrating: boolean }
  | { kind: "stop" }
  | { kind: "cancelled" };

export async function listen(id: string, signal: AbortSignal, waitMs = LISTEN_MS): Promise<Heard> {
  boards.setClaude(id, "listening", waitMs + 5000);
  const until = Date.now() + waitMs;
  let narrated = false;
  for (;;) {
    if (signal.aborted) {
      boards.setClaude(id, "away", 0, { quiet: 0, waits: 0 });
      return { kind: "cancelled" };
    }
    const messages = inbox.take(id);
    if (messages.length) {
      boards.setClaude(id, "busy", undefined, { quiet: 0, waits: 0 });
      return { kind: "heard", messages };
    }
    const p = boards.progress(id);
    narrated ||= p.narrating && Date.now() - p.at < NARRATING_STALE_MS;
    if (Date.now() >= until) break;
    await sleep(CHECK_MS, undefined, { signal }).catch(() => {});
  }
  const was = boards.claude(id);
  const quiet = narrated ? 0 : was.quiet + 1;
  const waits = was.waits + 1;
  if (quiet >= QUIET_MAX || waits >= WAITS_MAX) {
    boards.setClaude(id, "away", 0, { quiet: 0, waits: 0 });
    return { kind: "stop" };
  }
  boards.setClaude(id, "busy", undefined, { quiet, waits });
  return { kind: "again", narrating: narrated };
}

/** Wait until the board has something new (or `waitMs` passes). */
export async function changed(id: string, has: () => boolean, waitMs: number, signal: AbortSignal): Promise<void> {
  if (!waitMs || has()) return;
  const before = boards.changeKey(id);
  const until = Date.now() + waitMs;
  while (!signal.aborted && Date.now() < until && boards.changeKey(id) === before) await sleep(CHECK_MS, undefined, { signal }).catch(() => {});
}
