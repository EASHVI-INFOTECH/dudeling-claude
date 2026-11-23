import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { build } from "esbuild";

// The board's player, bundled as the board bundles it (with the shared board engine's rails).
let Player: any;
before(async () => {
  const outfile = join(mkdtempSync(join(tmpdir(), "dudeling-test-player-")), "player.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("../view/player.ts", import.meta.url))],
    bundle: true,
    format: "esm",
    platform: "node",
    alias: { "@board": fileURLToPath(new URL("../board", import.meta.url)) },
    outfile,
    logLevel: "error",
  });
  ({ Player } = await import(outfile));
});

function rig(lineMs = 5) {
  const spoken: string[] = [];
  const drawn: { id?: string; at: number }[] = [];
  const agent = {
    estimate: () => 10,
    leadTime: () => 0,
    isFollowing: false,
    interrupt() {},
    run: async (actions: any[]) => void drawn.push(...actions.filter((a) => a.type !== "focus").map((a) => ({ id: a.id, at: performance.now() }))),
  };
  const starts: number[] = [];
  const voice = {
    prepare() {},
    stop() {},
    say: async (text: string) => (spoken.push(text), starts.push(performance.now()), { duration: lineMs, done: sleep(lineMs) }),
  };
  const p = new Player(agent, { caption() {}, done() {} });
  p.live = true;
  p.voice = voice;
  return { p, spoken, drawn, starts };
}
const draw = (id: string, n = 0) => ({ type: "write_text", id, x: 40 + (n % 5) * 220, y: 40 + (Math.floor(n / 5) % 9) * 70, text: id });

test("player: a long lesson keeps every line and drawing", { timeout: 30_000 }, async () => {
  const { p, spoken, drawn } = rig();
  const steps: unknown[] = [];
  let n = 0;
  for (let part = 0; part < 12; part++) {
    for (let i = 0; i < 4; i++) steps.push({ say: `Part ${part} line ${i} [1] here.`, actions: [draw(`d${n}`, n++)] });
    steps.push({ say: `Quick check: question ${part}?`, actions: [] });
    p.update("Long", [...steps], false);
  }
  for (let i = 0; i < 400 && spoken.length < 60; i++) await sleep(50);
  assert.equal(spoken.length, 60, "lines");
  assert.equal(drawn.length, 48, "drawings");
});

test("player: a drawing lands when the voice reaches its [n]", { timeout: 10_000 }, async () => {
  const { p, drawn, starts } = rig(1000);
  p.update("Sync", [{ say: "On the far left is a computer, and over on the far right [1] a server.", actions: [draw("server")] }], false);
  await sleep(1400);
  const into = drawn[0].at - starts[0];
  assert.ok(into > 700, `drawn ${Math.round(into)} ms into a 1000 ms line whose marker is at 85%`);
});
