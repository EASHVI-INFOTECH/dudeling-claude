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
const audioFile = (text: string) => join(audioDir(), createHash("sha256").update(`${VOICE}|${text}`).digest("hex").slice(0, 32));
type Audio = { bytes: Buffer; durationMs: number };
function readAudio(text: string): Audio | null {
  const path = audioFile(text);
  try {
    const bytes = readFileSync(path + ".wav");
    if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF" || !bytes.readUInt32LE(28) || bytes.readUInt32LE(40) !== bytes.length - 44) return null;
    return { bytes, durationMs: Math.round((bytes.length - 44) * 1000 / bytes.readUInt32LE(28)) };
  } catch {
    try {
      const old = JSON.parse(readFileSync(path + ".json", "utf8")) as Spoken;
      return { bytes: Buffer.from(old.wav, "base64"), durationMs: old.durationMs };
    } catch { return null; }
  }
}
let swept = 0;
let writtenSinceSweep = 0;
function sweepAudio(written: number, now = Date.now()) {
  writtenSinceSweep += written;
  if (now - swept < 3600_000 && writtenSinceSweep < 8 * 1024 * 1024) return;
  swept = now;
  writtenSinceSweep = 0;
  const files = readdirSync(audioDir()).filter(f => /\.(wav|json)$/.test(f)).map(name => {
    const path = join(audioDir(), name);
    return { path, stat: statSync(path, { throwIfNoEntry: false }) };
  }).sort((a, b) => (b.stat?.mtimeMs ?? 0) - (a.stat?.mtimeMs ?? 0));
  let bytes = 0;
  for (const { path, stat } of files) {
    if (!stat) continue;
    bytes += stat.size;
    if (bytes > 192 * 1024 * 1024 || now - stat.mtimeMs > 86400_000) rmSync(path, { force: true });
  }
}

interface Waiter {
  group?: string;
  resolve: (s: Audio) => void;
  reject: (e: Error) => void;
}
interface Pending {
  text: string;
  rank: number;
  order: number;
  waiters: Waiter[];
}
const cache = new Map<string, Audio>();
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

function remember(text: string, s: Audio) {
  cache.delete(text);
  cache.set(text, s);
  let bytes = 0;
  for (const item of cache.values()) bytes += item.bytes.length;
  for (const [key, item] of cache) {
    if (cache.size <= CACHE_MAX && bytes <= 16 * 1024 * 1024) break;
    bytes -= item.bytes.length;
    cache.delete(key);
  }
}

/** One piece's audio. Asking again for a piece that's waiting can only make it more urgent. */
export async function speak(text: string, opts?: SpeakOptions): Promise<Spoken> {
  const { bytes, durationMs } = await enqueue(text, opts);
  return { wav: bytes.toString("base64"), durationMs };
}

export function prefetch(text: string, opts?: SpeakOptions) {
  void enqueue(text, opts).catch(() => {});
}

function enqueue(text: string, { priority = "current", group }: SpeakOptions = {}): Promise<Audio> {
  const key = text.trim();
  const hit = cache.get(key) ?? readAudio(key);
  if (hit) {
    remember(key, hit);
    return Promise.resolve(hit);
  }
  return new Promise<Audio>((resolve, reject) => {
    const rank = PRIORITIES.indexOf(priority);
    let job = pending.get(key);
    if (!job) pending.set(key, (job = { text: key, rank, order: order++, waiters: [] }));
    job.rank = Math.min(job.rank, rank);
    job.waiters.push({ group, resolve, reject });
    queueMicrotask(next); // calls made together are ordered before the first one starts
  });
}

/** Drop what's waiting for a group. The piece being made finishes (and is cached). */
const belongs = (w: Waiter, group: string) => w.group === group || w.group?.startsWith(group + ":");
export function cancel(group: string) {
  for (const job of pending.values()) {
    if (job === making) continue;
    for (const w of job.waiters) if (belongs(w, group)) w.reject(new SpeechCancelled());
    job.waiters = job.waiters.filter((w) => !belongs(w, group));
    if (!job.waiters.length) pending.delete(job.text);
  }
}

/** The learner cut in: what was urgent for this board isn't any more. It stays queued, behind the answer. */
export function demote(group: string) {
  const ahead = PRIORITIES.indexOf("ahead");
  for (const job of pending.values()) if (job !== making && job.waiters.every((w) => belongs(w, group))) job.rank = ahead;
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
      const made = await engineThread.run<{ bytes: Uint8Array<ArrayBuffer>; durationMs: number }>({ kind: "voice", text: job.text });
      s = { bytes: Buffer.from(made.bytes.buffer, made.bytes.byteOffset, made.bytes.byteLength), durationMs: made.durationMs };
      failedAt = 0;
      try {
        writePrivate(audioFile(job.text) + ".wav", s.bytes);
        sweepAudio(s.bytes.length);
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
