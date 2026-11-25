/**
 * One engine per computer. A chat app may start this plugin more than once (Claude Desktop runs one copy
 * for the assistant's tool calls and another for the board's), and each copy loading the voice (Kokoro)
 * and ears (Whisper) would double the memory and CPU. So the first copy to start becomes the engine: it
 * loads the models and serves them on a private local socket (a named pipe on Windows). Other copies
 * forward to it. If the engine copy goes away, the next request makes another copy the engine.
 *
 * The socket's name carries the version, so copies of different versions never talk to each other. Only
 * the holder of the election lock removes a socket, and only after seeing that nobody answers on it.
 */
import { createHash } from "node:crypto";
import { chmodSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import * as hearing from "./hearing.ts";
import { unsupportedHere } from "./models.ts";
import { stateDir } from "./store.ts";
import { VERSION } from "./version.ts";
import * as voice from "./voice.ts";
import { log } from "./log.ts";

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const MAX_SOCKET_PATH = 103; // macOS's limit
const MAX_BODY = 5_000_000;
const ELECTION_MS = 10_000;
/** Audio made ahead may wait behind a whole lesson part on a busy Mac. */
const SPEAK_MS = 15 * 60_000;

function socketPath(): string {
  if (process.platform === "win32") return `\\\\.\\pipe\\dudeling-engine-${hash(`${userInfo().username}|${stateDir()}|${VERSION}`)}`;
  const path = join(stateDir(), `engine-${hash(VERSION)}.sock`);
  return Buffer.byteLength(path) <= MAX_SOCKET_PATH ? path : join(tmpdir(), `dudeling-${hash(`${stateDir()}|${VERSION}`)}.sock`);
}
const lockPath = () => join(stateDir(), `engine-${hash(VERSION)}.lock`);

let role: "engine" | "client" | null = null;
let server: Server | null = null;
let electing: Promise<void> | null = null;
let stopped = false;

/** The engine copy isn't there (any more): elect again. */
class EngineGone extends Error {}

/** Ask the engine copy (over the local socket). */
function call<T>(path: string, body?: unknown, timeoutMs = 180_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = request(
      { socketPath: socketPath(), path, method: data ? "POST" : "GET", headers: data ? { "content-type": "application/json", "content-length": data.length } : {}, timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("error", (e) => reject(new EngineGone(String(e))));
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (res.statusCode === 200) resolve(json as T);
            else if (res.statusCode === 409) reject(new voice.SpeechCancelled());
            else if (res.statusCode === 503) reject(new EngineGone("the engine copy is shutting down"));
            else reject(new Error(json.error ?? `engine ${res.statusCode}`));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("engine timeout")));
    req.on("error", (e: NodeJS.ErrnoException) => reject(["ECONNREFUSED", "ENOENT", "EPIPE", "ECONNRESET"].includes(e.code ?? "") ? new EngineGone(String(e)) : e));
    if (data) req.write(data);
    req.end();
  });
}

function serve(): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("error", () => {});
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) req.destroy();
        else chunks.push(c);
      });
      req.on("end", async () => {
        const reply = (status: number, json: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(json));
        };
        try {
          if (stopped) return reply(503, { error: "shutting down" });
          const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
          if (req.url === "/ping") return reply(200, { ok: true, pid: process.pid });
          if (req.url === "/prefetch") return reply(200, (voice.prefetch(String(body.text ?? ""), { priority: body.priority, group: body.group }), {}));
          if (req.url === "/speak") return reply(200, await voice.speak(String(body.text ?? ""), { priority: body.priority, group: body.group }));
          if (req.url === "/transcribe") return reply(200, { text: await hear(String(body.wav ?? "")) });
          if (req.url === "/cancel") return reply(200, (voice.cancel(String(body.group ?? "")), {}));
          if (req.url === "/hold") return reply(200, (voice.holdAhead(), {}));
          if (req.url === "/interrupt") return reply(200, (cutIn(String(body.group ?? "")), {}));
          if (req.url === "/prepare") return reply(200, (load(body.kind === "hearing" ? "hearing" : "voice"), {}));
          reply(404, { error: "not found" });
        } catch (e) {
          reply(stopped ? 503 : e instanceof voice.SpeechCancelled ? 409 : 500, { error: String(e).slice(0, 300) });
        }
      });
    });
    s.once("error", () => resolve(false));
    s.listen(socketPath(), () => {
      if (process.platform !== "win32") chmodSync(socketPath(), 0o600);
      server = s;
      s.unref(); // never keeps the process alive on its own
      resolve(true);
    });
  });
}

const answers = () => call("/ping", undefined, 2000).then(() => true, () => false);

function takeLock(): boolean {
  try {
    writeFileSync(lockPath(), String(process.pid), { flag: "wx", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** A lock left by a copy that died while electing. */
function dropStaleLock() {
  try {
    const age = Date.now() - statSync(lockPath()).mtimeMs;
    const pid = Number(readFileSync(lockPath(), "utf8"));
    if (!pid && age < 1000) return; // just being written
    let alive = !!pid;
    try {
      if (pid) process.kill(pid, 0);
    } catch {
      alive = false;
    }
    if (!alive || age > ELECTION_MS) rmSync(lockPath(), { force: true });
  } catch {
    /* it's gone */
  }
}

/** Become the engine, or find the one that's running. */
async function elect(): Promise<void> {
  for (const until = Date.now() + ELECTION_MS; Date.now() < until && !stopped; ) {
    if (await answers()) return void (role = "client");
    if (takeLock()) {
      try {
        if (await answers()) return void (role = "client"); // someone finished electing just before us
        if (process.platform !== "win32") rmSync(socketPath(), { force: true }); // nobody answers on it: a leftover
        if (await serve()) {
          role = "engine";
          log(`this copy (pid ${process.pid}) is the voice/hearing engine`);
          return;
        }
      } finally {
        rmSync(lockPath(), { force: true });
      }
    } else dropStaleLock();
    await sleep(50 + Math.random() * 100);
  }
}

const ensure = () => (role ? Promise.resolve() : (electing ??= elect().finally(() => (electing = null))));

/** Run on the engine: here if this copy is it, else forwarded (re-electing once if the engine went away). */
async function onEngine<T>(local: () => Promise<T> | T, remote: () => Promise<T>): Promise<T> {
  await ensure();
  if (role !== "client") return local();
  try {
    return await remote();
  } catch (e) {
    if (!(e instanceof EngineGone)) throw e;
    role = null;
    await ensure();
    return role === "client" ? remote() : local();
  }
}

/** Hearing also holds back audio for later lines: a reply is probably next. */
function hear(wav: string) {
  voice.holdAhead();
  return hearing.transcribe(wav);
}

export const speak = (text: string, opts: voice.SpeakOptions = {}) =>
  onEngine(
    () => voice.speak(text, opts),
    () => call<voice.Spoken>("/speak", { text, ...opts }, SPEAK_MS),
  );
export const prefetch = (text: string, opts: voice.SpeakOptions) =>
  onEngine<void>(() => voice.prefetch(text, opts), () => call("/prefetch", { text, ...opts }, 5000));
export const transcribe = (wav: string) =>
  onEngine(
    () => hear(wav),
    () => call<{ text: string }>("/transcribe", { wav }).then((r) => r.text),
  );
export const cancel = (group: string) =>
  onEngine<void>(
    () => voice.cancel(group),
    () => call("/cancel", { group }, 5000),
  ).catch(() => {});
export const hold = () =>
  onEngine<void>(
    () => voice.holdAhead(),
    () => call("/hold", {}, 5000),
  ).catch(() => {});

function cutIn(group: string) {
  voice.demote(group);
  voice.holdAhead();
}
/** The learner started talking or typed: what was urgent isn't, and what's ahead waits. */
export const interrupt = (group: string) =>
  onEngine<void>(
    () => cutIn(group),
    () => call("/interrupt", { group }, 5000),
  ).catch(() => {});

function load(kind: "voice" | "hearing") {
  if (unsupportedHere()) return;
  if (kind === "voice" && voice.voiceInstalled()) void voice.warm().catch(() => {});
  if (kind === "hearing" && hearing.hearingInstalled()) void hearing.warmHearing().catch(() => {});
}
/** Load a model just before it's needed (a board opened, Talk pressed). */
export const prepare = (kind: "voice" | "hearing") =>
  onEngine<void>(
    () => load(kind),
    () => call("/prepare", { kind }, 5000),
  ).catch(() => {});

/** At start-up: only decide the role. Nothing loads until someone learns. */
export async function start() {
  await ensure();
}

export const engineRole = () => role;

/** True once it's safe to end the process. */
export async function stop(): Promise<boolean> {
  stopped = true;
  const safe = await voice.stopVoice();
  // Closing removes the socket file, so the next copy becomes the engine at once.
  server?.close();
  server?.closeAllConnections();
  return safe;
}
