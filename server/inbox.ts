/**
 * The learner's words (spoken or typed on the board) on their way to Claude. A file per message, written
 * by the board's copy of the plugin and claimed by Claude's, so a message is handed over once and
 * survives a restart. Claiming is a rename: only one side wins, so a message can't both reach Claude
 * here and be sent to the chat box.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getBoard, isBoardId } from "./boards.ts";
import { privateDir, renameWhenFree, stateDir, writePrivate } from "./store.ts";

export interface Message {
  text: string;
  how: "spoken" | "typed";
  /** They interrupted: the board paused itself. */
  interrupted?: boolean;
  /** The check question they were answering. */
  check?: string;
  /** The line the board was on. */
  during?: string;
}

const MAX_WAITING = 50;
const MESSAGE_ID = /^m_\d{13}_\d{6}_[A-Za-z0-9_-]{8}$/;
const dirOf = (board: string) => join(stateDir(), `${board}.inbox`);
const waiting = (board: string) =>
  existsSync(dirOf(board))
    ? readdirSync(dirOf(board))
        .filter((f) => f.endsWith(".json") && MESSAGE_ID.test(f.slice(0, -5)))
        .sort()
    : [];

let n = 0;
/** Leave a message. Its id, or why it couldn't be left. */
export function put(board: string, message: Message): { id: string } | { error: string } {
  if (!getBoard(board)) return { error: "No such board." };
  privateDir(`${board}.inbox`);
  if (waiting(board).length >= MAX_WAITING) return { error: "Too many messages are waiting." };
  const id = `m_${Date.now()}_${String(n++ % 1e6).padStart(6, "0")}_${randomBytes(6).toString("base64url")}`;
  writePrivate(join(dirOf(board), `${id}.json`), message);
  return { id };
}

function claim(board: string, file: string): Message | null {
  const from = join(dirOf(board), file);
  const taken = `${from}.${process.pid}.taken`;
  try {
    renameWhenFree(from, taken);
  } catch {
    return null; // the other side got it (or it's still locked: it stays for the next look)
  }
  try {
    return JSON.parse(readFileSync(taken, "utf8")) as Message;
  } catch {
    return null;
  } finally {
    rmSync(taken, { force: true });
  }
}

/** Everything waiting, oldest first. */
export function take(board: string): Message[] {
  if (!isBoardId(board)) return [];
  return waiting(board).flatMap((file) => claim(board, file) ?? []);
}

/** Take a message back (to send it through the chat instead). False if Claude already has it. */
export function withdraw(board: string, id: string): boolean {
  return isBoardId(board) && MESSAGE_ID.test(id) && claim(board, `${id}.json`) !== null;
}
