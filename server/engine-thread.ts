/**
 * The main thread's side of the engine thread. Two rules from onnxruntime-node:
 *   - ONE engine thread per process. (1.21 crashed with two. 1.31 doesn't, but one is all the CPU can
 *     use here, and it keeps the voice and the ears from competing.)
 *   - Never end the thread, or the process, during an inference. So shutdown waits for the job in
 *     progress, and a job that hangs is reported, not killed.
 *
 * It loads on demand and ends after a few idle minutes: the models are ~450 MB of memory, which shouldn't
 * be held while nobody is learning. Loading again takes about half a second.
 */
import { Worker } from "node:worker_threads";
import type { Job } from "./engine-worker.ts";
import { log } from "./log.ts";

// Next to this file, as TypeScript from source or as JavaScript in the bundle.
const ENTRY = new URL(import.meta.url.endsWith(".ts") ? "./engine-worker.ts" : "./engine-worker.js", import.meta.url);
// A piece takes 1 s on a quiet M2. On a swamped Mac it can take a minute, and that is late, not hung.
const TIMEOUT_MS = 180_000;
const IDLE_UNLOAD_MS = Number(process.env.DUDELING_UNLOAD_MS) || 180_000;
const STOP_WAIT_MS = 10_000;

export class EngineLoadError extends Error {}
class EngineDied extends Error {}

interface Running {
  id: number;
  resolve: (value: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  idle: () => void;
}

class EngineThread {
  private worker: Worker | null = null;
  private running: Running | null = null;
  /** Resolves when the thread isn't in an inference. */
  private idle: Promise<void> = Promise.resolve();
  private last: Promise<unknown> = Promise.resolve();
  private hung = false;
  private stopped = false;
  private id = 0;
  private dieNext = false;
  private queued = 0;
  private idleTimer: NodeJS.Timeout | null = null;

  /** Run a job, one at a time. One whose thread died under it is tried once more on a fresh thread. */
  run<T>(job: Omit<Job, "id">): Promise<T> {
    this.queued++;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const result = this.last.then(async () => {
      try {
        const die = this.dieNext;
        this.dieNext = false;
        return await this.attempt<T>(die ? { ...job, die } : job);
      } catch (e) {
        if (!(e instanceof EngineDied) || this.stopped) throw e;
        log(`the engine stopped (${e.message}); restarting it`);
        return this.attempt<T>(job);
      }
    });
    this.last = result
      .catch(() => undefined)
      .then(() => {
        if (--this.queued || this.stopped) return;
        this.idleTimer = setTimeout(() => this.unload(), IDLE_UNLOAD_MS);
        this.idleTimer.unref();
      });
    return result;
  }

  /** End the idle thread to free its models. In the chain, so a new one never starts beside it. */
  private unload() {
    this.last = this.last.then(async () => {
      const worker = this.worker;
      if (!worker || this.queued || this.running || this.stopped) return;
      await this.attempt({ kind: "voice", release: true }).catch(() => {});
      this.worker = null; // (a job that arrived meanwhile waits in the chain for a fresh thread)
      await worker.terminate();
    });
  }

  get loaded() {
    return !!this.worker;
  }

  private attempt<T>(job: Omit<Job, "id">): Promise<T> {
    if (this.stopped) return Promise.reject(new Error("the engine is shut down"));
    if (this.hung) return Promise.reject(new Error("the engine isn't responding: restart Claude to fix Dudeling's voice"));
    const worker = (this.worker ??= this.spawn());
    const id = ++this.id;
    return new Promise<T>((resolve, reject) => {
      let idle!: () => void;
      this.idle = new Promise<void>((r) => (idle = r));
      const timer = setTimeout(() => {
        this.hung = true; // until it answers
        reject(new Error("the engine timed out"));
      }, TIMEOUT_MS);
      this.running = { id, resolve, reject, timer, idle };
      worker.ref(); // a job in progress keeps the process up; an idle engine doesn't
      worker.postMessage({ id, ...job });
    });
  }

  private spawn(): Worker {
    // stdout is the MCP protocol: whatever an engine prints goes to stderr. A test runner's flags don't apply to it.
    // `stdout: true` keeps the thread's output off the protocol. (Don't read that stream here: a reader keeps the
    // process alive forever. The thread sends what it prints to stderr itself.)
    const worker = new Worker(ENTRY, { stdout: true, execArgv: [] });
    worker.on("message", (m: { id: number; value?: unknown; error?: string; loading?: boolean }) => {
      if (m.id !== this.running?.id) return;
      const job = this.settle()!;
      worker.unref();
      if (m.error === undefined) job.resolve(m.value);
      else job.reject(m.loading ? new EngineLoadError(m.error) : new Error(m.error));
    });
    let reason = "";
    worker.on("error", (e) => (reason = String(e)));
    worker.on("exit", (code) => {
      if (this.worker !== worker) return; // unloaded on purpose
      this.worker = null;
      this.settle()?.reject(new EngineDied(reason || `exit ${code}`));
    });
    worker.unref();
    return worker;
  }

  private settle(): Running | null {
    const job = this.running;
    this.running = null;
    this.hung = false;
    if (job) (clearTimeout(job.timer), job.idle());
    return job;
  }

  /** Tests: the thread dies at the start of the next job. */
  killOnNextJob() {
    this.dieNext = true;
  }

  /** True once it's safe to end the process. */
  async stop(): Promise<boolean> {
    this.stopped = true;
    let timer!: NodeJS.Timeout;
    const safe = await Promise.race([this.idle.then(() => true), new Promise<boolean>((r) => (timer = setTimeout(r, STOP_WAIT_MS, false)))]);
    clearTimeout(timer);
    if (safe) await this.worker?.terminate();
    return safe;
  }
}

export const engineThread = new EngineThread();
