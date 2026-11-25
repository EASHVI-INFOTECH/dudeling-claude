import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { BOARD_URI } from "../server/app.ts";

// Runs the real plugin over stdio (needs `npm run build` first for dist/board.html).
// Boards live in files: this test process and the server process share them (as Claude Desktop's two copies do).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const STATE = mkdtempSync(join(tmpdir(), "dudeling-test-boards-"));
process.env.DUDELING_STATE_DIR = STATE;
let client: Client;

before(async () => {
  client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["server/stdio.ts"],
      env: { ...(process.env as Record<string, string>), DUDELING_STATE_DIR: STATE, DUDELING_QUIET: "1" },
      stderr: "ignore",
    }),
  );
});
after(async () => {
  await client?.close().catch(() => {});
});

test("lists the live tools (open_board has the whiteboard) and the guide; no one-shot teach", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["board_ink", "board_log", "board_progress", "board_updates", "clear_board", "draw", "dudeling_guide", "learner_active", "learner_drew", "learner_said", "learner_unsend", "look_at_board", "open_board", "pause_board", "reply_and_listen", "resume_board", "say", "speak", "teach_part", "transcribe"]);
  const open = tools.find((t) => t.name === "open_board")!;
  assert.equal((open._meta as any)?.ui?.resourceUri, BOARD_URI);
  assert.match(open.description ?? "", /reply_and_listen/);
  assert.deepEqual((tools.find((t) => t.name === "learner_drew")!._meta as any)?.ui?.visibility, ["app"]);
});

test("the whiteboard resource is a self-contained MCP App page", async () => {
  const { contents } = await client.readResource({ uri: BOARD_URI });
  const page = contents[0] as { mimeType?: string; text?: string; _meta?: any };
  assert.equal(page.mimeType, "text/html;profile=mcp-app");
  assert.ok(page.text!.length > 100_000 && page.text!.includes("<div id=\"root\">"), "built board");
  // Everything is inlined: no separate JS/CSS files to fetch (Excalidraw's embed templates mention
  // <script src=…> in strings, so check for built asset links instead).
  assert.ok(!/(src|href)="[^"]*assets\//.test(page.text!), "no separate asset files");
  assert.deepEqual(page._meta.ui.csp, { resourceDomains: [], connectDomains: [] }, "no network");
});

test("the guide explains the format and layouts", async () => {
  const r = await client.callTool({ name: "dudeling_guide", arguments: {} });
  const text = (r.content as { text: string }[])[0].text;
  assert.match(text, /Proven layouts/);
  assert.match(text, /SAFE AREA x 30\.\.1170/);
});

test("teach-me prompt", async () => {
  const p = await client.getPrompt({ name: "teach-me", arguments: { topic: "photosynthesis" } });
  const text = (p.messages[0].content as { text: string }).text;
  assert.match(text, /photosynthesis/);
  assert.match(text, /teach_part/);
});

test("live board: open, draw as you talk, look back, and the board fetches updates", async () => {
  const { tools } = await client.listTools();
  const updatesTool = tools.find((t) => t.name === "board_updates");
  assert.deepEqual((updatesTool?._meta as any)?.ui?.visibility, ["app"], "board_updates is for the board, not the model");
  assert.equal((tools.find((t) => t.name === "open_board")!._meta as any)?.ui?.resourceUri, BOARD_URI);

  const opened = await client.callTool({ name: "open_board", arguments: { title: "TCP handshake" } });
  const board_id = (opened.structuredContent as { board_id: string }).board_id;
  assert.match(board_id, /^b_/);

  const d1 = await client.callTool({
    name: "draw",
    arguments: { board_id, caption: "Two computers", actions: [{ type: "draw_shape", id: "client", shape: "rectangle", x: 60, y: 200, width: 180, height: 80, label: "Client" }] },
  });
  assert.ok(!d1.isError);
  await client.callTool({ name: "draw", arguments: { board_id, actions: [{ type: "draw_arrow", id: "syn", from: "client", to: { x: 900, y: 240 }, label: "1. SYN" }] } });

  const u = await client.callTool({ name: "board_updates", arguments: { board_id, since: 0 } });
  const events = (u.structuredContent as { events: { seq: number; caption?: string }[] }).events;
  assert.deepEqual(events.map((e) => e.seq), [1, 2]);
  assert.equal(events[0].caption, "Two computers");
  const later = await client.callTool({ name: "board_updates", arguments: { board_id, since: 2 } });
  assert.equal((later.structuredContent as { events: unknown[] }).events.length, 0);

  const look = await client.callTool({ name: "look_at_board", arguments: { board_id } });
  const text = (look.content as { text: string }[])[0].text;
  assert.match(text, /client: draw_shape "Client" at \(60,200\)/);
  assert.match(text, /syn: draw_arrow "1\. SYN"/);
});

test("live board: unknown boards are refused clearly", async () => {
  const d = await client.callTool({ name: "draw", arguments: { board_id: "b_nope", actions: [{ type: "wait", ms: 10 }] } });
  assert.ok(d.isError);
  assert.match((d.content as { text: string }[])[0].text, /open_board/);
  const u = await client.callTool({ name: "board_updates", arguments: { board_id: "b_nope", since: 0 } });
  assert.equal((u.structuredContent as { gone?: boolean }).gone, true);
});

test("the guide teaches live tutoring: parts, check-ins, interruptions", async () => {
  const r = await client.callTool({ name: "dudeling_guide", arguments: {} });
  const text = (r.content as { text: string }[])[0].text;
  assert.match(text, /## The loop/);
  assert.match(text, /teach_part/);
  assert.match(text, /reply_and_listen/);
  assert.match(text, /call `pause_board` first/);
  assert.doesNotMatch(text, /sampling|answers? (their questions )?itself|whole lesson in one turn/i);
});

test("the learner's drawing reaches the assistant through look_at_board", async () => {
  const opened = await client.callTool({ name: "open_board", arguments: { title: "Triangles" } });
  const board_id = (opened.structuredContent as { board_id: string }).board_id;
  // A 1×1 PNG stands in for the board's picture.
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const saved = await client.callTool({ name: "learner_drew", arguments: { board_id, image: png, mime_type: "image/png", note: "3 marks by the learner" } });
  assert.ok(!saved.isError);
  const look = await client.callTool({ name: "look_at_board", arguments: { board_id } });
  const parts = look.content as { type: string; text?: string; data?: string; mimeType?: string }[];
  assert.match(parts[0].text!, /learner has drawn/);
  assert.equal(parts[1].type, "image");
  assert.equal(parts[1].mimeType, "image/png");
  assert.equal(parts[1].data, png);
  const bad = await client.callTool({ name: "learner_drew", arguments: { board_id, image: "<script>", mime_type: "image/png", note: "x" } });
  assert.ok(bad.isError);
});

test("speak: the plugin makes the board's voice (or says it can't)", { timeout: 120_000 }, async () => {
  const { tools } = await client.listTools();
  assert.deepEqual((tools.find((t) => t.name === "speak")!._meta as any)?.ui?.visibility, ["app"], "speak is for the board, not the model");
  const { voiceInstalled } = await import("../server/voice.ts");
  const p = await client.callTool({ name: "speak", arguments: { text: "", probe: true } });
  assert.equal(typeof (p.structuredContent as { available?: boolean }).available, "boolean", "probe answers at once");
  const r = await client.callTool({ name: "speak", arguments: { text: "Hello there." } });
  const sc = r.structuredContent as { wav?: string; durationMs?: number; unavailable?: string };
  if (voiceInstalled() || process.env.DUDELING_VOICE_DOWNLOAD !== "off") {
    assert.ok(!r.isError, "speaks");
    assert.equal(Buffer.from(sc.wav!, "base64").subarray(0, 4).toString(), "RIFF");
    assert.ok(sc.durationMs! > 300 && sc.durationMs! < 5000, String(sc.durationMs));
  } else {
    assert.ok(r.isError);
    assert.equal(sc.unavailable, "not-installed");
  }
});

test("one board per conversation: clear_board starts a new topic on the same board", async () => {
  const opened = await client.callTool({ name: "open_board", arguments: { title: "Fridges" } });
  const board_id = (opened.structuredContent as { board_id: string }).board_id;
  await client.callTool({ name: "draw", arguments: { board_id, actions: [{ type: "draw_shape", id: "fridge", shape: "rectangle", x: 100, y: 100, width: 160, height: 80, label: "Fridge" }] } });
  const cleared = await client.callTool({ name: "clear_board", arguments: { board_id, title: "Heat pumps" } });
  assert.ok(!cleared.isError);
  await client.callTool({ name: "draw", arguments: { board_id, actions: [{ type: "draw_shape", id: "pump", shape: "ellipse", x: 100, y: 100, width: 160, height: 80, label: "Pump" }] } });
  const u = await client.callTool({ name: "board_updates", arguments: { board_id, since: 0 } });
  const events = (u.structuredContent as { events: { clear?: { title: string } }[] }).events;
  assert.deepEqual(events.map((e) => (e.clear ? `clear:${e.clear.title}` : "draw")), ["clear:Heat pumps", "draw"], "from the start: only what's on the board");
  const after = await client.callTool({ name: "board_updates", arguments: { board_id, since: 1 } });
  assert.equal((after.structuredContent as { events: { clear?: { title: string } }[] }).events[0].clear?.title, "Heat pumps", "a board already showing sees the clear");
  const look = (await client.callTool({ name: "look_at_board", arguments: { board_id } })).content as { text: string }[];
  assert.match(look[0].text, /Board "Heat pumps"/);
  assert.match(look[0].text, /pump: draw_shape "Pump"/);
  assert.doesNotMatch(look[0].text, /fridge/, "only what's on the board since the clear");
  const { tools } = await client.listTools();
  assert.match(tools.find((t) => t.name === "open_board")!.description!, /ONCE per conversation/);
});

test("teach_part: one call per narrated part; pause and resume for interruptions", async () => {
  const opened = await client.callTool({ name: "open_board", arguments: { title: "Fridges" } });
  const board_id = (opened.structuredContent as { board_id: string }).board_id;
  const part = {
    board_id,
    steps: [
      { say: "[1] A fridge moves heat.", actions: [{ type: "draw_shape", id: "fridge", shape: "rectangle", x: 100, y: 100, width: 160, height: 80, label: "Fridge" }] },
      { say: "It dumps it [1] outside.", actions: [{ type: "draw_shape", id: "room", shape: "rectangle", x: 600, y: 100, width: 160, height: 80, label: "Room" }] },
    ],
    check: { question: "Does an open fridge cool the room?", answer: "No." },
  };
  const r = await client.callTool({ name: "teach_part", arguments: part });
  assert.ok(!r.isError);
  const text = (r.content as { text: string }[])[0].text;
  assert.match(text, /narrating it in Dudeling's voice/);
  assert.match(text, /reply_and_listen/);
  assert.match(text, /Does an open fridge cool the room\?/);
  await client.callTool({ name: "pause_board", arguments: { board_id } });
  await client.callTool({ name: "resume_board", arguments: { board_id } });
  const u = await client.callTool({ name: "board_updates", arguments: { board_id, since: 0 } });
  const events = (u.structuredContent as { events: { part?: { steps: unknown[] }; pause?: boolean; resume?: boolean }[] }).events;
  assert.deepEqual(events.map((e) => (e.part ? `part:${e.part.steps.length}` : e.pause ? "pause" : e.resume ? "resume" : "?")), ["part:2", "pause", "resume"]);
  const look = (await client.callTool({ name: "look_at_board", arguments: { board_id } })).content as { text: string }[];
  assert.match(look[0].text, /fridge: draw_shape "Fridge"/, "look_at_board sees what parts drew");
});

test("boards are shared between processes (Claude Desktop runs the plugin twice) and survive restarts", async () => {
  const opened = await client.callTool({ name: "open_board", arguments: { title: "Shared" } });
  const board_id = (opened.structuredContent as { board_id: string }).board_id;
  await client.callTool({ name: "teach_part", arguments: { board_id, steps: [{ say: "[1] Hi.", actions: [{ type: "write_text", id: "hi", x: 40, y: 40, text: "Hi" }] }] } });
  // A different process (this test) reads what the server process wrote.
  const boards = await import("../server/boards.ts");
  const u = boards.updates(board_id, 0);
  assert.ok(u, "the board is visible to another process");
  assert.equal(u!.events[0].part?.steps.length, 1);
  // The learner's drawing, written by "the board's process", is seen by the server process.
  assert.ok(boards.setSnapshot(board_id, "iVBORw0KGgo=", "1 mark"));
  const look = (await client.callTool({ name: "look_at_board", arguments: { board_id } })).content as { type: string }[];
  assert.equal(look[1]?.type, "image");
  assert.equal(boards.updates("b_../../etc/passwd", 0), null, "ids can't reach other files");
});

test("voice sessions: say reaches the board; the board asks for the microphone", async () => {
  const opened = await client.callTool({ name: "open_board", arguments: { title: "Chat" } });
  const board_id = (opened.structuredContent as { board_id: string }).board_id;
  const r = await client.callTool({ name: "say", arguments: { board_id, text: "Good question! A refrigerant is a fluid that boils at low temperatures." } });
  assert.ok(!r.isError);
  const u = await client.callTool({ name: "board_updates", arguments: { board_id, since: 0 } });
  assert.match((u.structuredContent as { events: { talk?: string }[] }).events[0].talk!, /refrigerant/);
  const { contents } = await client.readResource({ uri: BOARD_URI });
  assert.deepEqual((contents[0] as { _meta: any })._meta.ui.permissions, { microphone: {} });
  const { tools } = await client.listTools();
  assert.deepEqual((tools.find((t) => t.name === "transcribe")!._meta as any)?.ui?.visibility, ["app"]);
  const g = (await client.callTool({ name: "dudeling_guide", arguments: {} })).content as { text: string }[];
  assert.match(g[0].text, /resume:true/);
});

test("events carry their time and updates the server's clock (old boards replay silently)", async () => {
  const opened = await client.callTool({ name: "open_board", arguments: { title: "Clock" } });
  const board_id = (opened.structuredContent as { board_id: string }).board_id;
  await client.callTool({ name: "teach_part", arguments: { board_id, steps: [{ say: "[1] Hi.", actions: [{ type: "write_text", id: "hi", x: 40, y: 40, text: "Hi" }] }] } });
  const u = (await client.callTool({ name: "board_updates", arguments: { board_id, since: 0 } })).structuredContent as { now: number; events: { at: number }[] };
  assert.ok(typeof u.now === "number" && typeof u.events[0].at === "number");
  assert.ok(u.now >= u.events[0].at && u.now - u.events[0].at < 5000);
});

test("the tool results point Claude at teach_part, not the old tools", async () => {
  const opened = await client.callTool({ name: "open_board", arguments: { title: "Words" } });
  const text = (opened.content as { text: string }[])[0].text;
  assert.match(text, /teach_part/);
  assert.doesNotMatch(text, /call draw/);
  const board_id = (opened.structuredContent as { board_id: string }).board_id;
  const cleared = (await client.callTool({ name: "clear_board", arguments: { board_id, title: "Next" } })).content as { text: string }[];
  assert.match(cleared[0].text, /teach_part/);
});

test("one engine per computer: a second copy forwards voice and hearing to the first", { timeout: 120_000 }, async (t) => {
  const { voiceInstalled } = await import("../server/voice.ts");
  if (!voiceInstalled()) return t.skip("voice model not installed");
  await new Promise((r) => setTimeout(r, 1500)); // the server copy has claimed the engine at start-up
  const engine = await import("../server/engine.ts");
  const s = await engine.speak("Forwarded to the engine.");
  assert.equal(engine.engineRole(), "client", "this second copy didn't load its own models");
  assert.ok(s.durationMs > 500 && s.wav.length > 1000);
});

test("teach_part section: a subtopic is a new box on the same board, not a clear", async () => {
  const opened = await client.callTool({ name: "open_board", arguments: { title: "Active Directory" } });
  const board_id = (opened.structuredContent as { board_id: string }).board_id;
  const step = (id: string) => ({ say: "[1] Here.", actions: [{ type: "draw_shape", id, shape: "rectangle", x: 100, y: 100, width: 160, height: 80, label: id }] });
  assert.ok(!(await client.callTool({ name: "teach_part", arguments: { board_id, steps: [step("users")] } })).isError);
  const r = await client.callTool({ name: "teach_part", arguments: { board_id, steps: [step("dc")], section: { title: "Domain controllers", about: "users" } } });
  assert.ok(!r.isError);
  const u = await client.callTool({ name: "board_updates", arguments: { board_id, since: 0 } });
  const events = (u.structuredContent as { events: { clear?: unknown; part?: { section?: { title: string; about?: string } } }[] }).events;
  assert.ok(!events.some((e) => e.clear), "nothing wiped");
  assert.deepEqual(events.at(-1)!.part!.section, { title: "Domain controllers", about: "users" });
  const look = ((await client.callTool({ name: "look_at_board", arguments: { board_id } })).content as { text: string }[])[0].text;
  assert.match(look, /Box "Active Directory":\n- users: draw_shape "users" at \(100,100\)\nBox "Domain controllers":\n- dc: draw_shape "dc"/);
  const { tools } = await client.listTools();
  assert.match(tools.find((t) => t.name === "clear_board")!.description!, /Never for a subtopic/);
  assert.ok((tools.find((t) => t.name === "teach_part")!.inputSchema.properties as Record<string, unknown>).section, "section is offered");
});

test("the board's address changes with every version (Claude Desktop keeps a page it has read); the old one still answers", async () => {
  const { VERSION } = await import("../server/version.ts");
  assert.equal(BOARD_URI, `ui://dudeling/board-${VERSION}.html`);
  const current = await client.readResource({ uri: BOARD_URI });
  for (const suffix of ["board.html", "board-1.0.0-rc.5.html", "board-1.0.0-rc.6.html"]) {
    const legacy = await client.readResource({ uri: "ui://dudeling/" + suffix });
    assert.equal((legacy.contents[0] as { text: string }).text, (current.contents[0] as { text: string }).text);
  }
});

test("prepared parts: held off the board until the verdict, then played; tool results guide the loop", async () => {
  const opened = await client.callTool({ name: "open_board", arguments: { title: "Fridges" } });
  const board_id = (opened.structuredContent as { board_id: string }).board_id;
  const step = (id: string) => ({ say: "[1] Here.", actions: [{ type: "draw_shape", id, shape: "rectangle", x: 100, y: 100, width: 160, height: 80, label: id }] });
  const now = (await client.callTool({ name: "teach_part", arguments: { board_id, steps: [step("first")], check: { question: "Why?", answer: "Because." } } })).content as { text: string }[];
  assert.match(now[0].text, /prepare the next part now: teach_part with when:"after_right"/);
  const next = (await client.callTool({ name: "teach_part", arguments: { board_id, steps: [step("second")], when: "after_right" } })).content as { text: string }[];
  assert.match(next[0].text, /^Prepared: it plays the moment you judge the check answer right/);
  await client.callTool({ name: "teach_part", arguments: { board_id, steps: [step("fix")], when: "after_wrong" } });
  const look = async () => ((await client.callTool({ name: "look_at_board", arguments: { board_id } })).content as { text: string }[])[0].text;
  assert.doesNotMatch(await look(), /second|fix/, "prepared parts aren't on the board yet");
  const wrong = (await client.callTool({ name: "say", arguments: { board_id, text: "Not quite.", answer: "wrong" } })).content as { text: string }[];
  assert.match(wrong[0].text, /then plays the fix you prepared. Your part for a right answer is still ready/);
  assert.match(await look(), /fix/);
  assert.doesNotMatch(await look(), /second/, "the next part waits for a right answer");
  await client.callTool({ name: "say", arguments: { board_id, text: "Yes!", answer: "right" } });
  assert.match(await look(), /- first[\s\S]*- fix[\s\S]*- second/, "in the order they played");
  const none = (await client.callTool({ name: "say", arguments: { board_id, text: "Yes!", answer: "right" } })).content as { text: string }[];
  assert.match(none[0].text, /Nothing was prepared for a right answer: send the next part with teach_part now/);
  const u = await client.callTool({ name: "board_updates", arguments: { board_id, since: 0 } });
  const events = (u.structuredContent as { events: { release?: { answer: string }; part?: { when?: string } }[] }).events;
  assert.deepEqual(events.filter((e) => e.release).map((e) => e.release!.answer), ["wrong", "right", "right"], "the board gets the verdicts");
});
