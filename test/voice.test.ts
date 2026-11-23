import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCues } from "../board/tutor/rails.ts";
import { spokenText, toWav } from "../server/voice.ts";

process.env.DUDELING_STATE_DIR = mkdtempSync(join(tmpdir(), "dudeling-test-voice-")); // never the real boards

test("the server cleans a line exactly like the board (so audio made ahead is found)", () => {
  for (const s of [
    "[1] A fridge is really a heat mover: it pushes heat from [2] inside the box to [3] the room outside.",
    "So remember: [1] a fridge doesn't make cold, [2] it removes heat.",
    "On the left, [1] the client sends [2] a request [3].",
    "No markers here.",
  ])
    assert.equal(spokenText(s), parseCues(s).text);
});

test("WAV encoding: 16-bit mono with the right header", () => {
  const wav = toWav(new Float32Array([0, 0.5, -1, 1]), 24000);
  assert.equal(wav.subarray(0, 4).toString(), "RIFF");
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(wav.length, 44 + 8);
  assert.equal(wav.readInt16LE(44 + 4), -32767);
});

test("hearing: Dudeling's voice says a question, Whisper hears it back", { timeout: 180_000 }, async (t) => {
  const { voiceInstalled, speak } = await import("../server/voice.ts");
  const { existsSync } = await import("node:fs");
  const { MODELS_DIR } = await import("../server/voice.ts");
  if (!voiceInstalled() || !existsSync(`${MODELS_DIR}/onnx-community/whisper-base.en/onnx/encoder_model_quantized.onnx`)) return t.skip("models not installed (npm run voice)");
  const { transcribe, fromWav } = await import("../server/hearing.ts");
  const said = await speak("What is a refrigerant, and why does it get cold?");
  // 24 kHz → 16 kHz WAV, as the board sends it.
  const { samples } = fromWav(Buffer.from(said.wav, "base64"));
  const n = Math.floor((samples.length * 16000) / 24000);
  const pcm = Buffer.alloc(44 + n * 2);
  pcm.write("RIFF", 0); pcm.writeUInt32LE(36 + n * 2, 4); pcm.write("WAVEfmt ", 8); pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22);
  pcm.writeUInt32LE(16000, 24); pcm.writeUInt32LE(32000, 28); pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34); pcm.write("data", 36); pcm.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[Math.floor((i * 24000) / 16000)])) * 32767), 44 + i * 2);
  const text = await transcribe(pcm.toString("base64"));
  assert.match(text.toLowerCase(), /refrigerant/);
  assert.match(text.toLowerCase(), /cold/);
});

test("one failed line doesn't stop the voice (the queue carries on)", { timeout: 120_000 }, async (t) => {
  const { voiceInstalled, speak, testing } = await import("../server/voice.ts");
  if (!voiceInstalled()) return t.skip("voice model not installed");
  testing.failNext = true;
  await assert.rejects(speak("This line fails."));
  const ok = await speak("Still talking.");
  assert.ok(ok.durationMs > 300);
});
