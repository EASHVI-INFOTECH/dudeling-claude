/**
 * The engine thread: runs the voice and the ears. ONNX's `run` blocks its thread for seconds, so it
 * never runs on the thread that answers Claude and the board. Claude Desktop can't start a child Node
 * process (Electron's RunAsNode is off), hence a worker thread rather than a process.
 */
import { readFileSync } from "node:fs";
import { parentPort } from "node:worker_threads";
import { AutoTokenizer, StyleTextToSpeech2Model, env, pipeline } from "@huggingface/transformers";
import { MODELS_DIR, STT_MODEL, TTS_MODEL, VOICE, downloadsAllowed } from "./models.ts";
import { toWav } from "./wav.ts";

export type Kind = "voice" | "hearing";
export interface Job {
  id: number;
  kind: Kind;
  text?: string;
  samples?: Float32Array;
  /** Tests: the thread ends, as if it had crashed. */
  die?: boolean;
  /** Give the models back before the thread ends: ending it alone doesn't free ONNX's memory. */
  release?: boolean;
}

process.stdout.write = process.stderr.write.bind(process.stderr); // what the engines print is log, not protocol
env.cacheDir = MODELS_DIR;
env.allowRemoteModels = downloadsAllowed();

type Run = (job: Job) => Promise<unknown>;
const loaded: { dispose(): Promise<unknown> }[] = [];

/**
 * ONNX's threads busy-wait by default. Measured on an M2 (Kokoro q8, 1.31): letting them sleep is as fast
 * on a quiet Mac for ~45% less CPU, and with the Mac busy it's faster for half the CPU (spinning threads
 * fight everything else for the cores). Three threads is where more stops helping.
 */
const SESSION = { intraOpNumThreads: 3, interOpNumThreads: 1, extra: { session: { intra_op: { allow_spinning: "0" } } } };

async function voice(): Promise<Run> {
  const { KokoroTTS } = await import("kokoro-js");
  // (KokoroTTS.from_pretrained can't pass session options.)
  const model = await StyleTextToSpeech2Model.from_pretrained(TTS_MODEL, { dtype: "q8", device: "cpu", session_options: SESSION });
  loaded.push(model);
  const tts = new KokoroTTS(model as never, await AutoTokenizer.from_pretrained(TTS_MODEL));
  return async ({ text }) => {
    if (!text) return null; // warm-up only
    const audio = await tts.generate(text, { voice: VOICE });
    const samples = audio.audio as Float32Array;
    return { bytes: new Uint8Array(toWav(samples, audio.sampling_rate)), durationMs: Math.round((samples.length / audio.sampling_rate) * 1000) };
  };
}

async function hearing(): Promise<Run> {
  const asr = (await pipeline("automatic-speech-recognition", STT_MODEL, { dtype: "q8", device: "cpu", session_options: SESSION })) as unknown as (
    audio: Float32Array,
    options: { max_new_tokens: number },
  ) => Promise<{ text: string } | { text: string }[]>;
  loaded.push(asr as unknown as { dispose(): Promise<unknown> });
  return async ({ samples }) => {
    if (!samples) return null; // warm-up only
    // Uncapped, noise can send Whisper round in circles for 448 tokens (16 s of CPU for no words).
    const out = await asr(samples, { max_new_tokens: Math.ceil((samples.length / 16000) * 8) + 16 });
    return (Array.isArray(out) ? out.map((o) => o.text).join(" ") : out.text).trim();
  };
}

/**
 * Tests only: DUDELING_TEST_SLOW_FILE holds how many ms each piece of speech takes, as on a swamped Mac
 * (where every overload bug hid). The thread is blocked for that long, as a real inference blocks it.
 */
function slowDown(job: Job) {
  const file = process.env.DUDELING_TEST_SLOW_FILE;
  if (!file || !job.text) return;
  let ms = 0;
  try {
    ms = Number(readFileSync(file, "utf8")) || 0;
  } catch {
    /* full speed */
  }
  if (ms) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const models: Partial<Record<Kind, Promise<Run>>> = {};
parentPort!.on("message", async (job: Job) => {
  if (job.die) return process.exit(1); // (in a thread: ends only the thread)
  if (job.release) {
    for (const model of loaded.splice(0)) await model.dispose().catch(() => {});
    return parentPort!.postMessage({ id: job.id, value: null });
  }
  try {
    const { kind } = job;
    models[kind] ??= kind === "voice" ? voice() : hearing();
    const run = await models[kind]!.catch((e) => {
      delete models[kind];
      throw Object.assign(new Error(String(e)), { loading: true });
    });
    slowDown(job);
    const value = await run(job);
    const bytes = (value as { bytes?: Uint8Array<ArrayBuffer> } | null)?.bytes;
    parentPort!.postMessage({ id: job.id, value }, bytes ? [bytes.buffer] : []);
  } catch (e) {
    parentPort!.postMessage({ id: job.id, error: String(e).slice(0, 300), loading: (e as { loading?: boolean }).loading === true });
  }
});
