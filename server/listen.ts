/**
 * The waiting half of reply_and_listen, and of board_updates: look often, answer as soon as there's
 * something, and stop when the caller goes away.
 */
import { statSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import * as boards from "./boards.ts";
import * as inbox from "./inbox.ts";


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
  const topic = boards.topicOf(boards.getBoard(id));
  let messages: inbox.Message[] = [];
  let cleared = false;
  await changed(id, () => {
    const batch = inbox.takeCurrent(id, topic);
    if (!batch) { cleared = true; return true; }
    messages = batch;
    const p = boards.progress(id);
    narrated ||= p.narrating && Date.now() - p.at < NARRATING_STALE_MS;
    return messages.length > 0;
  }, until - Date.now(), signal, inbox.inboxDir(id, topic));
  if (cleared) return { kind: "cancelled" };
  if (messages.length) {
    boards.setClaude(id, "busy", undefined, { quiet: 0, waits: 0 });
    return { kind: "heard", messages };
  }
  if (signal.aborted) {
    boards.setClaude(id, "away", 0, { quiet: 0, waits: 0 });
    return { kind: "cancelled" };
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
export async function changed(id: string, has: () => boolean, waitMs: number, signal: AbortSignal, inboxPath?: string): Promise<void> {
  if (signal.aborted) return;
  if (waitMs <= 0) { has(); return; }
  // Atomic sidecar renames change the directory, and SQLite commits change the journal file.
  // If a watcher misses an event, probe these timestamps before reopening any lesson or picture.
  const root = boards.stateDir();
  const paths = [root, join(root, id + ".sqlite"), ...(inboxPath ? [inboxPath] : [])];
  const stamp = () => paths.map(path => statSync(path, { bigint: true, throwIfNoEntry: false })?.mtimeNs ?? 0n).join("/");
  let previous = stamp();
  await new Promise<void>((resolve, reject) => {
    const watchers: FSWatcher[] = [];
    let finished = false;
    const finish = (err?: unknown) => {
      if (finished) return;
      finished = true;
      for (const w of watchers) w.close();
      clearTimeout(timeout);
      clearInterval(fallback);
      signal.removeEventListener("abort", abort);
      if (err) reject(err); else resolve();
    };
    const check = () => { try { if (!finished && has()) finish(); } catch (e) { finish(e); } };
    const abort = () => finish();
    const timeout = setTimeout(() => { check(); finish(); }, waitMs);
    const fallback = setInterval(() => {
      try {
        const current = stamp();
        if (current === previous) return;
        previous = current;
        check();
      } catch (error) { finish(error); }
    }, 950);
    signal.addEventListener("abort", abort, { once: true });
    for (const path of [root, ...(inboxPath ? [inboxPath] : [])]) {
      try {
        const w = watch(path, (_, name) => {
          if (name && (name.endsWith(".tmp") || name.endsWith(".taken"))) return;
          if (!name || path === inboxPath || name.startsWith(id + ".")) check();
        });
        w.on("error", () => w.close());
        watchers.push(w);
      } catch { /* The timer covers filesystems without watch support. */ }
    }
    check(); // subscribe before reading so an edit during registration is visible
  });
}
