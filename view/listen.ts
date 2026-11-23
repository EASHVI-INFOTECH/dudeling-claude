/**
 * The board's ears: the microphone, with speech detection, for Dudeling voice sessions.
 *
 * Always listening once started: when the learner starts talking it says so at once (so the board can
 * pause its narration — an interruption), and when they stop it hands over the utterance as 16 kHz WAV
 * (base64) to be transcribed by the plugin. Echo cancellation keeps Dudeling's own voice out; while
 * Dudeling is talking, speech must also be louder and longer to count, so the board doesn't hear itself.
 */
export interface ListenerEvents {
  /** The learner started talking. */
  speechStart(): void;
  /** They stopped: what they said, as 16 kHz 16-bit mono WAV (base64). */
  utterance(wav: string, seconds: number): void;
  /** Live input level 0..1 (for the UI). */
  level?(level: number): void;
  /** The microphone went away (unplugged, or access taken back). */
  ended?(): void;
}

const QUIET_END_MS = 900; // this much quiet ends an utterance
const MAX_UTTERANCE_MS = 30_000;
// Keep audio from before speech was detected: detection waits for clearly-speech (longer while Dudeling talks),
// so the first words ("Wait, what is…") would otherwise be lost.
const PREROLL_MS = 1200;

export class Listener {
  /** Dudeling is talking: be stricter, so its voice (leaking past echo cancellation) isn't taken for the learner. */
  dudelingTalking = false;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: ScriptProcessorNode | null = null;
  private frames: Float32Array[] = [];
  private preroll: Float32Array[] = [];
  private speaking = false;
  private loudSince = 0;
  private lastLoud = 0;
  private startedAt = 0;
  /** Bumped by every start and stop: whatever an older one was waiting for gives up. */
  private attempt = 0;
  private events: ListenerEvents;

  constructor(events: ListenerEvents) {
    this.events = events;
  }

  get on() {
    return !!this.node;
  }

  /**
   * Ask for the microphone and start listening (call from a click). False if stopped meanwhile (the
   * microphone is released). Throws if the mic is refused.
   */
  async start(): Promise<boolean> {
    if (this.node) return true;
    const attempt = ++this.attempt;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    if (attempt !== this.attempt) {
      stream.getTracks().forEach((t) => t.stop());
      return false;
    }
    this.stream = stream;
    try {
      this.ctx = new AudioContext();
      await this.ctx.resume();
    } catch (e) {
      if (attempt !== this.attempt) return false; // closed by stop() while resuming
      this.stop();
      throw e;
    }
    if (attempt !== this.attempt) return false;
    stream.getAudioTracks()[0]?.addEventListener("ended", () => attempt === this.attempt && this.events.ended?.());
    const src = this.ctx.createMediaStreamSource(stream);
    // ScriptProcessor: deprecated but works everywhere (incl. sandboxed iframes, where AudioWorklet modules can't load).
    this.node = this.ctx.createScriptProcessor(2048, 1, 1);
    this.node.onaudioprocess = (e) => this.feed(new Float32Array(e.inputBuffer.getChannelData(0)));
    src.connect(this.node);
    this.node.connect(this.ctx.destination); // needed for onaudioprocess to fire; outputs silence
    return true;
  }

  stop() {
    this.attempt++;
    if (this.node) this.node.onaudioprocess = null;
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close().catch(() => {});
    this.node = null;
    this.stream = null;
    this.ctx = null;
    this.speaking = false;
    this.frames = [];
    this.preroll = [];
    this.loudSince = 0;
  }

  private feed(frame: Float32Array) {
    if (!this.ctx) return; // a callback queued before stop()
    const rate = this.ctx.sampleRate;
    let sum = 0;
    for (const v of frame) sum += v * v;
    const level = Math.sqrt(sum / frame.length);
    this.events.level?.(Math.min(1, level * 12));
    const now = performance.now();
    const threshold = this.dudelingTalking ? 0.06 : 0.02;
    const minSpeechMs = this.dudelingTalking ? 350 : 150;
    const loud = level > threshold;

    if (!this.speaking) {
      this.preroll.push(frame);
      while (this.preroll.length * frame.length > (PREROLL_MS / 1000) * rate) this.preroll.shift();
      if (loud) {
        this.loudSince ||= now;
        if (now - this.loudSince >= minSpeechMs) {
          this.speaking = true;
          this.startedAt = now;
          this.lastLoud = now;
          this.frames = [...this.preroll];
          this.preroll = [];
          this.events.speechStart();
        }
      } else this.loudSince = 0;
      return;
    }

    this.frames.push(frame);
    if (level > 0.02) this.lastLoud = now;
    if (now - this.lastLoud > QUIET_END_MS || now - this.startedAt > MAX_UTTERANCE_MS) {
      this.speaking = false;
      this.loudSince = 0;
      const samples = concat(this.frames);
      this.frames = [];
      this.events.utterance(toWav16k(samples, rate), samples.length / rate);
    }
  }
}

function concat(frames: Float32Array[]): Float32Array {
  const out = new Float32Array(frames.reduce((n, f) => n + f.length, 0));
  let o = 0;
  for (const f of frames) (out.set(f, o), (o += f.length));
  return out;
}

/** Resample to 16 kHz (linear) and encode as 16-bit mono WAV, base64. */
export function toWav16k(samples: Float32Array, rate: number): string {
  const ratio = rate / 16000;
  const n = Math.floor(samples.length / ratio);
  const bytes = new Uint8Array(44 + n * 2);
  const v = new DataView(bytes.buffer);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  str(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true);
  v.setUint32(28, 32000, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const x = i * ratio;
    const j = Math.floor(x);
    const s = samples[j] * (1 - (x - j)) + (samples[j + 1] ?? 0) * (x - j);
    v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 32767, true);
  }
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
