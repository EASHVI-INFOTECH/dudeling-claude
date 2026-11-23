/**
 * Dudeling's voice, inside the plugin: Kokoro (82M-parameter TTS, q8, ~92 MB) runs natively on the CPU
 * of whatever machine runs this server (~1.8× faster than real time on an M2), on its own thread.
 *
 * This module is the queue in front of it. A line is made a piece at a time (speech-text.ts), and the
 * most urgent piece goes first: a reply, then the line being played, then the next one, then the rest
 * of the part made ahead. Clearing a board drops what was waiting for it.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseCues } from "../board/tutor/rails.ts";
import { EngineLoadError, engineThread } from "./engine-thread.ts";
import { MODELS_DIR, VOICE, downloadsAllowed, unsupportedHere, voiceInstalled } from "./models.ts";
import { privateDir, writePrivate } from "./store.ts";
import { toWav } from "./wav.ts";
import { log } from "./log.ts";

export { MODELS_DIR, toWav, voiceInstalled };

export const PRIORITIES = ["reply", "current", "next", "ahead"] as const;
export type Priority = (typeof PRIORITIES)[number];

export interface Spoken {
  /** 16-bit mono WAV, base64. */
  wav: string;
  durationMs: number;
}
export interface SpeakOptions {
  priority?: Priority;
  /** Who it's for (a board): `cancel(group)` drops what is still waiting for them. */
  group?: string;
}
export class SpeechCancelled extends Error {
  constructor() {
    super("speech cancelled");
  }
}

/** A failed load (e.g. a file locked or missing) is retried after this long. */
const RETRY_MS = 60_000;
const CACHE_MAX = 128;
/** After the learner speaks, audio for later lines waits this long at most, so their reply finds the engine free. */
const HOLD_MS = 20_000; // (Claude takes ~10 s to answer)

let failedAt = 0;

/** "ready" means: ask and it speaks (the model loads with the first line if it hasn't yet). */
export function voiceStatus(): "ready" | "not-installed" | "failed" | "unsupported" {
  if (unsupportedHere()) return "unsupported";
  if (failedAt && Date.now() - failedAt < RETRY_MS) return "failed";
  return voiceInstalled() || downloadsAllowed() ? "ready" : "not-installed";
}

/** Load the model ahead of the first line. */
export const warm = () => engineThread.run({ kind: "voice" }).then(() => undefined);

/**
 * The words a line says: its [n] sync markers removed — the board's own rails function, so the board's
 * request for a line finds the audio made ahead of time here.
 */
export const spokenText = (raw: string): string => parseCues(raw).text;

/**
 * Finished audio is also kept in files next to the boards, for a day: the plugin may run as several
 * processes, so a line made by one is found by the other.
 */
const audioDir = () => privateDir("audio");
const audioFile = (text: string) => join(audioDir(), `${createHash("sha256").update(`${VOICE}|${text}`).digest("hex").slice(0, 32)}.json`);
function readAudio(text: string): Spoken | null {
  try {
    const s = JSON.parse(readFileSync(audioFile(text), "utf8")) as Spoken;
    return s.wav && s.durationMs ? s : null;
  } catch {
    return null;
  }
}
let swept = 0;
function sweepAudio(now = Date.now()) {
  if (now - swept < 60 * 60_000) return;
  swept = now;
  try {
    for (const f of readdirSync(audioDir())) if (now - statSync(join(audioDir(), f)).mtimeMs > 24 * 60 * 60_000) rmSync(join(audioDir(), f), { force: true });
  } catch {
    /* best effort */
  }
}

interface Waiter {
  group?: string;
  resolve: (s: Spoken) => void;
  reject: (e: Error) => void;
}
interface Pending {
  text: string;
  rank: number;
  order: number;
  waiters: Waiter[];
}
const cache = new Map<string, Spoken>();
const pending = new Map<string, Pending>();
let making: Pending | null = null;
let order = 0;
let heldUntil = 0;
let holdTimer: NodeJS.Timeout | null = null;

/** The learner is talking or just has: don't start on lines that aren't needed yet. */
export function holdAhead(ms = HOLD_MS) {
  heldUntil = Date.now() + ms;
  if (holdTimer) clearTimeout(holdTimer);
  holdTimer = setTimeout(release, ms);
  holdTimer.unref();
}
function release() {
  heldUntil = 0;
  if (holdTimer) clearTimeout(holdTimer);
  holdTimer = null;
  next();
}

function remember(text: string, s: Spoken) {
  cache.delete(text);
  cache.set(text, s);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
}

/** One piece's audio. Asking again for a piece that's waiting can only make it more urgent. */
export function speak(text: string, { priority = "current", group }: SpeakOptions = {}): Promise<Spoken> {
  const key = text.trim();
  const hit = cache.get(key) ?? readAudio(key);
  if (hit) {
    remember(key, hit);
    return Promise.resolve(hit);
  }
  return new Promise<Spoken>((resolve, reject) => {
    const rank = PRIORITIES.indexOf(priority);
    let job = pending.get(key);
    if (!job) pending.set(key, (job = { text: key, rank, order: order++, waiters: [] }));
    job.rank = Math.min(job.rank, rank);
    job.waiters.push({ group, resolve, reject });
    queueMicrotask(next); // calls made together are ordered before the first one starts
  });
}

/** Drop what's waiting for a group. The piece being made finishes (and is cached). */
export function cancel(group: string) {
  for (const job of pending.values()) {
    if (job === making) continue;
    for (const w of job.waiters) if (w.group === group) w.reject(new SpeechCancelled());
    job.waiters = job.waiters.filter((w) => w.group !== group);
    if (!job.waiters.length) pending.delete(job.text);
  }
}

/** The learner cut in: what was urgent for this board isn't any more. It stays queued, behind the answer. */
export function demote(group: string) {
  const ahead = PRIORITIES.indexOf("ahead");
  for (const job of pending.values()) if (job !== making && job.waiters.every((w) => w.group === group)) job.rank = ahead;
}

function next() {
  if (making) return;
  let best: Pending | null = null;
  const held = Date.now() < heldUntil;
  for (const job of pending.values())
    if (held && PRIORITIES[job.rank] === "ahead") continue;
    else if (!best || job.rank < best.rank || (job.rank === best.rank && job.order < best.order)) best = job;
  if (!best) return;
  making = best;
  void make(best).finally(() => {
    making = null;
    next();
  });
}

async function make(job: Pending) {
  try {
    if (testing.failNext) throw ((testing.failNext = false), new Error("test failure"));
    // Another copy of the plugin may have made it while it waited here.
    let s = readAudio(job.text);
    if (!s) {
      s = await engineThread.run<Spoken>({ kind: "voice", text: job.text });
      failedAt = 0;
      try {
        writePrivate(audioFile(job.text), s);
        sweepAudio();
      } catch {
        /* the file cache is best effort */
      }
    }
    remember(job.text, s);
    pending.delete(job.text);
    for (const w of job.waiters) w.resolve(s);
    if (PRIORITIES[job.rank] === "reply" && ![...pending.values()].some((j) => PRIORITIES[j.rank] === "reply")) release();
  } catch (e) {
    if (e instanceof EngineLoadError) {
      failedAt = Date.now();
      log(`voice model failed to load: ${e.message}`);
    }
    pending.delete(job.text);
    for (const w of job.waiters) w.reject(e instanceof Error ? e : new Error(String(e)));
  }
}

/** Tests only. */
export const testing = { failNext: false, killWorker: () => engineThread.killOnNextJob(), engineLoaded: () => engineThread.loaded };

/** Drop the queue, let the piece being made finish, then end the engine. True if it's safe to exit. */
export function stopVoice(): Promise<boolean> {
  for (const job of pending.values())
    if (job !== making) {
      for (const w of job.waiters) w.reject(new SpeechCancelled());
      pending.delete(job.text);
    }
  return engineThread.stop();
}
