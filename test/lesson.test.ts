import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { startPlugin, type Plugin } from "./stdio.ts";

// Claude's copy and the board's copy of the plugin, as Claude Desktop runs them.
async function pair(t: TestContext, env: Record<string, string> = {}) {
  const state = mkdtempSync(join(tmpdir(), "dudeling-test-lesson-"));
  chmodSync(state, 0o755); // the plugin must tighten it
  const start = async () => {
    const p = startPlugin({ DUDELING_STATE_DIR: state, DUDELING_LISTEN_MS: "1500", ...env });
    t.after(() => p.kill());
    await p.init();
    return p;
  };
  const claude = await start();
  const board = await start();
  const id: string = (await claude.tool("open_board", { title: "Secret topic" })).structuredContent.board_id;
  return { state, start, claude, board, id };
}
const text = (r: any): string => r.content[0].text;
const said = (board: Plugin, board_id: string, words: string, more: object = {}) =>
  board.tool("learner_said", { board_id, text: words, how: "spoken", ...more });

test("C1: 25 exchanges, each heard once and in order", { timeout: 90_000 }, async (t) => {
  const { claude, board, id } = await pair(t);
  for (let i = 0; i < 25; i++) {
    const waiting = claude.tool("reply_and_listen", { board_id: id, ...(i ? { say: `Reply ${i}.` } : {}) });
    if (i % 2) await sleep(120); // sometimes before Claude listens, sometimes after
    await said(board, id, `Question number ${i}`);
    const heard = text(await waiting);
    assert.deepEqual(heard.match(/Question number \d+/g), [`Question number ${i}`]);
  }
});

test("C1: words left while Claude was away survive a restart of both copies, and arrive once", { timeout: 60_000 }, async (t) => {
  const { start, claude, board, id } = await pair(t);
  await said(board, id, "First doubt");
  await said(board, id, "Second doubt", { how: "typed" });
  await Promise.all([claude.end(), board.end()]);
  const next = await start();
  const heard = text(await next.tool("reply_and_listen", { board_id: id }));
  assert.match(heard, /said: "First doubt"\nThe learner typed: "Second doubt"/);
  assert.doesNotMatch(text(await next.tool("reply_and_listen", { board_id: id })), /doubt/);
});

test("C1: a cancelled wait takes nothing and says Claude is away", { timeout: 60_000 }, async (t) => {
  const { claude, board, id } = await pair(t, { DUDELING_LISTEN_MS: "20000" });
  const wait = claude.request("tools/call", { name: "reply_and_listen", arguments: { board_id: id } });
  await sleep(500);
  assert.equal((await board.tool("board_updates", { board_id: id, since: 0 })).structuredContent.claude, "listening");
  claude.cancel(wait.id);
  await sleep(700);
  assert.equal((await board.tool("board_updates", { board_id: id, since: 0 })).structuredContent.claude, "away");
  await said(board, id, "Still here");
  assert.match(text(await claude.tool("reply_and_listen", { board_id: id })), /Still here/);
});

test("C1: an interruption and a check answer say what they are", { timeout: 60_000 }, async (t) => {
  const { claude, board, id } = await pair(t);
  await said(board, id, "Wait, why?", { interrupted: true, during: "A fridge moves heat." });
  const a = text(await claude.tool("reply_and_listen", { board_id: id }));
  assert.match(a, /interrupting.*A fridge moves heat/);
  assert.match(a, /resume:true/);
  await said(board, id, "Warmer", { check: "Colder or warmer?" });
  assert.match(text(await claude.tool("reply_and_listen", { board_id: id })), /answering the check question "Colder or warmer\?"/);
  await claude.tool("reply_and_listen", { board_id: id, say: "Because heat moves.", resume: true });
  const { events } = (await board.tool("board_updates", { board_id: id, since: 0 })).structuredContent;
  assert.deepEqual(events.map((e: any) => (e.talk ? "talk" : e.resume ? "resume" : "?")), ["talk", "resume"], "resumes after the answer");
});

test("C1: silence ends the turn after four waits, but not while the board narrates", { timeout: 60_000 }, async (t) => {
  const { claude, board, id } = await pair(t, { DUDELING_LISTEN_MS: "1000" });
  await claude.tool("teach_part", { board_id: id, steps: [{ say: "Hello there.", actions: [] }] });
  await board.tool("board_progress", { board_id: id, seq: 1, step: 0, narrating: true });
  assert.match(text(await claude.tool("reply_and_listen", { board_id: id })), /still narrating/);
  await board.tool("board_progress", { board_id: id, seq: 1, step: 1, narrating: false });
  for (let i = 0; i < 3; i++) assert.match(text(await claude.tool("reply_and_listen", { board_id: id })), /Call reply_and_listen again/);
  assert.match(text(await claude.tool("reply_and_listen", { board_id: id })), /End your turn/);
});

test("C3: a message is either taken back or heard, never both", { timeout: 60_000 }, async (t) => {
  const { claude, board, id } = await pair(t);
  const one = (await said(board, id, "Take me back")).structuredContent.id;
  assert.equal((await board.tool("learner_unsend", { board_id: id, id: one })).structuredContent.withdrawn, true);
  const two = (await said(board, id, "Keep me")).structuredContent.id;
  const heard = text(await claude.tool("reply_and_listen", { board_id: id }));
  assert.ok(heard.includes("Keep me") && !heard.includes("Take me back"));
  assert.equal((await board.tool("learner_unsend", { board_id: id, id: two })).structuredContent.withdrawn, false);
});

test("B4: the played-up-to position only moves forward", { timeout: 60_000 }, async (t) => {
  const { claude, board, id } = await pair(t);
  await claude.tool("teach_part", { board_id: id, steps: [{ say: "One.", actions: [] }, { say: "Two.", actions: [] }] });
  await board.tool("board_progress", { board_id: id, seq: 1, step: 2, narrating: true });
  await board.tool("board_progress", { board_id: id, seq: 1, step: 1, narrating: false });
  const { played } = (await board.tool("board_updates", { board_id: id, since: 0 })).structuredContent;
  assert.deepEqual([played.seq, played.step, played.narrating], [1, 2, false]);
});

test("B5: the newest view wins", { timeout: 60_000 }, async (t) => {
  const { board, id } = await pair(t);
  await board.tool("board_updates", { board_id: id, since: 0, view: "old", take: true });
  const old = board.tool("board_updates", { board_id: id, since: 0, view: "old", wait_ms: 8000, claude: "busy" });
  await sleep(300);
  await board.tool("board_updates", { board_id: id, since: 0, view: "new", take: true });
  assert.equal((await old).structuredContent.superseded, true);
});

test("B6: board_updates waits, and answers within 1 s of a change", { timeout: 60_000 }, async (t) => {
  const { claude, board, id } = await pair(t);
  let t0 = Date.now();
  await board.tool("board_updates", { board_id: id, since: 0, wait_ms: 2000, claude: "busy" });
  assert.ok(Date.now() - t0 >= 1900, "waited while nothing happened");
  const update = board.tool("board_updates", { board_id: id, since: 0, wait_ms: 10_000, claude: "busy" });
  await sleep(500);
  t0 = Date.now();
  await claude.tool("say", { board_id: id, text: "Hello." });
  assert.equal((await update).structuredContent.events[0].talk, "Hello.");
  assert.ok(Date.now() - t0 < 1000);
});

test("D1: files are the owner's only, and the log holds none of what was said", { timeout: 60_000 }, async (t) => {
  const { state, claude, board, id } = await pair(t);
  await said(board, id, "My private question");
  await claude.tool("reply_and_listen", { board_id: id, say: "My private answer" });
  // The player's timeline (no words) is kept, so a real run can be read afterwards.
  await board.tool("board_log", { entries: [{ level: "info", message: "player: step 3 start" }] });
  // Unix permissions; on Windows the folder is private by being in the user's own AppData.
  if (process.platform !== "win32") {
    assert.equal(statSync(state).mode & 0o777, 0o700);
    for (const f of readdirSync(state, { withFileTypes: true }))
      assert.equal(statSync(join(state, f.name)).mode & 0o777, f.isDirectory() ? 0o700 : 0o600, f.name);
  }
  const file = readFileSync(join(state, "dudeling.log"), "utf8");
  assert.match(file, /board info: player: step 3 start/, "the log file keeps the timeline");
  for (const words of ["My private question", "My private answer", "Secret topic"]) {
    for (const p of [claude, board]) assert.ok(!p.log().includes(words), `logged: ${words}`);
    assert.ok(!file.includes(words), `in the log file: ${words}`);
  }
});

test("D1: a lesson lasts 30 days, then goes with everything beside it", { timeout: 60_000 }, async (t) => {
  const { state, board, id } = await pair(t);
  await said(board, id, "Hello");
  process.env.DUDELING_STATE_DIR = state;
  const boards = await import("../server/boards.ts");
  const age = (days: number) => utimesSync(join(state, `${id}.json`), new Date(), new Date(Date.now() - days * 86_400_000));
  age(29);
  boards.sweep();
  assert.ok(boards.getBoard(id), "still there on day 29");
  age(31);
  boards.sweep();
  assert.deepEqual(readdirSync(state).filter((f) => f.startsWith(id)), []);
});

test("D3: bad input is refused usefully, and results to Claude stay under 140K characters", { timeout: 60_000 }, async (t) => {
  const { claude, board, id } = await pair(t);
  for (const action of [
    { type: "write_text", id: "a", x: 1e7, y: 10, text: "far away" },
    { type: "write_text", id: "a", x: 10, y: 10, text: "x".repeat(400) },
    { type: "draw_arrow", id: "b", from: "a" },
    { type: "draw_freehand", id: "c", points: [[1, 2]] },
  ]) {
    const r = await claude.tool("teach_part", { board_id: id, steps: [{ say: "Look.", actions: [action] }] }).catch((e: Error) => ({ isError: true, content: [{ text: e.message }] }));
    assert.ok(r.isError, JSON.stringify(action).slice(0, 80));
    assert.match(text(r), new RegExp(action.type));
  }
  for (let n = 0; n < 50; n++) {
    const actions = Array.from({ length: 8 }, (_, i) => ({ type: "write_text", id: `${"i".repeat(200)}${n}-${i}`, x: 40, y: 40, text: "y".repeat(300) }));
    assert.ok(!(await claude.tool("draw", { board_id: id, actions })).isError);
  }
  await board.tool("learner_drew", { board_id: id, image: "A".repeat(118_000), mime_type: "image/jpeg", note: "marks" });
  const look = await claude.tool("look_at_board", { board_id: id });
  assert.equal(look.content[1].mimeType, "image/jpeg");
  assert.ok(JSON.stringify(look).length < 140_000, String(JSON.stringify(look).length));
});

test("D3: annotations say what the tools do", { timeout: 60_000 }, async (t) => {
  const { claude } = await pair(t);
  const { tools } = await claude.request("tools/list", {}).reply;
  const hints = Object.fromEntries(tools.map((x: any) => [x.name, x.annotations]));
  assert.equal(hints.look_at_board.readOnlyHint, true);
  assert.equal(hints.teach_part.readOnlyHint, false);
  assert.equal(hints.clear_board.destructiveHint, true);
});

test("D2: 10 copies started together give one engine", { timeout: 60_000 }, async (t) => {
  const state = mkdtempSync(join(tmpdir(), "dudeling-test-race-"));
  const copies = Array.from({ length: 10 }, () => startPlugin({ DUDELING_STATE_DIR: state }));
  t.after(() => Promise.all(copies.map((p) => p.kill())));
  await Promise.all(copies.map((p) => p.init()));
  await sleep(3000);
  assert.equal(copies.filter((p) => p.log().includes("is the voice/hearing engine")).length, 1);
});

test("D2: when the engine copy is killed, another takes over", { timeout: 60_000 }, async (t) => {
  const state = mkdtempSync(join(tmpdir(), "dudeling-test-takeover-"));
  const first = startPlugin({ DUDELING_STATE_DIR: state });
  t.after(() => first.kill());
  await first.init();
  await sleep(1000);
  const second = startPlugin({ DUDELING_STATE_DIR: state });
  t.after(() => second.kill());
  await second.init();
  await sleep(500);
  await first.kill();
  const r = await second.tool("speak", { text: "Taking over now." });
  assert.ok(!r.isError, second.log());
  assert.match(second.log(), /is the voice\/hearing engine/);
});
