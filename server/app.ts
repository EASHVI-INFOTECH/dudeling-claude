/**
 * Dudeling as an MCP App (https://modelcontextprotocol.io/extensions/apps).
 *
 * The chat assistant is the tutor; Dudeling is its whiteboard, voice and ears. `open_board` opens the
 * board in the chat; `teach_part` sends a part of the lesson, which the board draws and narrates;
 * `reply_and_listen` says Claude's reply and returns what the learner then says or types on the board.
 * No API keys, no accounts: the user's own chat plan runs the model.
 *
 * The log never holds what was taught or said (DUDELING_DEBUG adds step timings, still no words).
 */
import { readFileSync } from "node:fs";
import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { log } from "./log.ts";
import { actionSchema } from "./actions.ts";
import * as boards from "./boards.ts";
import * as engine from "./engine.ts";
import { CLEAR_BOARD_DESCRIPTION, DRAW_DESCRIPTION, GUIDE, OPEN_BOARD_DESCRIPTION, REPLY_AND_LISTEN_DESCRIPTION, TEACH_PART_DESCRIPTION } from "./guide.ts";
import { CHUNK, ink } from "./ink.ts";
import * as inbox from "./inbox.ts";
import { changed, listen, type Heard } from "./listen.ts";
import { unsupportedHere, unsupportedMessage } from "./models.ts";
import { checkLine, speechPieces } from "./speech-text.ts";
import { VERSION } from "./version.ts";
import * as voice from "./voice.ts";

export { VERSION };
/**
 * The board's address carries the version: Claude Desktop keeps a board page it has read and doesn't read it again
 * when the plugin is updated, so a new version must be a new address. The old address still answers, for boards in older chats.
 */
export const BOARD_URI = `ui://dudeling/board-${VERSION}.html`;
const LEGACY_BOARD_URI = "ui://dudeling/board.html";

// What each tool really does. All of it stays inside Dudeling's own boards, on this computer.
const LOOKS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const CHANGES = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const WIPES = { ...CHANGES, destructiveHint: true } as const;
const FROM_BOARD = { ui: { resourceUri: BOARD_URI, visibility: ["app"] as ("app" | "model")[] } };

/** The built whiteboard (vite build → dist/board.html: one self-contained file). */
export function loadBoardHtml(path = new URL("../dist/board.html", import.meta.url)): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    // Keep the plugin up (its tools still answer) and say what's wrong where the board would be.
    console.error("[dudeling] dist/board.html is missing: run `npm run build`.");
    return `<!doctype html><meta charset="utf-8"><body style="font:15px system-ui;padding:24px">Dudeling's whiteboard isn't built yet: run <code>npm run build</code> in the plugin's folder.</body>`;
  }
}


const ANSWER = z
  .enum(["right", "wrong"])
  .optional()
  .describe("Your verdict on their check answer: the board says your words, then plays the part prepared for it (teach_part when:after_right / after_wrong).");

const ok = (text: string, structuredContent?: Record<string, unknown>) => ({ content: [{ type: "text" as const, text }], ...(structuredContent ? { structuredContent } : {}) });
const failed = (text: string, structuredContent?: Record<string, unknown>) => ({ ...ok(text, structuredContent), isError: true });
/** How long the board's `speak` waits. Claude gives up on a call at 60 s, so "not yet" comes well before. */
const SPEAK_WAIT_MS = 15_000;
const NO_BOARD = "No such board (it may have expired). Open a new one with open_board.";

const boardId = z.string().max(40).describe("From open_board.");
const viewScope = { topic: z.number().int().nonnegative().optional(), view: z.string().max(40).optional() };
const spokenReply = z.string().trim().min(1).max(800);

/** Start on a line's audio before the board asks for it. */
function makeAudio(id: string, line: string, priority: voice.Priority) {
  if (voice.voiceStatus() !== "ready") return;
  for (const piece of speechPieces(voice.spokenText(line))) void engine.prefetch(piece, { priority, group: id }).catch(() => {});
}

async function releaseBranch(id: string, answer: "right" | "wrong") {
  const result = boards.release(id, answer);
  if ("discarded" in result && result.discarded) await engine.cancel(id + ":" + result.discarded);
  return result;
}

function describeHeard(result: Heard): string {
  if (result.kind === "cancelled") return "Stopped waiting.";
  if (result.kind === "stop")
    return 'Nothing heard for a while. End your turn now, with one short chat line like "Say continue when you\'re ready." Don\'t call reply_and_listen again until they write to you.';
  if (result.kind === "again")
    return result.narrating
      ? 'The board is still narrating and the learner hasn\'t spoken. Call reply_and_listen again now, without "say".'
      : 'Nothing heard yet. Call reply_and_listen again now, without "say" (don\'t repeat yourself, and write nothing in the chat).';
  const lines = result.messages.map((m) => {
    const when = m.check
      ? ` (answering the check question ${JSON.stringify(m.check)})`
      : m.interrupted
        ? ` (interrupting${m.during ? `, while the board was saying ${JSON.stringify(m.during)}` : ""}; the board has paused)`
        : "";
    return `The learner ${m.how === "typed" ? "typed" : "said"}${when}: ${JSON.stringify(m.text)}`;
  });
  const last = result.messages.at(-1)!;
  const next = last.check
    ? 'Judge it kindly and specifically with reply_and_listen {say}; once they\'ve got it, teach the next part.'
    : result.messages.some((m) => m.interrupted)
      ? "Answer with reply_and_listen {say, resume:true}, so the lesson carries on after your answer."
      : "Answer with reply_and_listen {say}, or teach_part if they're ready for the next part.";
  return `${lines.join("\n")}\n\n${next}`;
}

export function createDudelingServer(boardHtml: string | (() => string) = loadBoardHtml): McpServer {
  const server = new McpServer({ name: "dudeling", version: VERSION });

  registerAppTool(
    server,
    "open_board",
    {
      title: "Open a whiteboard",
      description: OPEN_BOARD_DESCRIPTION,
      inputSchema: z.object({ title: z.string().min(1).max(120).describe("What this board teaches.") }),
      annotations: CHANGES,
      _meta: { ui: { resourceUri: BOARD_URI } },
    },
    async ({ title }) => {
      if (unsupportedHere()) return failed(`${unsupportedMessage()} Tell the user that, and teach them in the chat instead.`, { unsupported: unsupportedMessage() });
      const id = boards.openBoard(title);
      boards.setClaude(id, "busy");
      void engine.prepare("voice");
      log(`open_board → ${id}`);
      return ok(
        `Board "${title}" is open (board_id: ${id}). Now teach_part (board_id "${id}"), then reply_and_listen, part by part. Keep this one board for the whole conversation.`,
        { board_id: id, title },
      );
    },
  );

  server.registerTool(
    "teach_part",
    {
      title: "Teach a part on the whiteboard",
      description: TEACH_PART_DESCRIPTION,
      inputSchema: z.object({
        board_id: boardId,
        steps: z
          .array(
            z.object({
              say: z.string().trim().min(1).max(600).describe("1-2 spoken sentences, with [1], [2] … right before the words for each action."),
              actions: z.array(actionSchema).max(6),
            }),
          )
          .min(1)
          .max(8),
        check: z.object({ question: z.string().min(1).max(300), answer: z.string().max(600) }).optional().describe("Asked aloud by the board at the end of the part."),
        section: z
          .object({
            title: z.string().trim().min(1).max(60).describe("The box's title, e.g. \"Domain controllers\". The same title again goes back to that box."),
            about: z.string().max(120).optional().describe("Id of the thing in the first box this subtopic zooms into: the new box sits next to it, linked by an arrow."),
          })
          .optional()
          .describe("A new subtopic: teach this part in a NEW box on the same board, next to the others (the board keeps a map of them). Its coordinates start fresh. Leave out to keep drawing in the current box."),
        when: z
          .enum(["now", "after_right", "after_wrong"])
          .optional()
          .describe('"now" (default) plays at once. Prepare the NEXT part while this one plays: "after_right" plays the moment you judge their check answer right; "after_wrong" (optional, 1-3 steps re-explaining, same check again) plays if you judge it wrong. Judge with answer on say or reply_and_listen.'),
      }),
      annotations: CHANGES,
    },
    async ({ board_id, steps, check, section, when }) => {
      const ahead = when === "after_right" || when === "after_wrong";
      const r = boards.teachPart(board_id, { steps: steps as never, ...(check ? { check } : {}), ...(section ? { section } : {}), ...(ahead ? { when } : {}) });
      log(`teach_part ${board_id} ${steps.length} steps${check ? " + check" : ""}${section ? " + box" : ""}${ahead ? ` ${when}` : ""}${"error" in r ? ` failed: ${r.error}` : ""}`);
      if ("error" in r) return failed(r.error);
      // Start making the part's audio now, in order, before the board asks for it (a prepared part: behind
      // everything that plays sooner).
      const group = ahead ? board_id + ":" + r.seq : board_id;
      if (r.discarded) await engine.cancel(board_id + ":" + r.discarded);
      steps.forEach((s, i) => makeAudio(group, s.say, i || ahead ? "ahead" : "next"));
      if (check) makeAudio(group, checkLine(check.question), "ahead");
      if (ahead) {
        const other = when === "after_right" ? "after_wrong" : "after_right";
        return ok(
          `Prepared: it plays the moment you judge the check answer ${when === "after_right" ? "right" : "wrong"} (answer:"${when === "after_right" ? "right" : "wrong"}" on say or reply_and_listen), with its audio ready. ` +
            (boards.prepared(board_id).includes(other === "after_right" ? "right" : "wrong") ? "" : other === "after_wrong" ? "Optionally prepare a short fix with when:\"after_wrong\". " : "") +
            `Then call reply_and_listen with board_id "${board_id}" and no "say" to hear their answer.`,
        );
      }
      boards.setClaude(board_id, "busy", undefined, { quiet: 0, waits: 0 });
      const words = steps.reduce((n, s) => n + s.say.split(/\s+/).length, 0);
      const secs = Math.round(words / 2.6) + steps.length;
      return ok(
        `The board is drawing this part and narrating it in Dudeling's voice (about ${secs} s). Don't repeat it in the chat. ` +
          (check ? `At the end it asks "${check.question}" (answer: ${check.answer}). ` : "") +
          (check
            ? `While it plays, prepare the next part now: teach_part with when:"after_right" (and optionally a short fix with when:"after_wrong"), so it starts the moment they answer. Then call reply_and_listen with board_id "${board_id}" and no "say".`
            : `Now call reply_and_listen with board_id "${board_id}" and no "say": it returns what the learner says, including any interruption.`),
      );
    },
  );

  server.registerTool(
    "reply_and_listen",
    {
      title: "Talk with the learner",
      description: REPLY_AND_LISTEN_DESCRIPTION,
      inputSchema: z.object({
        board_id: boardId,
        say: spokenReply.optional().describe("What to say to them first: one or two short spoken sentences, under 30 words. Leave out to just listen."),
        resume: z.boolean().optional().describe("Carry on with the interrupted part once this is said."),
        answer: ANSWER,
      }),
      annotations: CHANGES,
    },
    async ({ board_id, say, resume, answer }, ctx) => {
      if (!boards.getBoard(board_id)) return failed(NO_BOARD);
      boards.setClaude(board_id, "listening", 5000, say ? { quiet: 0, waits: 0 } : {});
      if (say) {
        boards.talk(board_id, say);
        makeAudio(board_id, say, "reply");
      }
      if (answer) await releaseBranch(board_id, answer);
      if (resume) boards.setPaused(board_id, false);
      const t0 = Date.now();
      const result = await listen(board_id, ctx.mcpReq.signal);
      log(`reply_and_listen ${board_id}${say ? " +say" : ""}${resume ? " +resume" : ""} → ${result.kind}${result.kind === "heard" ? ` ${result.messages.length}` : ""} in ${Date.now() - t0} ms`);
      return ok(describeHeard(result));
    },
  );

  server.registerTool(
    "say",
    {
      title: "Say it on the whiteboard",
      description: "Say one short thing in Dudeling's voice without waiting for an answer: your verdict on a check answer (with answer, so the prepared part plays straight after), or a goodbye. To hear the learner, use reply_and_listen.",
      inputSchema: z.object({ board_id: boardId, text: spokenReply, answer: ANSWER }),
      annotations: CHANGES,
    },
    async ({ board_id, text, answer }) => {
      const r = boards.talk(board_id, text);
      log(`say ${board_id} ${text.length} chars${answer ? ` + ${answer}` : ""}${"error" in r ? ` failed: ${r.error}` : ""}`);
      if ("error" in r) return failed(r.error);
      makeAudio(board_id, text, "reply");
      if (!answer) return ok("Dudeling is saying it. Keep your chat text to a word or two.");
      const rel = await releaseBranch(board_id, answer);
      const playing = !("error" in rel) && rel.played;
      return ok(
        playing
          ? answer === "right"
            ? `Dudeling says it, then plays the part you prepared for a right answer. Now prepare the one after it (teach_part with when:"after_right", optionally when:"after_wrong"), then reply_and_listen with no "say".`
            : `Dudeling says it, then plays the fix you prepared. Your part for a right answer is still ready: call reply_and_listen with no "say" and judge their next answer.`
          : `Dudeling is saying it. Nothing was prepared for a ${answer} answer: send the next part with teach_part now.`,
      );
    },
  );

  server.registerTool(
    "draw",
    {
      title: "Draw on the whiteboard",
      description: DRAW_DESCRIPTION,
      inputSchema: z.object({
        board_id: boardId,
        actions: z.array(actionSchema).min(1).max(8).describe("What to draw now. Use new ids; refer back to ids drawn earlier on this board."),
        caption: z.string().max(200).optional().describe("A few words shown under the board."),
      }),
      annotations: CHANGES,
    },
    async ({ board_id, actions, caption }) => {
      const r = boards.draw(board_id, actions as Record<string, unknown>[], caption);
      log(`draw ${board_id} ${actions.length}${"error" in r ? ` failed: ${r.error}` : ` → step ${r.seq}`}`);
      if ("error" in r) return failed(r.error);
      boards.setClaude(board_id, "busy");
      return ok(`Drawing (step ${r.seq}).`);
    },
  );

  for (const [name, paused] of [["pause_board", true], ["resume_board", false]] as const)
    server.registerTool(
      name,
      {
        title: paused ? "Pause the whiteboard" : "Resume the whiteboard",
        description: paused
          ? "Pause the narration at once: call this first when the learner writes in the chat while the board is narrating. (When they interrupt on the board, it pauses itself.)"
          : "Carry on with the paused part, from the sentence it was on. (After an interruption on the board, use reply_and_listen with resume:true instead.)",
        inputSchema: z.object({ board_id: boardId }),
        annotations: CHANGES,
      },
      async ({ board_id }) => {
        const r = boards.setPaused(board_id, paused);
        log(`${name} ${board_id}${"error" in r ? " failed" : ""}`);
        if ("error" in r) return failed(r.error);
        boards.setClaude(board_id, "busy");
        return ok(paused ? "Paused. Answer the learner, then call resume_board." : "Carrying on.");
      },
    );

  server.registerTool(
    "clear_board",
    {
      title: "New topic on the whiteboard",
      description: CLEAR_BOARD_DESCRIPTION,
      inputSchema: z.object({ board_id: boardId, title: z.string().min(1).max(120).describe("The new topic.") }),
      annotations: WIPES,
    },
    async ({ board_id, title }) => {
      const r = boards.clearBoard(board_id, title);
      log(`clear_board ${board_id}${"error" in r ? ` failed: ${r.error}` : ""}`);
      if ("error" in r) return failed(r.error);
      boards.setClaude(board_id, "busy", undefined, { quiet: 0, waits: 0 });
      await engine.cancel(board_id); // the old topic's audio isn't needed
      return ok(`The board is clear and titled "${title}". Teach on it with teach_part (board_id "${board_id}").`);
    },
  );

  server.registerTool(
    "look_at_board",
    {
      title: "Look at the whiteboard",
      description: "See a board: what's drawn (ids, labels, positions) and, if the learner drew on it, a picture of the whole board. Use it when they say they drew something or ask \"is this right?\", and before adding to a busy board.",
      inputSchema: z.object({ board_id: boardId }),
      annotations: LOOKS,
    },
    async ({ board_id }, ctx) => {
      const board = boards.getBoard(board_id);
      if (!board) return failed(NO_BOARD);
      const live = boards.hasView(board_id);
      const request = live ? boards.requestCapture(board_id) : undefined;
      if (request) await changed(board_id, () => boards.snapshot(board_id)?.request === request, 2500, ctx.mcpReq.signal);
      const snap = boards.snapshot(board_id);
      const fresh = !!request && snap?.request === request;
      const description = snap?.summary
        ? `${fresh ? "Current canvas" : "Last captured canvas"} (${snap.at})\n${snap.summary}`
        : live ? "The canvas has not reported its current contents." : "Lesson plan (screen visibility unconfirmed)\n" + boards.summary(board_id);
      const note = snap?.note ? `\nThe learner has drawn on the board (${snap.note}).` : "";
      return { content: [
        { type: "text", text: description + note },
        ...(snap?.image ? [{ type: "image" as const, data: snap.image, mimeType: snap.mimeType }] : []),
      ] };
    },
  );

  server.registerTool(
    "dudeling_guide",
    {
      title: "How to teach with Dudeling",
      description: "How to teach with Dudeling: the lesson loop, interruptions, the one-board rule, layouts and an example. Read it once before teaching.",
      annotations: LOOKS,
    },
    async () => ok(GUIDE),
  );

  registerAppTool(
    server,
    "board_updates",
    {
      title: "Board updates",
      description: "What's new on a board, waiting for it if asked (used by the whiteboard itself).",
      inputSchema: z.object({
        board_id: boardId,
        since: z.number().int().min(0),
        view: z.string().max(40).optional(),
        /** This view is the one to play from now on (sent when it appears). */
        take: z.boolean().optional(),
        capture: z.string().max(32).optional(),
        wait_ms: z.number().int().min(0).max(25_000).optional(),
        /** What the board last knew of Claude's state: a change answers at once. */
        claude: z.enum(["listening", "busy", "away"]).optional(),
      }),
      annotations: CHANGES,
      _meta: FROM_BOARD,
    },
    async ({ board_id, since, view, take, wait_ms, claude, capture }, ctx) => {
      if (!boards.getBoard(board_id)) return failed("No such board.", { gone: true });
      if (view && take) boards.takeView(board_id, view);
      const superseded = () => !!view && !boards.isLiveView(board_id, view);
      const news = () => (!!view && boards.captureRequest(board_id) !== capture) || superseded() || (!!claude && boards.claude(board_id).state !== claude) || !!boards.updates(board_id, since)?.events.length;
      // A busy/listening lease can expire while no one is writing any files.
      const held = claude && claude !== "away" ? boards.claude(board_id).until - Date.now() : Infinity;
      await changed(board_id, news, Math.max(0, Math.min(wait_ms ?? 0, held)), ctx.mcpReq.signal);
      const u = boards.updates(board_id, since);
      if (!u) return failed("No such board.", { gone: true });
      if (superseded()) return ok("A newer view of this board is live.", { superseded: true, ...u });
      return ok(`${u.events.length} update(s)`, { ...u, capture: boards.captureRequest(board_id), played: boards.progress(board_id), claude: boards.claude(board_id).state });
    },
  );

  registerAppTool(
    server,
    "board_progress",
    {
      title: "Board progress",
      description: "How far the board has played (used by the whiteboard itself).",
      inputSchema: z.object({ board_id: boardId, seq: z.number().int().min(0), step: z.number().int().min(0).max(20), narrating: z.boolean(), ...viewScope }),
      annotations: CHANGES,
      _meta: FROM_BOARD,
    },
    async ({ board_id, seq, step, narrating, view, topic }) => {
      return boards.setProgress(board_id, seq, step, narrating, topic, view) ? ok("Saved.") : failed("No such board.");
    },
  );

  registerAppTool(
    server,
    "learner_said",
    {
      title: "Learner said",
      description: "What the learner said or typed on the board, for Claude (used by the whiteboard itself).",
      inputSchema: z.object({
        board_id: boardId,
        text: z.string().trim().min(1).max(2000),
        how: z.enum(["spoken", "typed"]),
        ...viewScope,
        interrupted: z.boolean().optional(),
        check: z.string().max(400).optional(),
        during: z.string().max(700).optional(),
      }),
      annotations: CHANGES,
      _meta: FROM_BOARD,
    },
    async ({ board_id, topic, view, ...message }) => {
      const r = inbox.put(board_id, message, topic, view);
      log(`learner_said ${board_id} ${message.how} ${message.text.length} chars${"error" in r ? ` failed: ${r.error}` : ""}`);
      if ("error" in r) return failed(r.error);
      void engine.hold();
      return ok("Passed on.", { id: r.id, claude: boards.claude(board_id).state });
    },
  );

  registerAppTool(
    server,
    "learner_unsend",
    {
      title: "Take back a message",
      description: "Take back a message Claude hasn't received, to send it through the chat (used by the whiteboard itself).",
      inputSchema: z.object({ board_id: boardId, id: z.string().max(60), ...viewScope }),
      annotations: CHANGES,
      _meta: FROM_BOARD,
    },
    async ({ board_id, id, topic, view }) => {
      const withdrawn = boards.accepts(board_id, topic, view) && inbox.withdraw(board_id, id, topic);
      return ok(withdrawn ? "Taken back." : "Claude has it.", { withdrawn });
    },
  );

  registerAppTool(
    server,
    "transcribe",
    {
      title: "Transcribe",
      description: "Text of what the learner said into the board's microphone (used by the whiteboard itself).",
      inputSchema: z.object({ wav: z.string().max(4_000_000).describe("16 kHz 16-bit mono WAV, base64") }),
      annotations: LOOKS,
      _meta: FROM_BOARD,
    },
    async ({ wav }) => {
      try {
        const t0 = performance.now();
        const text = await engine.transcribe(wav);
        log(`transcribe ${Math.round((wav.length * 0.75) / 32000)} s → ${text.length} chars in ${Math.round(performance.now() - t0)} ms`);
        return ok(text || "(nothing)", { text });
      } catch (e) {
        log(`transcribe failed: ${String(e).slice(0, 200)}`);
        return failed("Couldn't understand the audio.", { text: "" });
      }
    },
  );

  registerAppTool(server, "board_ink", {
    title: "Editable board drawing", description: "Save or restore one piece of the learner's drawing.",
    inputSchema: z.object({ board_id: boardId, topic: z.number().int().nonnegative(), view: z.string().max(40),
      part: z.number().int().min(0).max(4095), total: z.number().int().min(1).max(4096).optional(),
      revision: z.number().int().positive().optional(), data: z.string().max(CHUNK).optional() }),
    annotations: CHANGES, _meta: FROM_BOARD,
  }, async req => {
    const result = ink(req);
    return result ? ok("ok", result) : failed("Drawing or view changed.");
  });

  registerAppTool(
    server,
    "learner_drew",
    {
      title: "Learner drew",
      description: "The learner drew on a live board: a picture of the whole board (used by the whiteboard itself).",
      inputSchema: z.object({
        board_id: boardId,
        image: z.string().max(boards.MAX_SNAPSHOT_CHARS),
        mime_type: z.enum(["image/png", "image/jpeg"]),
        note: z.string().max(300),
        ...viewScope,
        summary: z.string().max(16000).optional(),
        request: z.string().max(32).optional(),
      }),
      annotations: CHANGES,
      _meta: FROM_BOARD,
    },
    async ({ board_id, image, mime_type, note, ...scope }) => {
      const saved = boards.setSnapshot(board_id, image, note, mime_type, scope);
      log(`learner_drew ${board_id} ${saved ? `${Math.round(image.length / 1024)} KB` : "failed"}`);
      return saved ? ok("Saved.") : failed("Couldn't save the drawing.");
    },
  );

  registerAppTool(
    server,
    "speak",
    {
      title: "Speak",
      description: "Audio (WAV) for one piece of a line, in Dudeling's voice (used by the whiteboard itself).",
      inputSchema: z.object({
        text: z.string().max(400),
        probe: z.boolean().optional().describe("Just say whether the voice is available."),
        bump: z.boolean().optional().describe("Just make a piece that's already asked for more urgent."),
        priority: z.enum(voice.PRIORITIES).optional(),
        board_id: boardId.optional(),
      }),
      annotations: LOOKS,
      _meta: FROM_BOARD,
    },
    async ({ text, probe, bump, priority, board_id }, ctx) => {
      const status = voice.voiceStatus();
      if (probe) {
        if (status === "ready") void engine.prepare("voice");
        return ok(status, { available: status === "ready", status });
      }
      if (!text.trim()) return failed("Nothing to say.");
      if (status !== "ready") return failed("Dudeling's voice isn't available here.", { unavailable: status });
      const opts = { priority: priority ?? "current", group: board_id };
      if (bump) {
        void engine.prefetch(text, opts).catch(() => {});
        return ok("Moved up.");
      }
      const making = engine.speak(text, opts);
      try {
        const t0 = performance.now();
        let timer!: NodeJS.Timeout;
        const notYet = new Promise<null>((done) => (timer = setTimeout(done, SPEAK_WAIT_MS, null)));
        const s = await Promise.race([making, notYet]).finally(() => clearTimeout(timer));
        if (!s) {
          making.catch(() => {}); // still being made: the board asks again
          return ok("Not yet.", { pending: true });
        }
        if (ctx.mcpReq.signal.aborted) return failed("Cancelled.");
        if (process.env.DUDELING_DEBUG) log(`speak ${priority ?? "current"} ${text.length} chars → ${s.durationMs} ms audio in ${Math.round(performance.now() - t0)} ms`);
        return ok(`${s.durationMs} ms of audio`, { wav: s.wav, durationMs: s.durationMs });
      } catch (e) {
        if (e instanceof voice.SpeechCancelled) return failed("Cancelled.", { cancelled: true });
        log(`speak failed: ${String(e).slice(0, 200)}`);
        return failed("Couldn't make the audio.", { unavailable: "failed" });
      }
    },
  );

  registerAppTool(
    server,
    "learner_active",
    {
      title: "Learner is talking",
      description: "The learner pressed Talk or started talking (used by the whiteboard itself).",
      inputSchema: z.object({ board_id: boardId, ...viewScope, what: z.enum(["talk_on", "cut_in"]) }),
      annotations: CHANGES,
      _meta: FROM_BOARD,
    },
    async ({ board_id, what, view, topic }) => {
      if (!boards.accepts(board_id, topic, view)) return failed("Board or topic changed.");
      boards.touchBoard(board_id);
      if (what === "talk_on") void engine.prepare("hearing");
      else await engine.interrupt(board_id);
      return ok("ok");
    },
  );

  // The board's problems, in batches, in this plugin's log (chat apps may hide a board's own logs).
  registerAppTool(
    server,
    "board_log",
    {
      title: "Board log",
      description: "Problems on the whiteboard (used by the whiteboard itself).",
      inputSchema: z.object({ entries: z.array(z.object({ level: z.enum(["error", "warning", "info"]), message: z.string().max(400) })).min(1).max(30) }),
      annotations: CHANGES,
      _meta: FROM_BOARD,
    },
    async ({ entries }) => {
      // The player's timeline ("info") holds no words: kept in the log file, so a real run can be read afterwards.
      for (const { level, message } of entries) log(`board ${level}: ${message.replace(/\s+/g, " ")}`);
      return ok("ok");
    },
  );

  let html: string | undefined;
  const boardPage = (uri: string) => async () => ({
    contents: [
      {
        uri,
        mimeType: RESOURCE_MIME_TYPE,
        text: (html ??= typeof boardHtml === "string" ? boardHtml : boardHtml()),
        // No network at all: the fonts are in the page and the voice comes from this plugin.
        // The microphone: the learner talks to Dudeling on the board (asked for when they press Talk).
        _meta: { ui: { csp: { resourceDomains: [], connectDomains: [] }, permissions: { microphone: {} }, prefersBorder: true } },
      },
    ],
  });
  registerAppResource(server, "Dudeling whiteboard", BOARD_URI, { description: "A whiteboard that draws a lesson in time with its narration." }, boardPage(BOARD_URI));
  for (const uri of [LEGACY_BOARD_URI, "ui://dudeling/board-1.0.0-rc.5.html", "ui://dudeling/board-1.0.0-rc.6.html"])
    registerAppResource(server, `Dudeling whiteboard (${uri})`, uri, { description: "Whiteboard for an existing chat." }, boardPage(uri));

  server.registerPrompt(
    "teach-me",
    {
      title: "Teach me with Dudeling",
      description: "Learn a topic on Dudeling's whiteboard.",
      argsSchema: z.object({ topic: z.string().max(300).describe("What you want to learn") }),
    },
    ({ topic }) => ({
      messages: [{ role: "user", content: { type: "text", text: `Tutor me on ${topic} with Dudeling: read dudeling_guide first, open one board, then teach one part at a time with teach_part, calling reply_and_listen after each to hear me on the board.` } }],
    }),
  );

  return server;
}
