import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fromWav } from "../server/hearing.ts";
import { toWav } from "../server/voice.ts";

// The packed extension, as it is installed. Runs from `npm run pack`, or:
//   DUDELING_PACKED=dudeling-darwin-arm64.mcpb node --test test/packed.test.ts
const FILE = process.env.DUDELING_PACKED;
const skip = FILE ? false : "set DUDELING_PACKED to a .mcpb";

/** The server over stdio, speaking raw JSON-RPC: anything else on stdout is a failure. */
class Packed {
  noise: string[] = [];
  stderr = "";
  exited: Promise<number | null>;
  private proc: ChildProcessWithoutNullStreams;
  private buf = "";
  private id = 0;
  private waiting = new Map<number, (m: any) => void>();

  constructor(dir: string, state: string) {
    this.proc = spawn(process.execPath, [join(dir, "server/stdio.js")], {
      cwd: state,
      env: { ...process.env, DUDELING_STATE_DIR: state, DUDELING_MODELS_DIR: join(dir, "models"), DUDELING_VOICE_DOWNLOAD: "off", NODE_TEST_CONTEXT: undefined },
    });
    this.exited = new Promise((done) => this.proc.on("close", done));
    this.proc.stderr.on("data", (d) => (this.stderr += d));
    this.proc.stdin.on("error", () => {});
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (d) => {
      this.buf += d;
      for (let i; (i = this.buf.indexOf("\n")) >= 0; ) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        try {
          const msg = JSON.parse(line);
          this.waiting.get(msg.id)?.(msg);
        } catch {
          this.noise.push(line);
        }
      }
    });
  }

  async call(method: string, params: object, timeoutMs = 60_000): Promise<any> {
    const id = ++this.id;
    let timer: NodeJS.Timeout;
    const reply = new Promise<any>((done, fail) => {
      this.waiting.set(id, done);
      timer = setTimeout(() => fail(new Error(`${method}: no answer. stderr: ${this.stderr.slice(-800)}`)), timeoutMs);
      void this.exited.then((code) => fail(new Error(`${method}: server exited (${code}). stderr: ${this.stderr.slice(-800)}`)));
    });
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    const msg = await reply.finally(() => (clearTimeout(timer), this.waiting.delete(id)));
    if (msg.error) throw new Error(`${method}: ${JSON.stringify(msg.error)}`);
    return msg.result;
  }
  async init() {
    const r = await this.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "packed-test", version: "0" } }, 10_000);
    this.proc.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    return r;
  }
  tool(name: string, args: object = {}) {
    return this.call("tools/call", { name, arguments: args });
  }
  close() {
    this.proc.stdin.end();
  }
  kill() {
    this.proc.kill("SIGKILL");
  }
}

let dir = "";
let state = "";
before(() => {
  if (!FILE) return;
  // realpath matters: through a symlink (macOS /var → /private/var) argv and import.meta.url differ,
  // which hid the "bundled self-test runs as the main program" start-up failure.
  dir = realpathSync(mkdtempSync(join(tmpdir(), "dudeling-packed-")));
  state = realpathSync(mkdtempSync(join(tmpdir(), "dudeling-packed-state-")));
  execFileSync("unzip", ["-q", resolve(FILE), "-d", dir]);
});
after(() => {
  for (const d of [dir, state]) if (d) rmSync(d, { recursive: true, force: true });
});

test("packed: starts, lists its tools, speaks, hears, keeps stdout clean, and exits", { skip, timeout: 180_000 }, async (t) => {
  const p = new Packed(dir, state);
  t.after(() => p.kill());
  assert.equal((await p.init()).serverInfo.name, "dudeling");
  const names = (await p.call("tools/list", {})).tools.map((x: { name: string }) => x.name);
  for (const name of ["open_board", "teach_part", "speak", "transcribe", "board_updates"]) assert.ok(names.includes(name), name);
  const boardUri = (await p.call("tools/list", {})).tools.find((x: { name: string }) => x.name === "open_board")._meta.ui.resourceUri;
  assert.match(boardUri, /^ui:\/\/dudeling\/board-.+\.html$/, "a new version is a new address");
  const { contents } = await p.call("resources/read", { uri: boardUri });
  assert.ok(contents[0].text.length > 100_000, "built board");

  const said = await p.tool("speak", { text: "What is a refrigerant, and why does it get cold?" });
  assert.ok(!said.isError, JSON.stringify(said).slice(0, 300));
  const { samples, rate } = fromWav(Buffer.from(said.structuredContent.wav, "base64"));
  const at16k = new Float32Array(Math.floor((samples.length * 16000) / rate)).map((_, i) => samples[Math.floor((i * rate) / 16000)]);
  const heard = await p.tool("transcribe", { wav: toWav(at16k, 16000).toString("base64") });
  assert.match(heard.structuredContent.text.toLowerCase(), /refrigerant/);

  // Calls are answered at once while a part's audio is being made.
  const board = (await p.tool("open_board", { title: "Packed" })).structuredContent.board_id;
  const steps = Array.from({ length: 8 }, (_, i) => ({ say: `Packed line ${i}, made ${Date.now() % 89}: a coolant carries heat out into the room.`, actions: [] }));
  await p.tool("teach_part", { board_id: board, steps });
  let slowest = 0;
  for (let i = 0; i < 80; i++) {
    const t0 = performance.now();
    await p.tool("board_updates", { board_id: board, since: 0 });
    slowest = Math.max(slowest, performance.now() - t0);
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(slowest < 100, `a call took ${Math.round(slowest)} ms while speaking`);

  assert.deepEqual(p.noise, [], "stdout carries only the protocol");
  p.close();
  let timer: NodeJS.Timeout;
  const code = await Promise.race([p.exited, new Promise((r) => (timer = setTimeout(r, 5000, "still running")))]);
  clearTimeout(timer!);
  assert.equal(code, 0);
});

test("timing: packed, 20 of 20 starts answer initialize in under 3 s", { skip, timeout: 180_000 }, async () => {
  const slow: string[] = [];
  for (let i = 0; i < 20; i++) {
    const p = new Packed(dir, state);
    const t0 = performance.now();
    try {
      await p.init();
      const ms = performance.now() - t0;
      if (ms >= 3000) slow.push(`start ${i + 1}: ${Math.round(ms)} ms`);
    } finally {
      p.kill();
      await p.exited;
    }
  }
  assert.deepEqual(slow, []);
});
