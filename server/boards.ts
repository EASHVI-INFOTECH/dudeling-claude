/**
 * Live boards: a board the assistant opens once and keeps drawing on while it talks, so it can pause,
 * take questions and carry on where it left off.
 *
 * Kept in small files (not memory): a chat app may run several copies of this plugin — Claude Desktop
 * answers the assistant's tool calls and the board's own calls from DIFFERENT processes — and they must
 * all see the same boards. Files also let a board survive an app restart. Each file has one writer:
 *   <id>.json           the lesson        Claude's copy
 *   <id>.claude.json    Claude's state    Claude's copy
 *   <id>.progress.json  played up to      the board's copy
 *   <id>.view.json      the newest view   the board's copy
 *   <id>.snapshot.json  learner drawing   the board's copy
 *   <id>.inbox/         learner's words   see inbox.ts
 *
 * Location: see store.ts. Boards untouched for 30 days are removed. Board ids are unguessable; there's
 * no other link between a board and a person.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { PlayOrder, type Answer, type When } from "./prepared.ts";
import { stateDir, writePrivate } from "./store.ts";

export { stateDir };

export interface DrawEvent {
  seq: number;
  /** When it happened (ms since epoch, server clock): a board shown again later replays old events silently. */
  at?: number;
  actions: Record<string, unknown>[];
  /** A short note shown under the board (what's being explained right now). */
  caption?: string;
  /** What the assistant said with this drawing (the board reads it aloud if its voice is on). */
  say?: string;
  /** Wipe the board first (a new topic on the same board); the board's new title. */
  clear?: { title: string };
  /** A narrated part (teach_part): steps the board draws AND says in Dudeling's voice, then the check question. */
  part?: {
    steps: { say: string; actions: Record<string, unknown>[] }[];
    check?: { question: string; answer: string };
    /** Teach this part in its own box on the same board (a new subtopic), or go back to the box with this title. */
    section?: { title: string; about?: string };
    /** Prepared ahead: held back until Claude's verdict on the learner's answer releases it (see prepared.ts). */
    when?: When;
  };
  /** Claude's verdict on the learner's answer: plays the part prepared for it. */
  release?: { answer: Answer };
  /** Pause / resume the board's narration (the learner interrupted). */
  pause?: boolean;
  resume?: boolean;
  /** Something Claude says to the learner in Dudeling's voice (a reply, not part of the lesson). */
  talk?: string;
}

interface Board {
  id: string;
  title: string;
  events: DrawEvent[];
  touched: number;
}

const TTL_MS = 30 * 24 * 60 * 60_000;
const MAX_BOARDS = 500;
const MAX_ACTIONS = 400;

const ID = /^b_[A-Za-z0-9_-]{16}$/;
export const isBoardId = (id: string) => ID.test(id);
const fileOf = (id: string) => join(stateDir(), `${id}.json`);
const sidecar = (id: string, kind: string) => join(stateDir(), `${id}.${kind}.json`);
const snapshotOf = (id: string) => sidecar(id, "snapshot");

function read<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** Remove boards untouched for 30 days, and the oldest beyond MAX_BOARDS, with everything kept beside them. */
export function sweep(now = Date.now()) {
  try {
    const names = readdirSync(stateDir());
    const ids = names
      .filter((f) => f.endsWith(".json") && ID.test(f.slice(0, -5)))
      .map((f) => ({ id: f.slice(0, -5), at: statSync(join(stateDir(), f)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    ids.forEach(({ id, at }, i) => {
      if (now - at > TTL_MS || i >= MAX_BOARDS)
        for (const f of names) if (f.startsWith(`${id}.`)) rmSync(join(stateDir(), f), { recursive: true, force: true });
    });
  } catch {
    /* best effort */
  }
}

export function openBoard(title: string): string {
  sweep();
  const id = `b_${randomBytes(12).toString("base64url")}`;
  writePrivate(fileOf(id), { id, title, events: [], touched: Date.now() } satisfies Board);
  return id;
}

export function getBoard(id: string): Board | undefined {
  return ID.test(id) ? read<Board>(fileOf(id)) : undefined;
}

/** Change a board and save it (only the assistant's tool calls do this). */
function mutate<T>(id: string, change: (b: Board) => T): T | { error: string } {
  const b = getBoard(id);
  if (!b) return { error: "No such board (it may have expired). Open a new one with open_board." };
  const out = change(b);
  if (!(out && typeof out === "object" && "error" in out)) {
    b.touched = Date.now();
    for (const e of b.events) e.at ??= b.touched;
    writePrivate(fileOf(id), b);
  }
  return out;
}

/** A new topic on the same board: wipe it (the board keeps its place in the chat) and retitle it. */
export function clearBoard(id: string, title: string): { seq: number } | { error: string } {
  return mutate(id, (b) => {
    b.title = title;
    const seq = b.events.length + 1;
    b.events.push({ seq, actions: [], clear: { title } });
    return { seq };
  });
}

/** A narrated part of the lesson. */
export function teachPart(id: string, part: NonNullable<DrawEvent["part"]>): { seq: number } | { error: string } {
  return mutate(id, (b) => {
    const n = part.steps.reduce((s, st) => s + st.actions.length, 0);
    if (actionCount(b) + n > MAX_ACTIONS) return { error: "This board is full. Call clear_board to continue on a fresh board." };
    const seq = b.events.length + 1;
    b.events.push({ seq, actions: [], part });
    return { seq };
  });
}

/** Claude's verdict on the learner's answer: the board plays the part prepared for it, if there is one. */
export function release(id: string, answer: Answer): { seq: number; played: boolean } | { error: string } {
  return mutate(id, (b) => {
    const played = waitingParts(b).includes(answer);
    const seq = b.events.length + 1;
    b.events.push({ seq, actions: [], release: { answer } });
    return { seq, played };
  });
}

/** Parts prepared and not played yet. */
export function prepared(id: string): Answer[] {
  const b = getBoard(id);
  return b ? waitingParts(b) : [];
}

function waitingParts(b: Board): Answer[] {
  const order = new PlayOrder<DrawEvent>();
  order.feed(sinceClear(b));
  return order.waiting;
}

/** Claude says something to the learner in Dudeling's voice (voice sessions on the board). */
export function talk(id: string, text: string): { seq: number } | { error: string } {
  return mutate(id, (b) => {
    const seq = b.events.length + 1;
    b.events.push({ seq, actions: [], talk: text });
    return { seq };
  });
}

/** Pause or resume the narration. */
export function setPaused(id: string, paused: boolean): { seq: number } | { error: string } {
  return mutate(id, (b) => {
    const seq = b.events.length + 1;
    b.events.push({ seq, actions: [], ...(paused ? { pause: true } : { resume: true }) });
    return { seq };
  });
}

/** Actions drawn since the board was last cleared (for the "board is full" limit and look_at_board). */
const sinceClear = (b: Board) => b.events.slice(b.events.findLastIndex((e) => e.clear) + 1);
const actionCount = (b: Board) => sinceClear(b).reduce((s, e) => s + e.actions.length + (e.part?.steps.reduce((t, st) => t + st.actions.length, 0) ?? 0), 0);

/** Add drawing to a board. Returns the new event's sequence number. */
export function draw(id: string, actions: Record<string, unknown>[], caption?: string, say?: string): { seq: number } | { error: string } {
  return mutate(id, (b) => {
    if (actionCount(b) + actions.length > MAX_ACTIONS) return { error: "This board is full. Call clear_board to continue on a fresh board." };
    const seq = b.events.length + 1;
    b.events.push({ seq, actions, ...(caption ? { caption } : {}), ...(say ? { say } : {}) });
    return { seq };
  });
}

/** Claude's limit on a tool result is ~150,000 characters: the picture and the summary must fit in it. */
export const MAX_SNAPSHOT_CHARS = 118_000;
const MAX_SUMMARY_CHARS = 16_000;

/** The learner drew on the board: keep the latest picture of it for look_at_board. */
export function setSnapshot(id: string, image: string, note: string, mimeType = "image/png"): boolean {
  if (!getBoard(id) || image.length > MAX_SNAPSHOT_CHARS || !/^[A-Za-z0-9+/=]+$/.test(image)) return false;
  writePrivate(snapshotOf(id), { image, mimeType, at: new Date().toISOString(), note: note.slice(0, 300) });
  return true;
}

export function snapshot(id: string): { image: string; mimeType: string; at: string; note: string } | undefined {
  return ID.test(id) ? read(snapshotOf(id)) : undefined;
}

/** Claude is writing its next call (a whole part can take this long) before we call it gone. */
const BUSY_MS = 45_000;
interface ClaudeFile {
  state: "listening" | "busy" | "away";
  until: number;
  /** Waits in a row that ended with nothing heard. */
  quiet: number;
  waits: number;
}
export function setClaude(id: string, state: ClaudeFile["state"], ms = BUSY_MS, counts: { quiet?: number; waits?: number } = {}) {
  if (!ID.test(id)) return;
  const was = read<ClaudeFile>(sidecar(id, "claude"));
  writePrivate(sidecar(id, "claude"), { state, until: Date.now() + ms, quiet: counts.quiet ?? was?.quiet ?? 0, waits: counts.waits ?? was?.waits ?? 0 } satisfies ClaudeFile);
}
export function claude(id: string): ClaudeFile {
  const c = ID.test(id) ? read<ClaudeFile>(sidecar(id, "claude")) : undefined;
  if (!c) return { state: "away", until: 0, quiet: 0, waits: 0 };
  return c.until > Date.now() ? c : { ...c, state: "away" };
}

/** The last line played (event `seq`, steps done in it), and whether it's narrating. */
export interface Progress {
  seq: number;
  step: number;
  narrating: boolean;
  at: number;
}
export function setProgress(id: string, seq: number, step: number, narrating: boolean): boolean {
  const b = getBoard(id);
  if (!b || seq > b.events.length) return false;
  const was = progress(id);
  const ahead = seq > was.seq || (seq === was.seq && step > was.step);
  writePrivate(sidecar(id, "progress"), { seq: ahead ? seq : was.seq, step: ahead ? step : was.step, narrating, at: Date.now() } satisfies Progress);
  return true;
}
export function progress(id: string): Progress {
  return (ID.test(id) ? read<Progress>(sidecar(id, "progress")) : undefined) ?? { seq: 0, step: 0, narrating: false, at: 0 };
}

export function takeView(id: string, view: string): boolean {
  if (!getBoard(id)) return false;
  writePrivate(sidecar(id, "view"), { view });
  return true;
}
export function isLiveView(id: string, view: string): boolean {
  const v = ID.test(id) ? read<{ view: string }>(sidecar(id, "view")) : undefined;
  return !v || v.view === view;
}

/** Changes whenever the board, Claude's state or the live view does (cheap: a waiting board checks it 4× a second). */
export function changeKey(id: string): string {
  if (!ID.test(id)) return "";
  const stamp = (path: string) => {
    try {
      const s = statSync(path, { bigint: true });
      return `${s.mtimeNs}:${s.ino}`;
    } catch {
      return "-";
    }
  };
  return [stamp(fileOf(id)), stamp(sidecar(id, "claude")), stamp(sidecar(id, "view")), claude(id).state].join("|");
}

/** Everything drawn after `since` (the board waits on this). From the start: only since the last clear. */
export function updates(id: string, since: number): { title: string; events: DrawEvent[]; now: number } | null {
  const b = getBoard(id);
  if (!b) return null;
  const cleared = since ? -1 : b.events.findLastIndex((e) => e.clear);
  const events = b.events.filter((e, i) => e.seq > since && i >= cleared);
  return { title: b.title, events, now: Date.now() };
}

/** What's on the board, by id, so the assistant can refer back to things after a detour. */
export function summary(id: string): string | null {
  const b = getBoard(id);
  if (!b) return null;
  const lines: string[] = [];
  // The board's boxes (sections), as the board makes them: the first drawing opens the first box (its part's
  // section title, or the board's), and a part with a section title opens or goes back to that box. Each box has its own
  // coordinates, so positions are listed under their box.
  const key = (t: string) => t.trim().toLowerCase().replace(/\s+/g, " ");
  let current: string | null = null;
  // Only what's been played or is playing: a part prepared ahead isn't on the board until its verdict.
  for (const e of new PlayOrder<DrawEvent>().feed(sinceClear(b))) {
    const box = e.part?.section?.title.trim() || (current === null && (e.part || e.actions.length) ? b.title : "");
    if (box && key(box) !== current) {
      current = key(box);
      lines.push(`Box "${box}":`);
    }
    for (const a of [...e.actions, ...(e.part?.steps.flatMap((s) => s.actions) ?? [])]) {
      if (typeof a.id !== "string") continue;
      const what = String(a.label ?? a.text ?? (a.type === "draw_arrow" ? `${a.from} → ${a.to}` : a.shape ?? a.type)).slice(0, 60);
      const at = typeof a.x === "number" && typeof a.y === "number" ? ` at (${Math.round(a.x)},${Math.round(a.y)})` : "";
      lines.push(`- ${a.id}: ${a.type} "${what}"${at}`);
    }
  }
  let list = lines.join("\n") || "- (empty)";
  if (list.length > MAX_SUMMARY_CHARS) list = `(older items left out)\n${list.slice(list.indexOf("\n", list.length - MAX_SUMMARY_CHARS) + 1)}`;
  return `Board "${b.title}" (${b.events.length} drawing step${b.events.length === 1 ? "" : "s"}):\n${list}`;
}
