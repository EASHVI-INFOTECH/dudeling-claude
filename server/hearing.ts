/**
 * Dudeling's ears, inside the plugin: Whisper (base.en, q8, ~78 MB) turns what the learner says on the
 * board into text, on the CPU of the machine running this server (measured on an M-series Mac: 5 s of
 * speech in ~0.6 s). It shares the engine thread with the voice and runs right after the piece being made,
 * ahead of every piece still waiting.
 */
import { engineThread } from "./engine-thread.ts";
import { STT_MODEL, hearingInstalled } from "./models.ts";
import { fromWav } from "./wav.ts";

export { STT_MODEL, fromWav, hearingInstalled };

/** What was said in a WAV clip (empty for silence or noise). */
export async function transcribe(wavBase64: string): Promise<string> {
  const { samples, rate } = fromWav(Buffer.from(wavBase64, "base64"));
  if (rate !== 16000) throw new Error("expected 16 kHz audio");
  if (samples.length < 16000 * 0.3) return "";
  // Whisper costs the same for silence as for speech, so don't ask it.
  if (samples.every((v) => Math.abs(v) < 0.01)) return "";
  const text = await engineThread.run<string>({ kind: "hearing", samples });
  // Whisper's usual non-speech outputs.
  if (/^(\[.*\]|\(.*\)|you\.?|\.+)$/i.test(text)) return "";
  // "Thank you." is both a real answer and what it invents for noise: believe it only if it sounds like speech.
  if (/^thank you[.!]?$/i.test(text) && !soundsSpoken(samples)) return "";
  return text;
}

const FRAME = 480; // 30 ms at 16 kHz
/** Enough loud frames for two words, and quieter ones around them (steady noise has none; a knock is too short). */
export function soundsSpoken(samples: Float32Array): boolean {
  const levels: number[] = [];
  for (let i = 0; i + FRAME <= samples.length; i += FRAME) {
    let sum = 0;
    for (let j = i; j < i + FRAME; j++) sum += samples[j] * samples[j];
    levels.push(Math.sqrt(sum / FRAME));
  }
  if (!levels.length) return false;
  const loud = levels.filter((level) => level > 0.02).length;
  const sorted = [...levels].sort((a, b) => a - b);
  const quiet = sorted[Math.floor(sorted.length / 10)];
  const peak = sorted[Math.floor(sorted.length * 0.95)];
  return loud >= 8 && peak > quiet * 3;
}

/** Load the model ahead of the first question (background, at start-up). */
export const warmHearing = () => engineThread.run({ kind: "hearing" }).then(() => undefined);
