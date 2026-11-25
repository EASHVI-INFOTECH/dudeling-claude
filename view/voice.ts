/**
 * The board's voice. The audio is made by the Dudeling plugin itself (Kokoro, see server/voice.ts) and
 * fetched a piece of a line at a time through the app-only `speak` tool: nothing is downloaded in the
 * chat and no GPU is needed. If the plugin has no voice, the browser's built-in one is used.
 *
 * Sound has one switch: `unlock`, from the learner's first click anywhere on the board (browsers need
 * one). Muting is separate, and keeps the lesson's timing. `stop` cancels everything asked for so far,
 * including lines still being made.
 */
import { speechPieces } from "../server/speech-text";

export type VoiceKind = "dudeling" | "browser";
export type Urgency = "reply" | "current" | "next";
export interface Spoken {
  /** Length of the audio (ms). */
  duration: number;
  /** Resolves when it has finished playing, or was stopped. */
  done: Promise<void>;
}
/** A piece's audio (base64 WAV + its length); `pending` while it's still being made; null if it can't be. */
export type Fetched = { wav: string; durationMs: number } | { pending: true } | null;
/** `bump` only makes a piece that's already asked for more urgent. */
export type FetchSpeech = (text: string, urgency: Urgency, bump?: boolean) => Promise<Fetched>;
/** Asks the plugin whether it has a voice (instant: no audio is made). */
export type ProbeVoice = () => Promise<boolean>;

const RANK: Record<Urgency, number> = { reply: 0, current: 1, next: 2 };
const CACHE_MAX = 96;
/** A piece not made by then isn't coming. (A slow Mac is late, and that's fine.) */
const GIVE_UP_MS = 5 * 60_000;
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Roughly how long a voice takes to say `text` (ms): ~155 words a minute. */
export const speechMs = (text: string) => Math.max(1200, (text.split(/\s+/).filter(Boolean).length / 2.6) * 1000);

function decodeBase64(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

interface Loading {
  urgency: Urgency;
  rank: number;
  /** No longer wanted: stop asking, so it stops being urgent. */
  stale?: boolean;
  audio: Promise<AudioBuffer | null>;
  buffer?: AudioBuffer;
}
/** One `say`, from asking for it to its last word. */
interface Take {
  cancelled: boolean;
  stopped: Promise<null>;
  stop(): void;
  sources: Set<AudioBufferSourceNode>;
}

export class Voice {
  kind: VoiceKind | null = null;
  /** Called when Dudeling starts or stops talking (the board's ears listen more strictly meanwhile). */
  onTalking: (talking: boolean) => void = () => {};
  onKind: (kind: VoiceKind) => void = () => {};

  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private muted = false;
  private cache = new Map<string, Loading>();
  private takes = new Set<Take>();
  private talking = 0;
  private known: Promise<unknown>;
  private setKnown!: () => void;
  private started = false;
  private fetchSpeech: FetchSpeech;
  private probe: ProbeVoice;
  private report: (msg: string) => void;

  constructor(fetchSpeech: FetchSpeech, probe: ProbeVoice, report: (msg: string) => void = () => {}) {
    this.fetchSpeech = fetchSpeech;
    this.probe = probe;
    this.report = report;
    this.known = new Promise<void>((r) => (this.setKnown = r));
  }

  get unlocked() {
    return this.started;
  }

  /** Call from a click. Safe to call again: it only ever turns sound on. */
  unlock() {
    if (this.ctx?.state === "suspended") void this.ctx.resume().catch(() => {});
    if (this.started) return;
    this.started = true;
    try {
      this.ctx = new AudioContext();
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.muted ? 0 : 1;
      this.gain.connect(this.ctx.destination);
      void this.ctx.resume().catch(() => {});
    } catch {
      this.ctx = null;
    }
    void (async () => {
      const ok = this.ctx ? await this.probe().catch(() => false) : false;
      if (!ok) this.report("the plugin has no voice here; using the browser's");
      this.kind = ok ? "dudeling" : "browser";
      this.setKnown();
      this.onKind(this.kind);
    })();
  }

  get audible() { return this.talking > 0 && !this.muted; }

  setMuted(muted: boolean) {
    this.muted = muted;
    this.onTalking(this.audible);
    if (this.gain) this.gain.gain.value = muted ? 0 : 1;
    if (muted && typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
  }

  /** Cut off everything being said or on its way. */
  stop() {
    for (const take of this.takes) take.stop();
    this.takes.clear();
    for (const [piece, loading] of this.cache)
      if (!loading.buffer) {
        loading.stale = true;
        this.cache.delete(piece);
      }
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
  }

  private take(): Take {
    let resolve!: (v: null) => void;
    const take: Take = {
      cancelled: false,
      stopped: new Promise<null>((r) => (resolve = r)),
      sources: new Set(),
      stop: () => {
        take.cancelled = true;
        for (const src of take.sources) {
          try {
            src.stop();
          } catch {
            /* already stopped */
          }
        }
        resolve(null);
      },
    };
    this.takes.add(take);
    return take;
  }

  private load(piece: string, urgency: Urgency): Promise<AudioBuffer | null> {
    const hit = this.cache.get(piece);
    if (hit) {
      this.cache.delete(piece);
      this.cache.set(piece, hit);
      if (!hit.buffer && RANK[urgency] < hit.rank) {
        hit.rank = RANK[urgency];
        hit.urgency = urgency;
        void this.fetchSpeech(piece, urgency, true).catch(() => null); // moves it up; the request already out brings the audio
      }
      return hit.audio;
    }
    const loading = { rank: RANK[urgency], urgency } as Loading;
    loading.audio = this.fetchPiece(piece, loading)
      .then((wav) => (wav && this.ctx ? this.ctx.decodeAudioData(decodeBase64(wav)) : null))
      .catch((e) => (this.report(`speak failed (${String(e).slice(0, 160)})`), null))
      .then((buffer) => {
        if (buffer && this.cache.get(piece) === loading) {
          loading.buffer = buffer;
          this.trimCache();
        }
        else if (this.cache.get(piece) === loading) this.cache.delete(piece); // failures aren't kept
        return buffer;
      });
    this.cache.set(piece, loading);
    this.trimCache();
    return loading.audio;
  }

  private trimCache() {
    const size = (entry: Loading) => entry.buffer ? entry.buffer.length * entry.buffer.numberOfChannels * 4 : 0;
    let bytes = 0;
    for (const entry of this.cache.values()) bytes += size(entry);
    for (const [key, entry] of this.cache) {
      if (bytes <= 24 * 1024 * 1024 && this.cache.size <= CACHE_MAX) break;
      bytes -= size(entry);
      this.cache.delete(key);
    }
  }

  /** Ask until it's made. Each request is short, so however busy the Mac is none hits the chat app's 60 s limit. */
  private async fetchPiece(piece: string, loading: Loading): Promise<string | null> {
    for (const until = Date.now() + GIVE_UP_MS; !loading.stale && Date.now() < until; ) {
      const r = await this.fetchSpeech(piece, loading.urgency);
      if (!r) return null;
      if ("wav" in r) return r.wav;
    }
    return null;
  }

  /** Start getting a line's audio now (so the next step doesn't wait). */
  prepare(text: string, urgency: Urgency = "next") {
    if (this.kind === "dudeling") for (const piece of speechPieces(text)) void this.load(piece, urgency);
  }

  /** All of it is here, so it would start at once. */
  has(text: string) {
    return speechPieces(text).every((piece) => this.cache.get(piece)?.buffer);
  }

  /** Say a line; resolves once it has started (with its length), `done` when it finishes. */
  async say(text: string, urgency: Urgency = "current"): Promise<Spoken> {
    if (!text) return { duration: 0, done: Promise.resolve() };
    const take = this.take();
    const ended = (): Spoken => (this.takes.delete(take), { duration: 0, done: Promise.resolve() });
    if (!this.started) return this.timed(text, take);
    await Promise.race([this.known, take.stopped]);
    if (take.cancelled) return ended();

    const pieces = speechPieces(text);
    const get = async (piece: string) => {
      let buffer = await Promise.race([this.load(piece, urgency), take.stopped]);
      if (!buffer && !take.cancelled) buffer = await Promise.race([this.load(piece, urgency), take.stopped]); // one retry
      return take.cancelled ? null : buffer;
    };
    let first: AudioBuffer | null = null;
    if (this.kind === "dudeling" && this.ctx && pieces.length) {
      const firstAudio = get(pieces[0]);
      for (const piece of pieces.slice(1)) void this.load(piece, urgency);
      first = await firstAudio;
    }
    if (take.cancelled) return ended();
    if (!first) return this.track(this.builtIn(text, take), take);

    const ctx = this.ctx!;
    if (ctx.state !== "running") void ctx.resume().catch(() => {});
    let endsAt = ctx.currentTime;
    const schedule = (buffer: AudioBuffer) => {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.gain!);
      const at = Math.max(ctx.currentTime, endsAt);
      src.start(at);
      endsAt = at + buffer.duration;
      take.sources.add(src);
    };
    schedule(first);
    // The whole line's length, for timing the drawing: known for pieces already here, estimated for the rest.
    const msPerChar = (first.duration * 1000) / pieces[0].length;
    const duration = pieces.reduce((ms, piece, i) => {
      const known = i ? this.cache.get(piece)?.buffer : first;
      return ms + (known ? known.duration * 1000 : piece.length * msPerChar);
    }, 0);
    const done = (async () => {
      for (let i = 1; i < pieces.length && !take.cancelled; i++) {
        const buffer = await get(pieces[i]);
        if (take.cancelled) return;
        if (buffer) schedule(buffer);
        else {
          // This line only: the rest of it in the browser's voice.
          await Promise.race([wait(Math.max(0, endsAt - ctx.currentTime) * 1000), take.stopped]);
          if (!take.cancelled) await this.builtIn(pieces.slice(i).join(" "), take).done;
          return;
        }
      }
      // A timer, not `onended`: that never fires if the browser suspends the audio.
      await Promise.race([wait(Math.max(0, endsAt - ctx.currentTime) * 1000), take.stopped]);
    })();
    return this.track({ duration, done }, take);
  }

  private builtIn(text: string, take: Take): Spoken {
    const s = this.muted ? { duration: speechMs(text), done: wait(speechMs(text)) } : browserSay(text);
    return { duration: s.duration, done: Promise.race([s.done, take.stopped]).then(() => undefined) };
  }

  private timed(text: string, take: Take): Spoken {
    const duration = speechMs(text);
    const done = Promise.race([wait(duration), take.stopped]).then(() => void this.takes.delete(take));
    return { duration, done };
  }

  private track(s: Spoken, take: Take): Spoken {
    if (this.talking++ === 0) this.onTalking(this.audible);
    void s.done
      .catch(() => {})
      .then(() => {
        this.takes.delete(take);
        if (--this.talking === 0) this.onTalking(false);
      });
    return s;
  }
}

/** The browser's built-in voice (or just the time it would take, if there's none). */
export function browserSay(text: string): Spoken {
  const duration = speechMs(text);
  const synth = typeof speechSynthesis !== "undefined" ? speechSynthesis : null;
  // Only voices made on this computer: some built-in ones send the words to the browser's vendor.
  const local = synth?.getVoices().filter((v) => v.localService && v.lang.startsWith("en")) ?? [];
  if (!synth || !local.length) return { duration, done: wait(duration) };
  return {
    duration,
    done: new Promise<void>((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      u.voice = local.find((v) => v.default) ?? local[0];
      const fallback = setTimeout(resolve, duration * 1.8 + 2000); // some engines never fire onend
      u.onend = u.onerror = () => (clearTimeout(fallback), resolve());
      synth.speak(u);
    }),
  };
}
