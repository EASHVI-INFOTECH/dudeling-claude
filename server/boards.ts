/**
 * Live boards: a board the assistant opens once and keeps drawing on while it talks, so it can pause,
 * take questions and carry on where it left off.
 *
 * Kept in small files (not memory): a chat app may run several copies of this plugin — Claude Desktop
 * answers the assistant's tool calls and the board's own calls from DIFFERENT processes — and they must
 * all see the same boards. Files also let a board survive an app restart. The original JSON is retained as the starting point for older boards:
 *   <id>.json           original lesson / retention timestamp
 *   <id>.sqlite         subsequent events, committed in sequence across plugin processes
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
import { closeSync, existsSync, openSync, readFileSync, readdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
const topicFile = (id: string, topic: number, kind: string) => sidecar(id, topic ? topic + "." + kind : kind);

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

// Older releases stored their entire lesson in the JSON header. New events use a
// transactional journal so a slow writer cannot replace a different process's edit.
const journal = (id: string) => join(stateDir(), id + ".sqlite");
const recent = new Map<string, Board>();
const lastSeq = (b: Board) => b.events.at(-1)?.seq ?? 0;

function remember(b: Board) {
  recent.delete(b.id);
  recent.set(b.id, b);
  if (recent.size > 8) recent.delete(recent.keys().next().value!);
}

function loadBoard(id: string, db?: DatabaseSync) {
  if (!existsSync(fileOf(id))) {
    recent.delete(id);
    return undefined;
  }
  const base = recent.get(id) ?? read<Board>(fileOf(id));
  if (!base || !db) return base;
  const rows = db.prepare("SELECT event FROM events WHERE seq > ? ORDER BY seq").all(lastSeq(base));
  if (!rows.length) {
    if (!recent.has(id)) remember(base);
    return base;
  }
  const events = rows.map(row => JSON.parse(String(row.event)) as DrawEvent);
  const cleared = events.findLastIndex(e => e.clear);
  const updated = { ...base, events: cleared < 0 ? base.events.concat(events) : events.slice(cleared), title: events[cleared]?.clear?.title ?? base.title };
  remember(updated);
  return updated;
}

function openJournal(id: string) {
  // SQLite inherits the mode of the pre-created file, including for its rollback journal.
  if (!existsSync(journal(id))) closeSync(openSync(journal(id), "a", 0o600));
  const db = new DatabaseSync(journal(id));
  try {
    db.exec("PRAGMA busy_timeout=2000; CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY, event TEXT NOT NULL)");
    return db;
  } catch (e) {
    db.close();
    throw e;
  }
}

export function getBoard(id: string): Board | undefined {
  if (!ID.test(id)) return undefined;
  if (!existsSync(journal(id))) return loadBoard(id);
  const db = new DatabaseSync(journal(id), { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=2000");
    return loadBoard(id, db);
  } catch (e) {
    // Another process can open the new file before the first schema transaction commits.
    if (e instanceof Error && e.message.includes("no such table: events")) return loadBoard(id);
    throw e;
  } finally { db.close(); }
}

export function touchBoard(id: string) {
  if (!ID.test(id)) return;
  const now = new Date();
  const stamp = statSync(fileOf(id), { throwIfNoEntry: false });
  if (stamp && +now - stamp.mtimeMs > 30_000) utimesSync(fileOf(id), now, now);
}

export const topicOf = (b?: Board) => b?.events.findLast(e => e.clear)?.seq ?? 0;

function mutate<T>(id: string, change: (b: Board) => T): T | { error: string } {
  if (!ID.test(id) || !existsSync(fileOf(id))) return { error: "No such board (it may have expired). Open a new one with open_board." };
  const db = openJournal(id);
  try {
    db.exec("BEGIN IMMEDIATE");
    const original = loadBoard(id, db);
    if (!original) return { error: "No such board." };
    const b = { ...original, events: original.events.slice() };
    const out = change(b);
    if (out && typeof out === "object" && "error" in out) return out;
    const event = b.events.at(-1)!;
    event.at = b.touched = Date.now();
    db.prepare("INSERT INTO events(seq,event) VALUES (?,?)").run(event.seq, JSON.stringify(event));
    if (event.clear) db.prepare("DELETE FROM events WHERE seq < ?").run(event.seq);
    if (out && typeof out === "object" && "discarded" in out && typeof out.discarded === "number") {
      db.prepare("DELETE FROM events WHERE seq=?").run(out.discarded);
      b.events = b.events.filter(e => e.seq !== out.discarded);
    }
    db.exec("COMMIT");
    remember(b);
    touchBoard(id);
    return out;
  } finally {
    db.close(); // rolls back an uncommitted transaction
  }
}

/** A new topic on the same board: wipe it (the board keeps its place in the chat) and retitle it. */
export function clearBoard(id: string, title: string): { seq: number } | { error: string } {
  return mutate(id, (b) => {
    b.title = title;
    const seq = lastSeq(b) + 1;
    b.events = [{ seq, actions: [], clear: { title } }];
    return { seq };
  });
}

/** A narrated part of the lesson. */
export function teachPart(id: string, part: NonNullable<DrawEvent["part"]>): { seq: number; discarded?: number } | { error: string } {
  return mutate(id, (b) => {
    const discarded = part.when ? waitingOrder(b).pending.find(e => e.part?.when === part.when)?.seq : undefined;
    const n = part.steps.reduce((s, st) => s + st.actions.length, 0);
    if (actionCount(b, part.when) + n > MAX_ACTIONS) return { error: "This board is full. Call clear_board to continue on a fresh board." };
    const seq = lastSeq(b) + 1;
    b.events.push({ seq, actions: [], part });
    return { seq, discarded };
  });
}

/** Claude's verdict on the learner's answer: the board plays the part prepared for it, if there is one. */
export function release(id: string, answer: Answer) {
  return mutate(id, (b) => {
    const order = waitingOrder(b);
    const played = order.waiting.includes(answer);
    const discarded = answer === "right" ? order.pending.find(e => e.part?.when === "after_wrong")?.seq : undefined;
    const seq = lastSeq(b) + 1;
    b.events.push({ seq, actions: [], release: { answer } });
    return { seq, played, discarded };
  });
}

/** Parts prepared and not played yet. */
export function prepared(id: string): Answer[] {
  const b = getBoard(id);
  return b ? waitingOrder(b).waiting : [];
}

function waitingOrder(b: Board) {
  const order = new PlayOrder<DrawEvent>();
  order.feed(sinceClear(b));
  return order;
}

/** Claude says something to the learner in Dudeling's voice (voice sessions on the board). */
export function talk(id: string, text: string): { seq: number } | { error: string } {
  return mutate(id, (b) => {
    const seq = lastSeq(b) + 1;
    b.events.push({ seq, actions: [], talk: text });
    return { seq };
  });
}

/** Pause or resume the narration. */
export function setPaused(id: string, paused: boolean): { seq: number } | { error: string } {
  return mutate(id, (b) => {
    const seq = lastSeq(b) + 1;
    b.events.push({ seq, actions: [], ...(paused ? { pause: true } : { resume: true }) });
    return { seq };
  });
}

/** Actions drawn since the board was last cleared (for the "board is full" limit and look_at_board). */
const sinceClear = (b: Board) => b.events.slice(b.events.findLastIndex((e) => e.clear) + 1);
function actionCount(b: Board, replacing?: When) {
  const order = new PlayOrder<DrawEvent>();
  const visible = order.feed(sinceClear(b));
  const size = (e: DrawEvent) => e.actions.length + (e.part?.steps.reduce((n, s) => n + s.actions.length, 0) ?? 0);
  // A wrong verdict can play remediation and then the prepared right branch.
  const pending = order.pending.filter(e => e.part?.when !== replacing);
  return visible.concat(pending).reduce((n, e) => n + size(e), 0);
}

/** Add drawing to a board. Returns the new event's sequence number. */
export function draw(id: string, actions: Record<string, unknown>[], caption?: string, say?: string): { seq: number } | { error: string } {
  return mutate(id, (b) => {
    if (actionCount(b) + actions.length > MAX_ACTIONS) return { error: "This board is full. Call clear_board to continue on a fresh board." };
    const seq = lastSeq(b) + 1;
    b.events.push({ seq, actions, ...(caption ? { caption } : {}), ...(say ? { say } : {}) });
    return { seq };
  });
}

/** Claude's limit on a tool result is ~150,000 characters: the picture and the summary must fit in it. */
export const MAX_SNAPSHOT_CHARS = 118_000;
const MAX_SUMMARY_CHARS = 16_000;

/** The learner drew on the board: keep the latest picture of it for look_at_board. */
export interface Snapshot {
  image: string; mimeType: string; at: string; note: string;
  summary?: string; request?: string; view?: string;
}
export function setSnapshot(id: string, image: string, note: string, mimeType = "image/png", scope: { topic?: number; view?: string; summary?: string; request?: string } = {}): boolean {
  if (image.length > MAX_SNAPSHOT_CHARS || (image && !/^[A-Za-z0-9+/=]+$/.test(image))) return false;
  return withBoard(id, (_db, board) => {
    if (!accepts(id, scope.topic, scope.view, board)) return false;
    writePrivate(topicFile(id, topicOf(board), "snapshot"), { image, mimeType, at: new Date().toISOString(), note, ...scope });
    touchBoard(id);
    return true;
  }) ?? false;
}

export function snapshot(id: string): Snapshot | undefined {
  const b = getBoard(id);
  if (!b) return;
  const topic = topicOf(b);
  const snap = read<Snapshot>(topicFile(id, topic, "snapshot"));
  if (snap || !topic) return snap;
  // Old installations stored an unscoped picture. Only reuse it when taken after the last clear.
  const legacy = read<Snapshot>(topicFile(id, 0, "snapshot"));
  if (!legacy) return;
  const cleared = read<Board>(fileOf(id))?.events.findLast(e => e.seq === topic && e.clear)?.at;
  if (legacy && cleared && Date.parse(legacy.at) > cleared) return legacy;
}

export function requestCapture(id: string) {
  const recentRequest = read<{ request: string; at: number }>(sidecar(id, "capture"));
  if (recentRequest && Date.now() - recentRequest.at < 2500 && snapshot(id)?.request !== recentRequest.request) return recentRequest.request;
  const request = randomBytes(12).toString("hex");
  writePrivate(sidecar(id, "capture"), { request, at: Date.now() });
  return request;
}
export function captureRequest(id: string) {
  return ID.test(id) ? read<{ request: string }>(sidecar(id, "capture"))?.request : undefined;
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
export function setProgress(id: string, seq: number, step: number, narrating: boolean, topic?: number, view?: string): boolean {
  return withBoard(id, (_db, board) => {
    if (!accepts(id, topic, view, board) || seq > lastSeq(board)) return false;
    const was = progress(id);
    const ahead = seq > was.seq || (seq === was.seq && step > was.step);
    writePrivate(sidecar(id, "progress"), { seq: ahead ? seq : was.seq, step: ahead ? step : was.step, narrating, at: Date.now() } satisfies Progress);
    if (ahead || narrating !== was.narrating) touchBoard(id);
    return true;
  }) ?? false;
}
export function progress(id: string): Progress {
  return (ID.test(id) ? read<Progress>(sidecar(id, "progress")) : undefined) ?? { seq: 0, step: 0, narrating: false, at: 0 };
}

export function takeView(id: string, view: string): boolean {
  return withBoard(id, () => {
    writePrivate(sidecar(id, "view"), { view });
    touchBoard(id);
    return true;
  }) ?? false;
}
export function isLiveView(id: string, view: string): boolean {
  const v = ID.test(id) ? read<{ view: string }>(sidecar(id, "view")) : undefined;
  return !v || v.view === view;
}

export function hasView(id: string) {
  return ID.test(id) && existsSync(sidecar(id, "view"));
}

export function accepts(id: string, topic?: number, view?: string, b = getBoard(id)) {
  return !!b && (topic === undefined || topicOf(b) === topic) && (!view || isLiveView(id, view));
}

/** Serialize a change to the editable drawing with other writers on the same board. */
export function withBoard<T>(id: string, use: (db: DatabaseSync, board: Board) => T): T | undefined {
  if (!ID.test(id) || !existsSync(fileOf(id))) return;
  const db = openJournal(id);
  try {
    db.exec("BEGIN IMMEDIATE");
    const board = loadBoard(id, db);
    if (!board) return;
    const result = use(db, board);
    db.exec("COMMIT");
    return result;
  } finally { db.close(); }
}

/** Everything drawn after `since` (the board waits on this). From the start: only since the last clear. */
export function updates(id: string, since: number) {
  const b = getBoard(id);
  if (!b) return null;
  const cleared = b.events.findLastIndex((e) => e.clear);
  const events = b.events.filter((e, i) => e.seq > since && i >= cleared);
  return { title: b.title, topic: topicOf(b), events, now: Date.now() };
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
