import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { chromium, type Browser, type Frame, type Page } from "playwright-core";
import { createServer, type ViteDevServer } from "vite";
import { voiceInstalled } from "../server/models.ts";

/**
 * The built board in real Chrome, inside a host that sandboxes it as chat apps do (strict CSP, 60 s
 * calls), against the real plugin with the real voice and ears, as Claude Desktop runs it: one copy over
 * stdio for Claude (the test), one for each board. The microphone is silent until the test speaks into it.
 * The shipped bytes instead of the source: DUDELING_PACKED=<file.mcpb>. Screenshots: DUDELING_SHOTS=<dir>.
 */
const CHROME = "/Applications/Google Chrome.app";
const skip = !existsSync(CHROME) ? "Google Chrome isn't installed" : !voiceInstalled() ? "voice model not installed (npm run voice)" : false;
const PORT = 18_900 + Math.floor(Math.random() * 400);
const root = fileURLToPath(new URL("..", import.meta.url));

let packed = "";
let slowFile = "";
let vite: ViteDevServer;
let browser: Browser;
let claude: Client;
let hostUrl = "";

before(async () => {
  if (skip) return;
  let entry = join(root, "server/stdio.ts");
  if (process.env.DUDELING_PACKED) {
    packed = realpathSync(mkdtempSync(join(tmpdir(), "dudeling-test-packed-board-")));
    execFileSync("unzip", ["-q", resolve(process.env.DUDELING_PACKED), "-d", packed]);
    entry = join(packed, "server/stdio.js");
    process.env.DUDELING_PLUGIN = entry;
  }
  // The test, Claude's copy and the boards' copies share one set of files.
  const state = mkdtempSync(join(tmpdir(), "dudeling-test-board-"));
  process.env.DUDELING_STATE_DIR = state;
  process.env.DUDELING_QUIET = "1";
  slowFile = join(state, "slow-ms");
  process.env.DUDELING_TEST_SLOW_FILE = slowFile;
  claude = new Client({ name: "test-claude", version: "0" });
  await claude.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      env: { ...(process.env as Record<string, string>), DUDELING_VOICE_DOWNLOAD: "off", NODE_TEST_CONTEXT: "" },
      stderr: "ignore",
    }),
  );
  vite = await createServer({ configFile: join(root, "vite.config.ts"), logLevel: "silent", server: { port: PORT, host: "127.0.0.1" } });
  await vite.listen();
  hostUrl = `${vite.resolvedUrls!.local[0]}host.html`;
  browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--autoplay-policy=document-user-activation-required", "--mute-audio"] });
});
after(async () => {
  await browser?.close();
  await vite?.close();
  await claude?.close().catch(() => {});
  if (packed) rmSync(packed, { recursive: true, force: true });
});

const call = async (name: string, args: object = {}) => (await claude.callTool({ name, arguments: args as Record<string, unknown> })) as any;
const textOf = (r: any): string => r.content[0].text;
const open = async () => (await call("open_board", { title: "How a fridge stays cold" })).structuredContent.board_id as string;
const tag = () => ["amber", "maple", "river", "cedar", "olive", "coral", "linen", "pebble", "walnut", "meadow"][Math.floor(Math.random() * 10)];

async function teach(board_id: string, { lines = 3, check = false } = {}) {
  const t = tag();
  const says = [`[1] The ${t} fridge moves heat away.`, `A coolant [1] carries the ${t} heat outside.`, `So [1] the ${t} box stays cold.`].slice(0, lines);
  const r = await call("teach_part", {
    board_id,
    steps: says.map((say, i) => ({ say, actions: [{ type: "write_text", id: `${t}${i}`, x: 60, y: 80 + i * 110, text: `${t} ${i}` }] })),
    ...(check ? { check: { question: `Where does the ${t} heat go?`, answer: "Outside." } } : {}),
  });
  assert.ok(!r.isError, textOf(r));
  return { t, spoken: says.map((s) => s.replace(/\[\d+\]\s*/g, "")) };
}

/** In every frame: a microphone the test speaks into, and a record of what the board plays. */
function instrument() {
  const w = window as any;
  w.__played = [];
  w.__errors = [];
  w.__streams = [];
  w.__violations = [];
  w.__basicVoice = 0;
  if (w.speechSynthesis) {
    const voices = speechSynthesis.getVoices.bind(speechSynthesis);
    // The board only asks for the system's voices when it gives up on Dudeling's.
    speechSynthesis.getVoices = () => (w.__basicVoice++, voices());
  }
  addEventListener("error", (e) => w.__errors.push(String(e.message)));
  addEventListener("unhandledrejection", (e) => w.__errors.push(String(e.reason)));
  addEventListener("securitypolicyviolation", (e) => w.__violations.push(`${e.violatedDirective} ${e.blockedURI}`));
  const start = AudioBufferSourceNode.prototype.start;
  const stop = AudioBufferSourceNode.prototype.stop;
  AudioBufferSourceNode.prototype.start = function (this: any, at = 0, ...rest: number[]) {
    if (!this.__mic && this.buffer) {
      this.__rec = { asked: performance.now(), from: performance.now() + Math.max(0, at - this.context.currentTime) * 1000, running: this.context.state === "running" };
      this.__rec.to = this.__rec.from + this.buffer.duration * 1000;
      w.__played.push(this.__rec);
    }
    return (start as any).call(this, at, ...rest);
  };
  AudioBufferSourceNode.prototype.stop = function (this: any, ...args: number[]) {
    if (this.__rec) this.__rec.to = Math.min(this.__rec.to, performance.now());
    return (stop as any).call(this, ...args);
  };
  if (!navigator.mediaDevices) return;
  let ctx: AudioContext;
  let mics: MediaStreamAudioDestinationNode[] = [];
  navigator.mediaDevices.getUserMedia = async () => {
    await new Promise((r) => setTimeout(r, w.__micDelay ?? 150)); // the permission prompt
    if (w.__micDenied) throw new DOMException("Permission denied", "NotAllowedError");
    ctx ??= new AudioContext();
    await ctx.resume();
    const mic = ctx.createMediaStreamDestination();
    const hum = ctx.createConstantSource();
    hum.offset.value = 0;
    hum.connect(mic);
    hum.start();
    mics = [mic];
    w.__streams.push(mic.stream);
    return mic.stream;
  };
  w.__speakIntoMic = async (wav: string) => {
    const src: any = ctx.createBufferSource();
    src.buffer = await ctx.decodeAudioData(Uint8Array.from(atob(wav), (c) => c.charCodeAt(0)).buffer);
    src.__mic = true;
    for (const mic of mics) src.connect(mic);
    src.start();
  };
}

interface View {
  page: Page;
  board: Frame;
  external: string[];
  messages(): Promise<string[]>;
}
async function show(board_id: string, { scheme = "light" as "light" | "dark", viewport = { width: 1180, height: 820 } } = {}): Promise<View & { close(): Promise<void> }> {
  const context = await browser.newContext({ viewport, colorScheme: scheme });
  await context.addInitScript(instrument);
  const page = await context.newPage();
  const external: string[] = [];
  page.on("request", (r) => {
    if (!/^(https?|wss?):\/\/(127\.0\.0\.1|localhost)[:/]|^(data|blob|about):/.test(r.url())) external.push(r.url());
  });
  await page.goto(`${hostUrl}?origin&board=${board_id}`, { timeout: 45_000 });
  await page.waitForFunction(() => document.querySelector("#log")?.textContent?.includes("replaying board"), null, { timeout: 45_000 });
  const board = (await (await page.locator("iframe").elementHandle())!.contentFrame())!;
  await board.locator(".dud__talk").waitFor({ timeout: 20_000 });
  return {
    page,
    board,
    external,
    messages: async () => (await page.locator("#log div").allTextContents()).filter((l) => l.includes("MESSAGE from the board")),
    close: () => context.close(),
  };
}

const caption = (v: View) => v.board.locator(".dud__caption > span").innerText();
const played = (v: View) => v.board.evaluate(() => (window as any).__played as { asked: number; from: number; to: number; running: boolean }[]);
const liveMics = (v: View) => v.board.evaluate(() => (window as any).__streams.flatMap((s: MediaStream) => s.getTracks()).filter((t: MediaStreamTrack) => t.readyState === "live").length as number);
async function until(what: string, ok: () => Promise<boolean>, ms = 20_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await ok()) return;
  assert.fail(`never happened: ${what}`);
}
const says = (v: View, words: string, ms?: number) => until(`caption "${words}"`, async () => (await caption(v)).includes(words), ms);
const pressPlay = (v: View) => v.board.locator(".dud__play").click();
async function type(v: View, text: string) {
  await v.board.locator(".dud__text").fill(text);
  await v.board.locator(".dud__text").press("Enter");
}
async function shot(v: View, name: string) {
  if (process.env.DUDELING_SHOTS) await v.page.screenshot({ path: join(process.env.DUDELING_SHOTS, `${name}.png`) });
}

for (const order of [["Play"], ["Talk", "Play"], ["Voice", "Play"], ["Talk", "Voice"], ["Voice", "Talk"], ["Play", "Talk", "Voice"]])
  test(`B1: ${order.join(" → ")} starts the lesson`, { skip, timeout: 90_000 }, async () => {
    const id = await open();
    const { spoken } = await teach(id, { lines: 2 });
    const v = await show(id);
    try {
      await v.board.locator(".dud__play").waitFor();
      for (const b of order) {
        const button = b === "Play" ? v.board.locator(".dud__play") : b === "Talk" ? v.board.locator(".dud__talk") : v.board.getByRole("button", { name: /^(Voice|Muted)/ });
        // Play is gone once another click has released the lesson.
        if (b !== "Play" || (await button.count())) await button.click({ timeout: 5000 });
        await sleep(300);
      }
      await says(v, spoken[0]);
      await until("sound", async () => (await played(v)).some((p) => p.running));
    } finally {
      await v.close();
    }
  });

test("B1: the click that turns sound on doesn't mute it", { skip, timeout: 60_000 }, async () => {
  const id = await open();
  await teach(id, { lines: 1 });
  const v = await show(id);
  try {
    await v.board.getByRole("button", { name: "Voice" }).click();
    await until("Voice on", async () => (await v.board.getByRole("button", { name: /^Voice on/ }).count()) === 1);
  } finally {
    await v.close();
  }
});

test("B2: 20 rapid toggles leave no live microphone and no errors", { skip, timeout: 90_000 }, async () => {
  const v = await show(await open());
  try {
    const talk = v.board.locator(".dud__talk");
    for (let i = 0; i < 20; i++) {
      await talk.click({ force: true });
      await sleep([20, 80, 200, 350][i % 4]);
    }
    await sleep(1200);
    assert.equal((await talk.innerText()).trim(), "Talk");
    assert.equal(await liveMics(v), 0);
    assert.deepEqual(await v.board.evaluate(() => (window as any).__errors), []);
  } finally {
    await v.close();
  }
});

test("C1+B3: a spoken interruption is heard, answered with no Enter, and the line resumes", { skip, timeout: 120_000 }, async () => {
  const question = await call("speak", { text: "Wait, what exactly is a refrigerant?" });
  const id = await open();
  const { spoken } = await teach(id);
  const v = await show(id);
  try {
    await pressPlay(v);
    await says(v, spoken[0]);
    await v.board.locator(".dud__talk").click();
    await until("listening", async () => (await v.board.locator(".dud__talk").innerText()).includes("Listening"));
    const waiting = call("reply_and_listen", { board_id: id });
    await v.board.evaluate((wav) => (window as any).__speakIntoMic(wav), question.structuredContent.wav);
    await until("hearing", async () => (await v.board.locator(".dud__talk").innerText()).includes("Hearing you"), 8000);
    const silent = await v.board.evaluate(() => {
      const now = performance.now();
      return (window as any).__played.every((p: any) => p.to <= now + 50);
    });
    assert.ok(silent, "quiet once interrupted");
    const heard = textOf(await waiting);
    assert.match(heard.toLowerCase(), /interrupting[\s\S]*refrigerant/);
    const t0 = Date.now();
    const next = call("reply_and_listen", { board_id: id, say: "It is a fluid that carries heat.", resume: true });
    await says(v, "carries heat.", 8000);
    await until("the reply is audible", async () => {
      const now = await v.board.evaluate(() => performance.now());
      return (await played(v)).some((p) => p.from <= now && p.to > now);
    });
    console.log(`reply audible after ${Date.now() - t0} ms`);
    assert.ok(Date.now() - t0 < 3000, `reply took ${Date.now() - t0} ms`);
    await says(v, spoken.at(-1)!, 30_000);
    assert.deepEqual(await v.messages(), [], "nothing went to the chat box");
    await type(v, "Thanks.");
    await next;
  } finally {
    await v.close();
  }
});

test("B3: no sound starts after an interruption, even for a line still being made", { skip, timeout: 90_000 }, async () => {
  const id = await open();
  const v = await show(id);
  try {
    await v.board.locator(".dud__caption").click(); // sound on
    await teach(id);
    await until("working on the first line", async () => /Getting the voice ready|Speaking/.test(await v.board.locator(".dud__status").innerText()), 8000);
    await type(v, "Hold on.");
    const at = await v.board.evaluate(() => performance.now());
    await sleep(6000);
    // The filler is the one thing it may say.
    const later = (await played(v)).filter((p) => p.asked > at && p.to - p.from > 2000);
    assert.deepEqual(later, []);
  } finally {
    await v.close();
  }
});

test("C2: a whole lesson works with the microphone denied", { skip, timeout: 150_000 }, async () => {
  const id = await open();
  const first = await teach(id, { lines: 2, check: true });
  const v = await show(id);
  try {
    await v.board.evaluate(() => ((window as any).__micDenied = true));
    await v.board.locator(".dud__talk").click();
    await until("mic blocked", async () => (await v.board.locator(".dud__talk").innerText()).includes("Mic blocked"));
    for (const t of [first.t, "second"]) {
      const part = t === first.t ? first : await teach(id, { lines: 2, check: true });
      await says(v, `Quick check: Where does the ${part.t} heat go?`, 40_000);
      await until("your answer", async () => (await v.board.locator(".dud__text").getAttribute("placeholder")) === "Type your answer");
      const waiting = call("reply_and_listen", { board_id: id });
      await sleep(400);
      await type(v, "Outside");
      assert.match(textOf(await waiting), /typed \(answering the check question/);
    }
    assert.deepEqual(await v.messages(), []);
    await shot(v, "check-light");
  } finally {
    await v.close();
  }
});

test("C3: when Claude isn't listening, the words go to the chat box once", { skip, timeout: 120_000 }, async () => {
  const id = await open();
  const v = await show(id);
  try {
    // Claude is stopped mid-wait, as with the chat's Stop button.
    const wait = new AbortController();
    const listening = claude.callTool({ name: "reply_and_listen", arguments: { board_id: id } }, { signal: wait.signal }).catch(() => null);
    await sleep(700);
    wait.abort();
    await listening;
    await until("Not listening", async () => (await v.board.locator(".dud__status").innerText()) === "Not listening", 10_000);
    await type(v, "Are you there?");
    await until("in the chat box", async () => (await v.messages()).length === 1);
    await sleep(2500);
    assert.equal((await v.messages()).length, 1, "no retries");
    assert.deepEqual((await import("../server/inbox.ts")).take(id), [], "not delivered twice");
  } finally {
    await v.close();
  }
});

test("B4: reloaded mid-part, it resumes the lines not heard yet; once finished, none", { skip, timeout: 120_000 }, async () => {
  const id = await open();
  const { spoken } = await teach(id);
  let v = await show(id);
  try {
    await pressPlay(v);
    await says(v, spoken[1]);
    await v.close();
    v = await show(id);
    await v.board.locator(".dud__play").waitFor();
    assert.notEqual(await caption(v), spoken[0]);
    await pressPlay(v);
    await says(v, spoken[1], 6000);
    await says(v, spoken[2]);
    await until("finished", async () => !/Speaking|Getting/.test(await v.board.locator(".dud__status").innerText()));
    await sleep(800);
    await v.close();
    v = await show(id);
    await sleep(2500);
    assert.equal(await v.board.locator(".dud__play").count(), 0, "nothing left to play");
    await v.board.locator(".dud__caption").click();
    await sleep(2500);
    assert.equal((await played(v)).length, 0, "no replayed audio");
  } finally {
    await v.close();
  }
});

test("B4: a check question is restored", { skip, timeout: 120_000 }, async () => {
  const id = await open();
  const { t } = await teach(id, { lines: 1, check: true });
  let v = await show(id);
  try {
    await pressPlay(v);
    await until("waiting", async () => (await v.board.locator(".dud__text").getAttribute("placeholder")) === "Type your answer", 30_000);
    await sleep(600);
    await v.close();
    v = await show(id);
    await until("waiting again", async () => (await v.board.locator(".dud__text").getAttribute("placeholder")) === "Type your answer");
    await says(v, `Where does the ${t} heat go?`);
  } finally {
    await v.close();
  }
});

test("B5: two views give one voice", { skip, timeout: 120_000 }, async () => {
  const id = await open();
  const a = await show(id);
  await a.board.locator(".dud__caption").click();
  const b = await show(id);
  try {
    await b.board.locator(".dud__caption").click();
    await a.board.getByText("Use this board here").waitFor({ timeout: 5000 });
    const { spoken } = await teach(id, { lines: 1 });
    await says(b, spoken[0]);
    assert.equal((await played(a)).length, 0);
  } finally {
    await a.close();
    await b.close();
  }
});

test("B6+D4: idle, at most 6 calls a minute; no network; the fonts load", { skip, timeout: 90_000 }, async () => {
  const id = await open();
  await call("draw", { board_id: id, actions: [{ type: "write_text", id: "font", x: 60, y: 80, text: "Handwriting" }] });
  const v = await show(id);
  try {
    await sleep(3000);
    const count = () => v.page.evaluate(() => (window as any).__toolCalls as number);
    const before = await count();
    await sleep(40_000);
    const calls = (await count()) - before;
    assert.ok(calls <= 4, `${calls} calls in 40 s`);
    assert.deepEqual(v.external, [], `external: ${v.external.slice(0, 5)}`);
    const fonts = await v.board.evaluate(() => [...document.fonts].filter((f) => f.family.includes("Excalifont")).map((f) => f.status));
    assert.ok(fonts.includes("loaded"), `fonts: ${fonts}`);
    // zod probes for eval once and does without it.
    const violations = ((await v.board.evaluate(() => (window as any).__violations)) as string[]).filter((x) => x !== "script-src eval");
    assert.deepEqual(violations, [], `CSP violations: ${violations.slice(0, 6)}`);
  } finally {
    await v.close();
  }
});

for (const scheme of ["light", "dark"] as const)
  test(`C6: keyboard only, ${scheme}`, { skip, timeout: 120_000 }, async () => {
    const id = await open();
    const { spoken } = await teach(id, { lines: 1 });
    const v = await show(id, { scheme, viewport: { width: 1100, height: 780 } });
    try {
      if (scheme === "dark") await v.page.locator("#dark").check(); // the host's theme wins over the system's
      await v.board.locator(`.dud--${scheme}`).waitFor();
      const play = v.board.locator(".dud__play");
      await play.waitFor();
      await play.focus();
      await v.page.keyboard.press("Enter");
      await says(v, spoken[0]);
      await shot(v, `lesson-${scheme}`);
      const waiting = call("reply_and_listen", { board_id: id });
      await v.board.locator(".dud__text").focus();
      await v.page.keyboard.type("What is heat?");
      await v.page.keyboard.press("Enter");
      assert.match(textOf(await waiting), /What is heat\?/);
    } finally {
      await v.close();
    }
  });

test("timing: player gates, quick to start, short gaps between lines, over a long lesson", { skip, timeout: 240_000 }, async () => {
  const id = await open();
  const parts = [await teach(id), await teach(id), await teach(id), await teach(id)];
  const v = await show(id);
  try {
    await sleep(9000); // warm: the first part's audio is made
    const t0 = await v.board.evaluate(() => performance.now());
    await pressPlay(v);
    await says(v, parts[3].spoken[2], 150_000); // the 12th line: past the old 8-step cap
    const p = await played(v);
    const first = p[0].from - t0;
    const gaps = p.slice(1).map((x, i) => x.from - p[i].to).sort((a, b) => a - b);
    const p95 = gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * 0.95))];
    console.log(`play to first sound ${Math.round(first)} ms; gaps p50 ${Math.round(gaps[gaps.length >> 1])} ms, p95 ${Math.round(p95)} ms, ${gaps.length} gaps`);
    assert.ok(first < 2000, `first sound ${first} ms`);
    assert.ok(p95 < 700, `gap p95 ${p95} ms`);
    await shot(v, "long-lesson");
  } finally {
    await v.close();
  }
});

test("soak: 25 exchanges, 2 minutes of silence, Talk off mid-wait", { skip: skip || (process.env.DUDELING_SOAK ? false : "set DUDELING_SOAK (5 minutes)"), timeout: 540_000 }, async () => {
  const id = await open();
  const v = await show(id);
  try {
    await v.board.locator(".dud__caption").click();
    await teach(id, { lines: 1 });
    const slow: number[] = [];
    let waiting = call("reply_and_listen", { board_id: id });
    for (let i = 0; i < 25; i++) {
      await type(v, `Doubt number ${i}`);
      assert.match(textOf(await waiting), new RegExp(`Doubt number ${i}"`));
      const answer = `Answer ${i}: it moves heat, ${tag()}.`;
      const t0 = Date.now();
      waiting = call("reply_and_listen", { board_id: id, say: answer });
      await says(v, answer, 10_000);
      slow.push(Date.now() - t0);
      await sleep(1500);
    }
    // Two minutes of silence: still listening, so no Enter afterwards.
    for (const end = Date.now() + 120_000; Date.now() < end; ) {
      const r = await Promise.race([waiting.then(textOf), sleep(Math.max(0, end - Date.now())).then(() => null)]);
      if (r === null) break;
      assert.match(r, /Call reply_and_listen again/);
      waiting = call("reply_and_listen", { board_id: id });
    }
    await v.board.locator(".dud__talk").click();
    await sleep(800);
    await v.board.locator(".dud__talk").click();
    await until("mic released", async () => (await liveMics(v)) === 0, 5000);
    await type(v, "Back again");
    assert.match(textOf(await waiting), /Back again/);
    assert.deepEqual(await v.messages(), []);
    assert.deepEqual(await v.board.evaluate(() => (window as any).__errors), []);
    console.log(`soak: caption after each reply (ms) ${slow.join(" ")}`);
    const sorted = [...slow].sort((a, b) => a - b);
    console.log(`soak: p50 ${sorted[12]} ms, p95 ${sorted[23]} ms, worst ${sorted[24]} ms`);
  } finally {
    await v.close();
  }
});

test("replies keep their place: before a part sent after them, and at the next line of one playing", { skip, timeout: 120_000 }, async () => {
  const id = await open();
  const v = await show(id);
  try {
    await v.board.locator(".dud__caption").click();
    await v.board.evaluate(() => {
      const el = document.querySelector(".dud__caption > span")!;
      (window as any).__seen = [];
      new MutationObserver(() => (window as any).__seen.push(el.textContent)).observe(el, { subtree: true, childList: true, characterData: true });
    });
    await call("say", { board_id: id, text: "Good, let's begin." });
    const { spoken } = await teach(id);
    await says(v, spoken[0], 15_000);
    await call("say", { board_id: id, text: "A quick aside." });
    await says(v, spoken[2], 30_000);
    const seen: string[] = await v.board.evaluate(() => (window as any).__seen);
    const at = (text: string) => seen.indexOf(text);
    assert.ok(at("Good, let's begin.") >= 0 && at("Good, let's begin.") < at(spoken[0]), `order: ${seen.join(" | ")}`);
    assert.ok(at("A quick aside.") > at(spoken[0]) && at("A quick aside.") < at(spoken[2]), `order: ${seen.join(" | ")}`);
  } finally {
    await v.close();
  }
});

test("K1: the test bridge refuses other websites", { skip, timeout: 20_000 }, async () => {
  const url = vite.resolvedUrls!.local[0].replace(/^http/, "ws");
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    // A page on another origin, with no token, as a website the developer visits would be.
    await page.goto("about:blank");
    const opened = await page.evaluate(
      (to) =>
        new Promise<boolean>((done) => {
          const socket = new WebSocket(to, "vite-hmr");
          socket.onopen = () => done(true);
          socket.onerror = () => done(false);
          setTimeout(() => done(false), 5000);
        }),
      url,
    );
    assert.equal(opened, false);
  } finally {
    await context.close();
  }
});

// The overloaded-Mac run of 22 Nov, replayed: every piece of speech takes 12 s (Claude gives up on a call at 60 s).
test("slow Mac: a long reply still plays in Dudeling's voice, however long it waits", { skip, timeout: 280_000 }, async () => {
  const id = await open();
  const v = await show(id);
  try {
    await v.board.locator(".dud__caption").click();
    await sleep(2500);
    writeFileSync(slowFile, "15000");
    const sentences = ["First", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh", "Eighth", "Ninth"].map((n) => `${n}, the ${tag()} coolant carries some heat away.`);
    await call("say", { board_id: id, text: sentences.join(" ") });
    await until("all nine pieces played", async () => (await played(v)).filter((p) => p.to - p.from > 1000).length >= 9, 200_000);
    assert.equal(await v.board.evaluate(() => (window as any).__basicVoice), 0, "never fell back to the basic voice");
    const longest: number = await v.page.evaluate(() => (window as any).__longestCall());
    assert.ok(longest < 30_000, `a board request waited ${Math.round(longest / 1000)} s (Claude gives up at 60)`);
  } finally {
    writeFileSync(slowFile, "0");
    await v.close();
  }
});

test("slow Mac: a new reply doesn't wait for the one that was interrupted", { skip, timeout: 180_000 }, async () => {
  const id = await open();
  const v = await show(id);
  try {
    await v.board.locator(".dud__caption").click();
    await sleep(2500);
    writeFileSync(slowFile, "6000");
    const old = ["First", "Second", "Third", "Fourth", "Fifth", "Sixth"].map((n) => `${n}, the old ${tag()} answer keeps going on.`);
    await call("say", { board_id: id, text: old.join(" ") });
    await sleep(3000);
    await type(v, "Wait, something else.");
    const at = await v.board.evaluate(() => performance.now());
    await call("say", { board_id: id, text: `The new ${tag()} answer is this.` });
    // One piece may be being made when it's asked, then its own.
    await until("the new reply plays", async () => (await played(v)).some((p) => p.asked > at && p.to - p.from > 1400), 20_000);
  } finally {
    writeFileSync(slowFile, "0");
    await v.close();
  }
});

test("a second question while the lesson is paused still says the lesson needs resuming", { skip, timeout: 90_000 }, async () => {
  const id = await open();
  const { spoken } = await teach(id);
  const v = await show(id);
  try {
    await pressPlay(v);
    await says(v, spoken[0]);
    let waiting = call("reply_and_listen", { board_id: id });
    await type(v, "Why?");
    assert.match(textOf(await waiting), /interrupting/);
    waiting = call("reply_and_listen", { board_id: id, say: "Because heat moves." });
    await says(v, "Because heat moves.", 10_000);
    await type(v, "But why that way?");
    const heard = textOf(await waiting);
    assert.match(heard, /But why that way/);
    assert.match(heard, /resume:true/);
  } finally {
    await v.close();
  }
});

test("Dudeling's own replies don't count as the learner's silence", { skip, timeout: 60_000 }, async () => {
  const id = await open();
  const v = await show(id);
  try {
    await v.board.locator(".dud__caption").click();
    await sleep(1500);
    await call("say", { board_id: id, text: "Here is a reply that takes a few seconds to say out loud, all the way to the end." });
    const boards = await import("../server/boards.ts");
    await until("the plugin knows it's talking", async () => boards.progress(id).narrating, 8000);
  } finally {
    await v.close();
  }
});

test("cutting off a reply doesn't start the lesson talking over the learner", { skip, timeout: 90_000 }, async () => {
  const id = await open();
  const { spoken } = await teach(id);
  const v = await show(id);
  try {
    await pressPlay(v);
    await says(v, spoken[0]);
    let waiting = call("reply_and_listen", { board_id: id });
    await type(v, "Why is that?");
    await waiting;
    waiting = call("reply_and_listen", { board_id: id, say: "Because the coolant takes the heat with it when it leaves.", resume: true });
    await says(v, "Because the coolant", 10_000);
    await sleep(600);
    await type(v, "Hang on, one more thing.");
    assert.match(textOf(await waiting), /resume:true/, "still paused");
    await sleep(3000);
    const now = await caption(v);
    assert.ok(!spoken.some((line) => now.includes(line)), `the lesson carried on: ${now}`);
  } finally {
    await v.close();
  }
});

test("boxes and camera: a subtopic opens a new linked box, and the view keeps up with the pen in a small frame", { skip, timeout: 150_000 }, async () => {
  const board_id = (await call("open_board", { title: "Active Directory" })).structuredContent.board_id as string;
  // Spread across the whole safe area: in a chat-sized frame most of it starts off screen.
  const r1 = await call("teach_part", {
    board_id,
    steps: [
      { say: "[1] Here is who you are.", actions: [{ type: "draw_shape", id: "users", shape: "rectangle", x: 60, y: 60, width: 200, height: 80, label: "Users" }] },
      { say: "[1] And far over here is what you may do.", actions: [{ type: "draw_shape", id: "rights", shape: "rectangle", x: 940, y: 520, width: 200, height: 80, label: "Rights" }] },
      { say: "[1] One links to the other.", actions: [{ type: "draw_arrow", id: "link", from: "users", to: "rights", label: "decides" }] },
    ],
  });
  assert.ok(!r1.isError, textOf(r1));
  const v = await show(board_id, { viewport: { width: 760, height: 560 } });
  try {
    await v.board.locator(".dud__caption").click(); // sound on
    await says(v, "Here is who you are");
    await shot(v, "camera-1-first");
    await says(v, "far over here");
    await sleep(900);
    await shot(v, "camera-2-pen-far-away");
    await says(v, "One links");
    await sleep(2500);
    await shot(v, "camera-3-part-done");
    const r2 = await call("teach_part", {
      board_id,
      section: { title: "Domain controllers", about: "users" },
      steps: [{ say: "[1] A domain controller keeps the book.", actions: [{ type: "draw_shape", id: "dc", shape: "rectangle", x: 60, y: 60, width: 220, height: 80, label: "Domain controller" }] }],
    });
    assert.ok(!r2.isError, textOf(r2));
    await says(v, "domain controller keeps", 30_000);
    await sleep(2500);
    await shot(v, "camera-4-second-box");
    const r3 = await call("teach_part", {
      board_id,
      section: { title: "Group policy", about: "rights" },
      steps: [{ say: "[1] Group policy sets the rules.", actions: [{ type: "draw_shape", id: "gpo", shape: "rectangle", x: 60, y: 60, width: 200, height: 80, label: "Group policy" }] }],
    });
    assert.ok(!r3.isError, textOf(r3));
    await sleep(1200);
    await shot(v, "camera-5-map");
    await says(v, "Group policy sets", 30_000);
    await sleep(2500);
    await shot(v, "camera-6-third-box");
    const look = textOf(await call("look_at_board", { board_id }));
    assert.match(look, /Box "Active Directory"[\s\S]*Box "Domain controllers"[\s\S]*Box "Group policy"/);
    assert.deepEqual(await v.board.evaluate(() => (window as any).__errors), []);
  } finally {
    await v.close();
  }
});

test("a part sent while the check question is still being asked plays (Claude moved on): the board doesn't wait forever", { skip, timeout: 120_000 }, async () => {
  const id = await open();
  await teach(id, { lines: 1, check: true });
  const v = await show(id);
  try {
    await v.board.locator(".dud__caption").click();
    await says(v, "Where does the", 30_000); // the check question has started
    const { spoken } = await teach(id, { lines: 2 });
    await says(v, spoken[0], 30_000);
    await says(v, spoken[1], 30_000);
  } finally {
    await v.close();
  }
});

test("prepared ahead: after the verdict, the part prepared for it starts with no gap", { skip, timeout: 150_000 }, async () => {
  const board_id = await open();
  await teach(board_id, { lines: 1, check: true });
  const t = tag();
  const next = [`[1] Next, the ${t} coil gets hot.`, `[1] Then the ${t} heat leaves the room.`];
  const r = await call("teach_part", { board_id, when: "after_right", steps: next.map((say, i) => ({ say, actions: [{ type: "write_text", id: `n${t}${i}`, x: 60, y: 400 + i * 60, text: `${t} next ${i}` }] })) });
  assert.match(textOf(r), /^Prepared/);
  await call("teach_part", { board_id, when: "after_wrong", steps: [{ say: `[1] Let's look at the ${t} box again.`, actions: [{ type: "point_at", target: "x" }] }] });
  const v = await show(board_id);
  try {
    await v.board.locator(".dud__caption").click();
    await says(v, "Where does the", 30_000);
    await until("waiting for the answer", async () => !(await v.board.locator(".dud__status").innerText()).includes("Speaking"), 30_000);
    await sleep(8000); // the prepared part's audio is made meanwhile, as while a real part plays
    await type(v, "Outside.");
    const at = await v.board.evaluate(() => performance.now());
    const said = await call("say", { board_id, text: "Yes, exactly right.", answer: "right" });
    assert.match(textOf(said), /then plays the part you prepared for a right answer/);
    await says(v, `Next, the ${t} coil`, 30_000);
    await says(v, `Then the ${t} heat`, 30_000);
    const p = (await played(v)).filter((x) => x.asked > at).sort((a, b) => a.from - b.from);
    assert.ok(p.length >= 2, `reply and the next line played (${p.length})`);
    const gap = p[1].from - p[0].to;
    assert.ok(gap < 1500, `gap between the verdict and the prepared part: ${Math.round(gap)} ms`);
    assert.doesNotMatch(await caption(v), /look at the .* box again/, "the fix for a wrong answer isn't played");
  } finally {
    await v.close();
  }
});
