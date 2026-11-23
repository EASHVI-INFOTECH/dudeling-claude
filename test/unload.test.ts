import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

process.env.DUDELING_STATE_DIR = mkdtempSync(join(tmpdir(), "dudeling-test-unload-"));
process.env.DUDELING_VOICE_DOWNLOAD = "off";
process.env.DUDELING_UNLOAD_MS = "1500";
const voice = await import("../server/voice.ts");
after(() => void voice.stopVoice());

test("the models load when needed, leave when idle, and come back", { skip: voice.voiceInstalled() ? false : "voice model not installed", timeout: 60_000 }, async () => {
  assert.equal(voice.testing.engineLoaded(), false, "nothing is loaded up front");
  for (let i = 0; i < 3; i++) {
    assert.ok((await voice.speak(`Round number ${i} of the unload check.`)).durationMs > 300);
    assert.equal(voice.testing.engineLoaded(), true);
    await sleep(2500);
    assert.equal(voice.testing.engineLoaded(), false, "gone once idle");
  }
});
