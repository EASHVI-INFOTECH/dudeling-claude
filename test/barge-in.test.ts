import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Listener } from "../view/listen.ts";
import { speak, stopVoice, voiceInstalled } from "../server/voice.ts";
import { fromWav } from "../server/wav.ts";

process.env.DUDELING_STATE_DIR = mkdtempSync(join(tmpdir(), "dudeling-barge-"));
after(stopVoice);

test("short questions interrupt ongoing narration with the five original audit clips", { skip: !voiceInstalled() }, async t => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  for (const line of ["Wait.", "Stop.", "Why?", "Wait, why is that?", "Can you explain that again?"]) {
    const { samples, rate } = fromWav(Buffer.from((await speak(line)).wav, "base64"));
    let detected = 0;
    const listener = new Listener({ speechStart() { detected++; }, utterance() {} });
    const detector = listener as unknown as { ctx: { sampleRate: number }; feed(frame: Float32Array): void };
    listener.dudelingTalking = true;
    detector.ctx = { sampleRate: 48000 };
    for (let start = 0; start < samples.length * 48000 / rate; start += 2048) {
      const frame = Float32Array.from({ length: 2048 }, (_, i) => samples[Math.floor((start+i)*rate/48000)] ?? 0);
      now += frame.length * 1000 / 48000;
      detector.feed(frame);
    }
    assert.equal(detected, 1, line);
  }
});

test("an audio graph failure closes the context and releases every acquired microphone track", async t => {
  for (const failure of ["source", "processor", "connect"]) {
    let stopped = 0, closed = 0;
    const track = { stop() { stopped++; }, addEventListener() {} };
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
    const ctx = class {
      async resume() {} async close() { closed++; }
      createMediaStreamSource() { if (failure === "source") throw Error(failure); return { connect() { throw Error(failure); } }; }
      createScriptProcessor() { if (failure === "processor") throw Error(failure); return { disconnect() {} }; }
    };
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: async () => stream }, configurable: true });
    Object.defineProperty(globalThis, "AudioContext", { value: ctx, configurable: true });
    const listener = new Listener({ speechStart() {}, utterance() {} });
    await assert.rejects(listener.start(), new RegExp(failure));
    assert.deepEqual([stopped, closed, listener.on], [1, 1, false]);
  }
  t.after(() => { Reflect.deleteProperty(globalThis, "AudioContext"); Reflect.deleteProperty(navigator, "mediaDevices"); });
});

test("steady background sound and isolated clicks do not pause narration", t => {
  let now = 0, detected = 0;
  t.mock.method(performance, "now", () => now);
  const listener = new Listener({ speechStart() { detected++; }, utterance() {} });
  listener.dudelingTalking = true;
  const detector = listener as unknown as { ctx: { sampleRate: number }; feed(frame: Float32Array): void };
  detector.ctx = { sampleRate: 48000 };
  for (let n=0; n<100; n++) {
    now += 2048 * 1000 / 48000;
    const level = n === 15 ? 0.12 : n < 50 ? 0.007 : 0.031;
    detector.feed(new Float32Array(2048).fill(level));
  }
  assert.equal(detected, 0);
});
