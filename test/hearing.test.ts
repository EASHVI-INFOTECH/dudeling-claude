import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fromWav, soundsSpoken, transcribe } from "../server/hearing.ts";
import { hearingInstalled, voiceInstalled } from "../server/models.ts";
import { toWav } from "../server/wav.ts";

process.env.DUDELING_STATE_DIR = mkdtempSync(join(tmpdir(), "dudeling-test-hearing-"));

test("a knock, steady noise and silence don't sound spoken", () => {
  const knock = new Float32Array(32_000).map((_, i) => (i > 8000 && i < 9500 ? 0.4 * Math.sin(i / 3) : 0));
  const fan = new Float32Array(32_000).map((_, i) => 0.05 * Math.sin(i / 5));
  for (const clip of [knock, fan, new Float32Array(32_000)]) assert.equal(soundsSpoken(clip), false);
});

test("a real thank you is heard", { skip: voiceInstalled() && hearingInstalled() ? false : "models not installed", timeout: 120_000 }, async () => {
  const { speak } = await import("../server/voice.ts");
  const { samples, rate } = fromWav(Buffer.from((await speak("Thank you.")).wav, "base64"));
  // As the board sends it: 16 kHz, with quiet before and after.
  const clip = new Float32Array(16_000 + Math.floor((samples.length * 16_000) / rate) + 14_000);
  for (let i = 0; i < Math.floor((samples.length * 16_000) / rate); i++) clip[16_000 + i] = samples[Math.floor((i * rate) / 16_000)];
  assert.match(await transcribe(toWav(clip, 16_000).toString("base64")), /thank you/i);
  assert.equal(await transcribe(toWav(new Float32Array(32_000), 16_000).toString("base64")), "", "silence says nothing");
});
