import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

process.env.DUDELING_STATE_DIR = mkdtempSync(join(tmpdir(), "dudeling-test-engine-"));
process.env.DUDELING_VOICE_DOWNLOAD = "off";
const voice = await import("../server/voice.ts");
const skip = voice.voiceInstalled() ? false : "voice model not installed (npm run voice)";
after(() => void voice.stopVoice());

// Real words (so each run misses the audio cache): the voice spells out random letters, which takes seconds.
const pick = () => ["amber", "maple", "river", "cedar", "olive", "coral", "linen", "pebble", "walnut", "meadow", "copper", "harbor"][Math.floor(Math.random() * 12)];
const run = `${pick()} ${pick()}`;
const line = (i: number) => `Line ${i} of ${run}: a coolant soaks up heat inside the fridge and carries it out into the room.`;

test("voice: ready once loaded, so teach_part makes audio ahead", { skip, timeout: 60_000 }, async () => {
  await voice.speak("Okay then.");
  assert.equal(voice.voiceStatus(), "ready");
});

test("timing: voice, the process stays responsive (under 100 ms lag) while 8 lines are made", { skip, timeout: 180_000 }, async () => {
  let worst = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last - 10);
    last = now;
  }, 10);
  await Promise.all(Array.from({ length: 8 }, (_, i) => voice.speak(line(i))));
  clearInterval(timer);
  assert.ok(worst < 100, `worst lag ${Math.round(worst)} ms`);
});

test("timing: voice, a reply jumps an 8-line queue and speaks within 3 s", { skip, timeout: 180_000 }, async () => {
  const { speechPieces } = await import("../server/speech-text.ts");
  const queued = Array.from({ length: 8 }, (_, i) => speechPieces(line(i + 20)))
    .flat()
    .map((text) => voice.speak(text, { group: "lesson", priority: "ahead" }).catch(() => null));
  await sleep(300);
  const t0 = performance.now();
  await voice.speak(`Good question, ${run}.`, { priority: "reply" });
  const ms = performance.now() - t0;
  voice.cancel("lesson");
  await Promise.all(queued);
  assert.ok(ms < 3000, `${Math.round(ms)} ms`);
});

test("timing: voice, once the learner has spoken, later lines wait so the reply starts at once", { skip, timeout: 120_000 }, async () => {
  voice.holdAhead();
  let aheadDone = false;
  const ahead = voice.speak(`Later on we will look at the ${run} example in more detail.`, { priority: "ahead" }).then(() => (aheadDone = true));
  await sleep(1000);
  assert.equal(aheadDone, false);
  const t0 = performance.now();
  await voice.speak(`Yes, ${run}.`, { priority: "reply" });
  const ms = performance.now() - t0;
  assert.ok(!aheadDone && ms < 2000, `${Math.round(ms)} ms`);
  await ahead; // released by the reply
});

test("voice: cancelling a board drops its waiting lines, but not a line someone else wants", { skip, timeout: 120_000 }, async () => {
  const mine = [1, 2, 3].map((i) => voice.speak(`Cancel me ${i}, ${run}.`, { group: "cleared" }).then(() => "spoken", () => "cancelled"));
  const shared = voice.speak(`Cancel me 3, ${run}.`, { group: "other" });
  voice.cancel("cleared");
  assert.deepEqual((await Promise.all(mine)).slice(1), ["cancelled", "cancelled"]);
  assert.ok((await shared).durationMs > 300);
});

test("voice: a killed worker is replaced", { skip, timeout: 120_000 }, async () => {
  voice.testing.killWorker();
  const busy = voice.speak(`The worker dies during this line, ${run}.`);
  assert.ok((await busy).durationMs > 300, "the line it was on is retried");
  assert.ok((await voice.speak(`And it speaks again, ${run}.`)).durationMs > 300);
});

test("voice: hearing and voice take turns on the one engine thread", { skip, timeout: 120_000 }, async () => {
  const { fromWav, transcribe } = await import("../server/hearing.ts");
  const { toWav } = await import("../server/wav.ts");
  for (let i = 0; i < 4; i++) {
    const said = await voice.speak(`Round ${i}: the fridge is cold, ${run}.`);
    const { samples, rate } = fromWav(Buffer.from(said.wav, "base64"));
    const at16k = new Float32Array(Math.floor((samples.length * 16000) / rate)).map((_, j) => samples[Math.floor((j * rate) / 16000)]);
    assert.match((await transcribe(toWav(at16k, 16000).toString("base64"))).toLowerCase(), /fridge/);
  }
});

test("voice: shutting down mid-line waits for it (ending it would abort the process)", { skip, timeout: 60_000 }, async () => {
  const busy = voice.speak(`Shutting down during this line about fridges, ${run}.`);
  await sleep(250);
  assert.equal(await voice.stopVoice(), true);
  assert.ok((await busy).durationMs > 300);
});
