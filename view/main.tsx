/**
 * Dudeling's whiteboard as an MCP App View, rendered by the chat host in an iframe when the assistant
 * calls `open_board`. It waits on the plugin for what the assistant sends (parts, replies, sketches,
 * pause/resume, clear) and plays it: Dudeling's cursor draws while its voice narrates.
 *
 * The learner talks (the board's microphone, transcribed by the plugin) or types here. Their words go to
 * the plugin's inbox, where Claude's `reply_and_listen` picks them up. If Claude isn't listening any
 * more, they go to the chat's message box instead, for Enter to send.
 *
 * Opened directly in a browser (not inside a chat), it plays a demo lesson: `npm run dev:view`.
 */
import { CaptureUpdateAction, Excalidraw, THEME } from "@excalidraw/excalidraw";
import type { AppState, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import "@excalidraw/excalidraw/index.css";
import { App, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { BoardAgent } from "@board/agent/BoardAgent";
import { TutorPresence } from "@board/agent/TutorPresence";
import { Toolbar } from "@board/whiteboard/Toolbar";
import { ALL_TOOLS, HIGHLIGHTER, PEN, PEN_COLORS, type ToolId } from "@board/whiteboard/tools";
import "@board/whiteboard/whiteboard.css";
import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { VERSION } from "../server/version";
import { DEMO } from "./demo";
import { useBoardDrawing } from "./useBoardDrawing";
import { PlayOrder } from "../server/prepared";
import { partSteps, Sections, sketchSteps, type BoardEvent, type Played } from "./events";
import { Listener } from "./listen";
import { createReporter } from "./log";
import { Player, completeSteps, type PlayerState, type PlayStep } from "./player";
import { Voice, type Urgency, type VoiceKind } from "./voice";
import "./view.css";

const embedded = window.parent !== window;
const app = new App({ name: "Dudeling", version: VERSION }, { availableDisplayModes: ["inline", "fullscreen"] }, { autoResize: true });
const report = createReporter(app, embedded);
window.addEventListener("error", (e) => report("error", `${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener("unhandledrejection", (e) => report("error", `unhandled: ${String(e.reason)}`));

/** This view of the board (the newest one plays). */
const VIEW = Array.from(crypto.getRandomValues(new Uint8Array(9)), (n) => n.toString(16).padStart(2, "0")).join("");
/** How long the plugin holds an update request when nothing is happening (3 calls a minute). */
const WAIT_MS = 20_000;
const RETRY_MAX_MS = 10_000;
/** Boards not there (yet): tries before giving up (the plugin may be restarting). */
const MISSING_MAX = 12;
/** On a board shown again, replies older than this aren't said again. */
const STALE_REPLY_MS = 15_000;
/** After the learner stops drawing for this long, Claude gets a picture of the board. */

// Said only when Claude's answer is late, never twice in a row, and at most once in a while: a filler on every
// question is what makes a voice agent annoying (and a quick answer needs none).
const FILLERS = ["Hmm, let me think.", "One moment.", "Okay, let me see.", "Right, let me check."];
const FILLER_AFTER_MS = 1600;
const FILLER_GAP_MS = 45_000;

type Theme = "light" | "dark";
type ClaudeState = "listening" | "busy" | "away";
type Talk = "off" | "starting" | "listening" | "hearing" | "transcribing" | "denied";
type Question = { turn: number; cut: { during: string } | null; check?: string };
type Insets = NonNullable<McpUiHostContext["safeAreaInsets"]>;
const IDLE: PlayerState = { narrating: false, paused: false, waiting: false, preparing: false };

async function callTool<T>(name: string, args: Record<string, unknown>, timeout?: number): Promise<{ data?: T; failed: boolean }> {
  const r = await app.callServerTool({ name, arguments: args }, timeout ? { timeout } : undefined);
  return { data: r.structuredContent as T | undefined, failed: !!r.isError };
}

function Board() {
  const [theme, setTheme] = useState<Theme>(() => (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  const [insets, setInsets] = useState<Insets | null>(null);
  const [title, setTitle] = useState("");
  const [caption, setCaption] = useState("");
  const [started, setStarted] = useState(false);
  const [fullscreen, setFullscreen] = useState<boolean | null>(null);
  const [agent, setAgent] = useState<BoardAgent | null>(null);
  const [activeTool, setActiveTool] = useState<ToolId>("pen");
  const [penColor, setPenColor] = useState(PEN_COLORS[0].value);
  const [sentDrawing, setSentDrawing] = useState(false);
  /** Something is waiting to be said and sound is still locked. */
  const [needsPlay, setNeedsPlay] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [muted, setMuted] = useState(false);
  const [voiceKind, setVoiceKind] = useState<VoiceKind | null>(null);
  const [playing, setPlaying] = useState<PlayerState>(IDLE);
  const [replying, setReplying] = useState(false);
  const [talk, setTalk] = useState<Talk>("off");
  const [claude, setClaude] = useState<ClaudeState>("busy");
  /** The learner's words are on their way, or Claude is answering them. */
  const [thinking, setThinking] = useState(false);
  const [inChat, setInChat] = useState(false);
  const [elsewhere, setElsewhere] = useState(false);
  const [expired, setExpired] = useState(false);
  const [unsupported, setUnsupported] = useState("");
  const [draft, setDraft] = useState("");

  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const agentRef = useRef<BoardAgent | null>(null);
  const playerRef = useRef<Player | null>(null);
  const pending = useRef<{ title: string; steps: PlayStep[]; live: boolean } | null>(null);
  const boardIdRef = useRef<string | null>(null);
  const titleRef = useRef("");
  titleRef.current = title;
  const claudeRef = useRef<ClaudeState>("busy");
  const canFullscreen = useRef(false);
  /** Bumped when following stops or restarts: older loops end. */
  const following = useRef(0);
  /** Bumped by clear: replies meant for the old topic are dropped. */
  const topic = useRef(0);
  /** Claude's replies play one after another, never over the lesson's narration. */
  const serverTopic = useRef(0);
  const scope = () => ({ topic: serverTopic.current, view: VIEW });
  const stamp = () => [boardIdRef.current, following.current, topic.current].join("/");
  const drawing = useBoardDrawing(apiRef, callTool, (board_id, erased) => {
    const message = erased ? "The learner erased their marks." : "The learner edited their drawing.";
    void app.updateModelContext({ content: [{ type: "text", text: `${message} Call look_at_board on ${board_id} to see the current canvas.` }] }).catch(() => {});
    setSentDrawing(true);
    setTimeout(() => setSentDrawing(false), 2500);
  }, msg => report("warning", msg));
  const asides = useRef<Promise<void>>(Promise.resolve());
  const currentReply = useRef<string | null>(null);
  /** Replies waiting or being said: the lesson's next line waits for them. */
  const repliesDue = useRef(0);
  const cutReply = useRef<string | null>(null);
  /** The learner interrupted: what they cut in on, until their words are handled. */
  const interruption = useRef<{ during: string } | null>(null);
  const pausedByLearner = useRef(false);
  /** The learner is mid-sentence: nothing of Dudeling's starts. */
  const learnerTalking = useRef(false);
  const recognitionFailed = useRef(false);
  /** Bumped when the learner cuts in: replies and resumes queued before it don't happen. */
  const turn = useRef(0);
  /** A resume is queued (if the cut-in turns out to be noise, it still happens). */
  const resumeDue = useRef(false);
  /** A reply is being made or said. */
  const replyingNow = useRef(false);
  /** Messages Claude hadn't said it was listening for: sent to the chat if it goes away. */
  const unclaimed = useRef<{ id: string; text: string; how: "spoken" | "typed" }[]>([]);
  const utterances = useRef<Promise<void>>(Promise.resolve());
  const progress = useRef({ seq: 0, step: 0, narrating: false });
  const unlockedAt = useRef(0);

  const voiceRef = useRef<Voice>(null as unknown as Voice);
  const unlockWaiters = useRef<(() => void)[]>([]);
  const filler = useRef<{ timer: ReturnType<typeof setTimeout> | null; next: number; lastAt: number }>({ timer: null, next: 0, lastAt: -Infinity });
  /** Claude's answer (or the next part) is here, or the learner spoke again: no filler for this turn. */
  const cancelFiller = useCallback(() => {
    if (filler.current.timer) clearTimeout(filler.current.timer);
    filler.current.timer = null;
  }, []);
  voiceRef.current ??= new Voice(
    async (text: string, urgency: Urgency, bump?: boolean) => {
      if (!embedded) return null; // preview outside a chat: no plugin to ask
      const { data, failed } = await callTool<{ wav?: string; durationMs?: number; pending?: boolean }>("speak", { text, priority: urgency, bump, board_id: boardIdRef.current ?? undefined }, 50_000);
      if (failed) return null;
      if (data?.wav) return { wav: data.wav, durationMs: data.durationMs ?? 0 };
      return data?.pending || bump ? { pending: true as const } : null;
    },
    async () => {
      if (!embedded) return false;
      const { data, failed } = await callTool<{ available?: boolean }>("speak", { text: "", probe: true });
      return !failed && !!data?.available;
    },
    (msg) => report("warning", `voice: ${msg}`),
  );

  const unlock = useCallback(() => {
    const v = voiceRef.current;
    const first = !v.unlocked;
    v.unlock();
    if (!first) return;
    unlockedAt.current = performance.now();
    setUnlocked(true);
    setNeedsPlay(false);
    for (const go of unlockWaiters.current.splice(0)) go();
    playerRef.current?.start();
  }, []);

  useEffect(() => {
    const v = voiceRef.current;
    v.onKind = (kind) => {
      setVoiceKind(kind);
      if (embedded) v.prepare(FILLERS[0]); // ready for the first late answer (one at a time: each costs CPU)
    };
    const onClick = () => unlock();
    const onKey = (e: KeyboardEvent) => {
      if (!["Escape", "Shift", "Control", "Alt", "Meta", "Tab"].includes(e.key)) unlock();
    };
    document.addEventListener("click", onClick, true);
    document.addEventListener("pointerup", onClick, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("pointerup", onClick, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [unlock]);

  // whiteboard.css keys the board's dark tokens off <html data-board>.
  useEffect(() => void (document.documentElement.dataset.board = theme), [theme]);

  const saveProgress = useCallback((change: Partial<{ seq: number; step: number; narrating: boolean }>) => {
    const was = progress.current;
    const now = { ...was, ...change };
    if (now.seq === was.seq && now.step === was.step && now.narrating === was.narrating) return;
    progress.current = now;
    const board_id = boardIdRef.current;
    if (embedded && board_id) void callTool("board_progress", { board_id, ...scope(), ...now }).catch(() => {});
  }, []);

  const play = useCallback(
    (t: string, steps: PlayStep[], live: boolean) => {
      pending.current = { title: t, steps, live };
      const a = agentRef.current;
      if (!a) return; // played once the board is ready
      if (!playerRef.current) {
        const p = new Player(a, {
          caption: (text) => setCaption(text),
          done: () => undefined,
          needsSound: () => {
            if (!voiceRef.current.unlocked) setNeedsPlay(true); // (else it's only waiting for a reply to finish)
          },
          state: (s) => {
            setPlaying(s);
            saveProgress({ narrating: s.narrating || replyingNow.current });
            if (s.waiting) setCaption((c) => c || p.waitingForAnswer || "");
          },
          stepDone: (step) => {
            if (step.mark) saveProgress(step.mark);
          },
        });
        p.live = live;
        if (embedded) {
          p.voice = { say: (text) => voiceRef.current.say(text), prepare: (text) => voiceRef.current.prepare(text), stop: () => voiceRef.current.stop() };
          p.canSpeak = () => voiceRef.current.unlocked && !repliesDue.current;
        }
        p.trace = (m) => report("info", `player: ${m}`);
        playerRef.current = p;
      }
      setStarted(true);
      playerRef.current.update(t, steps, !live);
    },
    [saveProgress],
  );

  /**
   * Wipe the board for a new topic (clear_board): stop what's being drawn, let its animation settle, then
   * clear through the same board engine (its own "clear" also forgets what it had placed), so nothing old
   * can land on the fresh board.
   */
  const resetBoard = useCallback(async (t: string) => {
    topic.current++;
    drawing.reset();
    unclaimed.current = [];
    interruption.current = null;
    cutReply.current = currentReply.current = null;
    learnerTalking.current = recognitionFailed.current = false;
    if (listenerRef.current?.on) setTalk("listening");
    turn.current++;
    cancelFiller();
    setInChat(false);
    setThinking(false);
    setDraft("");
    playerRef.current?.stop();
    playerRef.current = null;
    voiceRef.current.stop();
    asides.current = Promise.resolve();
    repliesDue.current = 0;
    replyingNow.current = false;
    resumeDue.current = false;
    pending.current = null;
    pausedByLearner.current = false;
    setPlaying(IDLE);
    setReplying(false);
    setNeedsPlay(false);
    setTitle(t);
    setCaption("");
    setStarted(false);
    const a = agentRef.current;
    if (!a) return;
    a.interrupt();
    await new Promise((r) => setTimeout(r, 120)); // in-flight animation frames finish
    await a.run([{ type: "clear" }]);
    a.follow();
  }, []);

  /** Claude says something, in Dudeling's voice: after the line being said, before the next one. */
  const speakAside = useCallback((text: string) => {
    cancelFiller();
    const of = topic.current;
    const asked = turn.current;
    repliesDue.current++;
    asides.current = asides.current
      .then(async () => {
        while (of === topic.current && (playerRef.current?.isNarrating || learnerTalking.current)) await new Promise((r) => setTimeout(r, 100));
        if (of !== topic.current) return;
        if (asked !== turn.current) {
          cutReply.current ??= text; // overtaken by the learner; said after all if that was just noise
          return;
        }
        setThinking(false);
        setCaption(text);
        setStarted(true);
        const v = voiceRef.current;
        if (!v.unlocked) {
          setNeedsPlay(true);
          await new Promise<void>((r) => unlockWaiters.current.push(r));
          if (of !== topic.current) return;
        }
        currentReply.current = text;
        replyingNow.current = true;
        saveProgress({ narrating: true }); // Dudeling talking isn't the learner being silent
        setReplying(true);
        const s = await v.say(text, "reply");
        await s.done;
      })
      // One reply failing must not silence the ones after it (or the resume queued behind them).
      .catch((e) => report("warning", `reply failed: ${String(e).slice(0, 160)}`))
      .finally(() => {
        if (of !== topic.current) return;
        currentReply.current = null;
        setReplying(false);
        if (replyingNow.current) {
          replyingNow.current = false;
          saveProgress({ narrating: !!playerRef.current?.isNarrating });
        }
        repliesDue.current--;
        if (!repliesDue.current) playerRef.current?.start();
      });
  }, [saveProgress, cancelFiller]);

  /** After what's being said, not over it: replies and resume often arrive together. */
  const resumeAfterReplies = useCallback(() => {
    const of = topic.current;
    const asked = turn.current;
    resumeDue.current = true;
    asides.current = asides.current
      .then(async () => {
        while (of === topic.current && learnerTalking.current) await new Promise((r) => setTimeout(r, 100));
        // Cutting a reply off must not start the lesson talking over the learner.
        if (of !== topic.current || asked !== turn.current || recognitionFailed.current) return;
        resumeDue.current = false;
        pausedByLearner.current = false;
        setThinking(false);
        playerRef.current?.resume();
      })
      .catch(() => {});
  }, []);

  const sendToChat = useCallback(async (text: string): Promise<boolean> => {
    try {
      const r = await app.sendMessage({ role: "user", content: [{ type: "text", text }] });
      if (!r?.isError) return true;
      report("warning", "the chat app refused the message");
    } catch (e) {
      report("warning", `sendMessage failed: ${String(e).slice(0, 160)}`);
    }
    return false;
  }, []);

  /** Claude isn't listening: move what it hasn't taken to the chat's message box. Once, never again. */
  const fallBackToChat = useCallback(async () => {
    const board_id = boardIdRef.current;
    const origin = stamp();
    const source = scope();
    const waiting = unclaimed.current.splice(0);
    if (!board_id || !waiting.length) return;
    const taken: typeof waiting = [];
    for (const m of waiting) {
      try {
        if ((await callTool<{ withdrawn?: boolean }>("learner_unsend", { board_id, ...source, id: m.id })).data?.withdrawn) taken.push(m);
      } catch (e) {
        report("warning", `couldn't take a message back: ${String(e).slice(0, 120)}`);
      }
    }
    if (!taken.length || origin !== stamp()) return;
    setThinking(false);
    const words = taken.map((m) => m.text).join(" ");
    const how = taken.some((m) => m.how === "spoken") ? "spoken" : "typed";
    if (await sendToChat(`(${how} on the Dudeling board) ${words}`)) {
      if (origin !== stamp()) return;
      setInChat(true);
      setCaption("That's in the chat's message box: press Enter there to send it.");
    } else {
      // Keep the words for when Claude listens again.
      for (const m of taken) await callTool("learner_said", { board_id, ...source, text: m.text, how: m.how }).catch(() => {});
      if (origin !== stamp()) return;
      setCaption("Claude has stopped listening. Type “continue” in the chat.");
    }
  }, [sendToChat]);

  const sawClaude = useCallback(
    (state: ClaudeState) => {
      claudeRef.current = state;
      setClaude(state);
      if (state === "listening") {
        unclaimed.current = []; // it takes them straight away
        setInChat(false);
      } else if (state === "away") {
        setThinking(false);
        void fallBackToChat();
      }
    },
    [fallBackToChat],
  );

  const cutIn = useCallback(() => {
    const p = playerRef.current;
    if (p?.isNarrating) {
      interruption.current = { during: p.line };
      p.pause();
      pausedByLearner.current = true;
    }
    cutReply.current = currentReply.current;
    turn.current++;
    cancelFiller();
    voiceRef.current.stop();
    const board_id = boardIdRef.current;
    if (board_id) void callTool("learner_active", { board_id, ...scope(), what: "cut_in" }).catch(() => {});
  }, []);

  const questionContext = (): Question => {
    const cut = interruption.current ?? (pausedByLearner.current ? { during: "" } : null);
    return { turn: turn.current, cut, check: cut ? undefined : playerRef.current?.waitingForAnswer ?? undefined };
  };

  const submit = useCallback(
    async (text: string, how: "spoken" | "typed", recording?: Question): Promise<boolean> => {
      const board_id = boardIdRef.current;
      if (!board_id) return false;
      const origin = stamp();
      if (how === "typed") {
        learnerTalking.current = false;
        cutIn();
      }
      const { turn: asked, cut, check } = recording ?? questionContext();
      if (asked === turn.current) {
        recognitionFailed.current = false;
        interruption.current = null;
        resumeDue.current = false;
        cutReply.current = null;
        setCaption(`You: ${text}`);
        setThinking(true);
        setInChat(false);
      }
      try {
        const { data, failed } = await callTool<{ id?: string; claude?: ClaudeState }>("learner_said", {
          board_id,
          ...scope(),
          text: text.slice(0, 2000),
          how,
          ...(cut ? { interrupted: true, ...(cut.during ? { during: cut.during } : {}) } : {}),
          ...(check ? { check } : {}),
        });
        if (origin !== stamp()) return false;
        if (failed || !data?.id) throw new Error("not saved");
        const state = data.claude ?? claudeRef.current;
        if (state !== "listening") unclaimed.current.push({ id: data.id, text, how });
        if (asked !== turn.current) return true;
        sawClaude(state);
        // Only if Claude is slow to answer: something short, while it thinks (and only if its audio is here).
        cancelFiller();
        filler.current.timer = setTimeout(() => {
          filler.current.timer = null;
          const f = filler.current;
          const v = voiceRef.current;
          const line = FILLERS[f.next % FILLERS.length];
          if (asked !== turn.current || claudeRef.current === "away" || performance.now() - f.lastAt < FILLER_GAP_MS) return;
          if (playerRef.current?.isNarrating || learnerTalking.current || replyingNow.current || repliesDue.current) return;
          if (!v.has(line)) return void v.prepare(line);
          f.next++;
          v.prepare(FILLERS[f.next % FILLERS.length]); // the next one, for next time
          f.lastAt = performance.now();
          asides.current = asides.current.then(async () => (await v.say(line, "reply")).done).catch(() => {});
        }, FILLER_AFTER_MS);
        return true;
      } catch (e) {
        if (origin !== stamp() || asked !== turn.current) return false;
        report("warning", `learner_said failed: ${String(e).slice(0, 160)}`);
        setThinking(false);
        setCaption("That didn't reach Dudeling. Try again, or type it in the chat.");
        return false;
      }
    },
    [cutIn, sawClaude],
  );

  /** Follow a board: wait for what's new and play it. The newest view of a board is the one that plays. */
  const follow = useCallback(
    (boardId: string, boardTitle: string) => {
      const run = ++following.current;
      boardIdRef.current = boardId;
      let since = 0;
      let steps: PlayStep[] = [];
      let title_ = boardTitle;
      let missing = 0;
      let failures = 0;
      let first = true;
      let lastCapture: string | undefined;
      let restoredTopic = -1;
      let known: ClaudeState | undefined;
      let sections = new Sections();
      // Parts Claude prepared ahead wait here until its verdict on the learner's answer releases one.
      const order = new PlayOrder<BoardEvent>();

      const apply = async (raw: BoardEvent[], played: Played, now: number) => {
        const initial = first;
        first = false;
        let changed = false;
        for (const e of raw) since = Math.max(since, e.seq);
        const events = order.feed(raw);
        const lastTurn = events.filter((e) => e.part || e.talk || e.resume || e.clear).at(-1);
        for (const e of events) {
          if (e.clear) {
            title_ = e.clear.title;
            steps = [];
            sections = new Sections();
            changed = false;
            // Wait for the wipe to finish before anything new is drawn, or old and new drawing overlap.
            if (initial) setTitle(title_);
            else await resetBoard(title_);
          } else if (e.part) {
            const heard = initial ? played : { seq: 0, step: 0 };
            const lines = partSteps(e, heard, e === lastTurn);
            steps.push(...sections.before(e, title_, !!lines[0]?.fast), ...lines);
            cancelFiller();
            setThinking(false);
            // The next part arrived while the board waited for an answer (it was judged already): carry on.
            if (!initial && (playerRef.current?.waitingForAnswer || pausedByLearner.current)) resumeAfterReplies();
            changed = true;
          } else if (e.talk) {
            if (!initial || (e.at && now - e.at < STALE_REPLY_MS)) speakAside(e.talk);
          } else if (e.pause || e.resume) {
            if (initial) continue; // a board shown again starts unpaused
            if (e.pause) playerRef.current?.pause();
            else resumeAfterReplies();
          } else {
            steps.push(...sections.before(e, title_, initial), ...sketchSteps(e, initial));
            if (e.caption) setCaption(e.caption);
            changed = true;
          }
        }
        if (changed) play(title_, [...steps], true);
      };

      const tick = async () => {
        while (run === following.current) {
          try {
            const { data: u } = await callTool<{
              gone?: boolean;
              superseded?: boolean;
              topic?: number;
              capture?: string;
              title?: string;
              events?: BoardEvent[];
              now?: number;
              played?: Played;
              claude?: ClaudeState;
            }>("board_updates", { board_id: boardId, since, view: VIEW, capture: lastCapture, ...(first ? { take: true } : { wait_ms: WAIT_MS, claude: known }) }, WAIT_MS + 15_000);
            if (run !== following.current) return;
            if (u?.gone) {
              if (++missing > MISSING_MAX) {
                setExpired(true);
                setCaption("This board has expired. Ask Claude to open a new one.");
                return;
              }
              await new Promise((r) => setTimeout(r, 700));
              continue;
            }
            if (!u?.events) throw new Error("no updates in the answer");
            missing = 0;
            failures = 0;
            if (u.superseded) {
              // A newer view plays from here on: this one is still a picture, nothing more.
              following.current++;
              topic.current++;
              drawing.reset();
              cancelFiller();
              playerRef.current?.stop();
              voiceRef.current.stop();
              stopTalkRef.current();
              setElsewhere(true);
              return;
            }
            if (first && u.title) setTitle((title_ = u.title));
            if (first && u.played) progress.current = { seq: u.played.seq, step: u.played.step, narrating: false };
            serverTopic.current = u.topic ?? 0;
            await apply(u.events, u.played ?? { seq: 0, step: 0 }, u.now ?? Date.now());
            if (run !== following.current) return;
            if (restoredTopic !== serverTopic.current) {
              await drawing.restore({ board_id: boardId, view: VIEW, topic: serverTopic.current });
              restoredTopic = serverTopic.current;
            }
            if (u.capture && u.capture !== lastCapture) {
              await drawing.capture(u.capture);
              lastCapture = u.capture;
            }
            if (u.claude) {
              known = u.claude;
              sawClaude(u.claude);
            }
          } catch (e) {
            if (run !== following.current) return;
            if (++failures === 2) report("warning", `board_updates failing: ${String(e).slice(0, 160)}`);
            await new Promise((r) => setTimeout(r, Math.min(RETRY_MAX_MS, 500 * 2 ** failures)));
          }
        }
      };
      void tick();
    },
    [play, resetBoard, resumeAfterReplies, sawClaude, speakAside],
  );

  const listenerRef = useRef<Listener | null>(null);
  const stopTalk = useCallback(() => {
    const listener = listenerRef.current;
    listenerRef.current = null;
    voiceRef.current.onTalking = () => {};
    listener?.stop();
    learnerTalking.current = false;
    setTalk("off");
  }, []);
  const stopTalkRef = useRef(stopTalk);

  const toggleTalk = async () => {
    if (listenerRef.current) return stopTalk(); // also while it's still starting
    setTalk("starting");
    const current = () => listenerRef.current === listener;
    let recording = "";
    let question: Question;
    const listener: Listener = new Listener({
      speechStart: () => {
        if (!current()) return;
        recording = stamp();
        setTalk("hearing");
        learnerTalking.current = true;
        cutIn();
        question = questionContext();
      },
      utterance: (wav) => {
        if (!current()) return;
        const origin = recording;
        const captured = question;
        const asked = captured.turn;
        const valid = () => current() && origin === stamp();
        if (!valid()) { setTalk("listening"); return; }
        setTalk("transcribing");
        utterances.current = utterances.current
          .then(async () => {
            if (!valid()) return;
            let text = "";
            try {
              const result = await callTool<{ text?: string }>("transcribe", { wav }, 90_000);
              if (result.failed || typeof result.data?.text !== "string") throw new Error("Transcription unavailable");
              text = result.data.text.trim();
            } catch (e) {
              if (!valid()) return;
              if (asked === turn.current) {
                recognitionFailed.current = true;
                learnerTalking.current = false;
                setTalk("listening");
                setCaption("I couldn’t hear your question clearly. Please ask again or type it here.");
              }
              report("warning", `transcribe failed: ${String(e).slice(0, 160)}`);
              return;
            }
            if (!valid()) return;
            if (asked === turn.current) {
              learnerTalking.current = false;
              setTalk("listening");
            }
            if (text) return void (await submit(text, "spoken", captured));
            if (asked !== turn.current) return;
            // Just noise: carry on where we were.
            const resume = !!interruption.current || resumeDue.current;
            interruption.current = null;
            if (cutReply.current) speakAside(cutReply.current);
            cutReply.current = null;
            if (resume) resumeAfterReplies();
          })
          .catch((e) => report("warning", `hearing failed: ${String(e).slice(0, 160)}`));
      },
      ended: () => {
        if (!current()) return;
        stopTalk();
        setCaption("The microphone stopped. Press Talk again, or type here.");
      },
    });
    listenerRef.current = listener;
    if (boardIdRef.current) void callTool("learner_active", { board_id: boardIdRef.current, ...scope(), what: "talk_on" }).catch(() => {});
    try {
      if (!(await listener.start()) || !current()) return;
      listener.dudelingTalking = voiceRef.current.audible;
      voiceRef.current.onTalking = (on) => (listener.dudelingTalking = on);
      setTalk("listening");
    } catch (e) {
      if (!current()) return;
      listenerRef.current = null;
      report("warning", `microphone refused: ${String(e).slice(0, 160)}`);
      setTalk("denied");
      setCaption("Dudeling can't use the microphone here. Type to Dudeling below instead.");
    }
  };

  // Whatever happens to the board, the microphone is let go.
  useEffect(() => {
    const saveInk = () => { void drawing.flush(); };
    const release = () => { stopTalkRef.current(); saveInk(); };
    window.addEventListener("pointerup", saveInk);
    window.addEventListener("pagehide", release);
    return () => {
      window.removeEventListener("pagehide", release);
      window.removeEventListener("pointerup", saveInk);
    };
  }, []);

  const applyTool = useCallback((tool: ToolId, color: string) => {
    const api = apiRef.current;
    if (!api) return;
    const def = ALL_TOOLS.find((t) => t.id === tool)!;
    const ink =
      tool === "highlighter"
        ? { currentItemStrokeColor: HIGHLIGHTER.color, currentItemStrokeWidth: HIGHLIGHTER.strokeWidth, currentItemOpacity: HIGHLIGHTER.opacity }
        : { currentItemStrokeColor: color, currentItemStrokeWidth: PEN.strokeWidth, currentItemOpacity: PEN.opacity };
    api.updateScene({ appState: ink });
    api.setActiveTool({ type: def.excalidraw });
    setActiveTool(tool);
  }, []);

  const onApi = useCallback(
    (api: ExcalidrawImperativeAPI) => {
      // Excalidraw may hand over a new API (e.g. React StrictMode mounts twice in dev): always drive the latest canvas.
      if (apiRef.current === api) return;
      agentRef.current?.dispose();
      playerRef.current?.stop();
      playerRef.current = null;
      apiRef.current = api;
      drawing.applyRestore();
      const a = new BoardAgent(api);
      a.followInk = true; // a chat frame is small: the view keeps up with the pen as it draws
      a.insets = { top: 92, bottom: 64 }; // keep drawing clear of the toolbar (top) and the Follow toggle (bottom)
      agentRef.current = a;
      setAgent(a);
      requestAnimationFrame(() => {
        applyTool("pen", PEN_COLORS[0].value);
        if (pending.current) play(pending.current.title, pending.current.steps, pending.current.live);
      });
    },
    [applyTool, play],
  );

  // When the learner draws, send Claude a picture of the board (once they pause), and tell it so.
  const onChange = useCallback((_: unknown, appState: AppState) => {
    const type = appState.activeTool.type;
    setActiveTool(cur => ALL_TOOLS.find(t => t.id === cur)!.excalidraw === type ? cur : ALL_TOOLS.find(t => t.excalidraw === type)?.id ?? cur);
    drawing.change();
  }, []);

  // Connect to the chat host (handlers first: the host may send tool input right after the handshake).
  useEffect(() => {
    if (!embedded) {
      setTitle(DEMO.title);
      const timer = setTimeout(() => play(DEMO.title, completeSteps(DEMO as unknown as Record<string, unknown>, true), false), 400);
      return () => clearTimeout(timer);
    }
    const context = (ctx: McpUiHostContext | undefined) => {
      if (!ctx) return;
      if (ctx.theme === "dark" || ctx.theme === "light") setTheme(ctx.theme);
      if (ctx.safeAreaInsets) setInsets(ctx.safeAreaInsets);
      if (ctx.availableDisplayModes) canFullscreen.current = ctx.availableDisplayModes.includes("fullscreen");
      if (ctx.displayMode || ctx.availableDisplayModes)
        setFullscreen((was) => (canFullscreen.current ? (ctx.displayMode ? ctx.displayMode === "fullscreen" : (was ?? false)) : null));
    };
    app.ontoolinput = (p) => typeof p.arguments?.title === "string" && setTitle(p.arguments.title);
    app.ontoolresult = (r) => {
      const sc = r.structuredContent as { board_id?: string; title?: string; unsupported?: string } | undefined;
      if (sc?.unsupported) setUnsupported(sc.unsupported);
      if (sc?.board_id && boardIdRef.current !== sc.board_id) follow(sc.board_id, sc.title ?? "");
    };
    app.onhostcontextchanged = (ctx) => context(ctx);
    app.onteardown = async () => {
      await drawing.flush();
      drawing.reset();
      topic.current++;
      cancelFiller();
      following.current++;
      stopTalkRef.current();
      playerRef.current?.stop();
      voiceRef.current.stop();
      return {};
    };
    void app.connect().then(() => context(app.getHostContext()), (e) => report("error", `couldn't connect to the chat app: ${String(e)}`));
  }, [follow, play]);

  const selectColor = (color: string) => {
    setPenColor(color);
    applyTool(activeTool === "highlighter" ? "pen" : activeTool, color);
  };
  const clearMine = () => {
    const api = apiRef.current;
    if (!api) return;
    // The learner's own marks only: Dudeling's drawing stays.
    api.updateScene({
      elements: api.getSceneElementsIncludingDeleted().map((el) => (el.customData?.by === "agent" ? el : { ...el, isDeleted: true })),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  };
  const toggleVoice = () => {
    // The click that unlocks sound means "voice on", never "mute".
    if (performance.now() - unlockedAt.current < 400) return;
    voiceRef.current.setMuted(!muted);
    setMuted(!muted);
  };
  const toggleFullscreen = async (want = !fullscreen) => {
    const r = await app.requestDisplayMode({ mode: want ? "fullscreen" : "inline" }).catch(() => null);
    if (r) setFullscreen(r.mode === "fullscreen");
  };
  const pressPlay = () => {
    unlock();
    setNeedsPlay(false);
    if (canFullscreen.current && !fullscreen) void toggleFullscreen(true);
  };
  const togglePause = () => {
    const p = playerRef.current;
    if (!p) return;
    pausedByLearner.current = false;
    if (p.isPaused) { recognitionFailed.current = false; p.resume(); }
    else p.pause();
  };
  const sendDraft = async () => {
    const text = draft.trim();
    if (!text) return;
    const origin = stamp();
    setDraft("");
    if (!(await submit(text, "typed")) && origin === stamp()) setDraft((d) => d || text);
  };
  const continueInChat = async () => {
    if (await sendToChat(`Continue the Dudeling lesson on board ${boardIdRef.current}, and listen to me on the board.`)) {
      setInChat(true);
      setCaption("Press Enter in the chat to carry on.");
    } else setCaption("Type “continue” in the chat to carry on.");
  };
  const useHere = async () => {
    const id = boardIdRef.current;
    if (!id) return;
    setElsewhere(false);
    await resetBoard(titleRef.current);
    follow(id, titleRef.current);
  };

  const idle = !playing.narrating && !replying;
  const status = expired
    ? "Expired"
    : talk === "hearing"
      ? "Hearing you"
      : talk === "transcribing"
        ? "Understanding"
        : playing.preparing
          ? "Getting the voice ready"
          : !idle
            ? "Speaking"
            : thinking
              ? "Thinking"
              : inChat
                ? "Press Enter in the chat"
                : needsPlay
                  ? "Ready"
                  : playing.paused && !playing.waiting
                    ? "Paused"
                    : claude === "listening"
                      ? playing.waiting
                        ? "Your answer?"
                        : "Your turn"
                      : claude === "busy"
                        ? "Dudeling is working"
                        : "Not listening";
  const showContinue = embedded && started && idle && !needsPlay && !thinking && !inChat && !expired && claude === "away";
  const talking = talk !== "off" && talk !== "denied";

  if (unsupported)
    return (
      <div className={`dud dud--${theme}`}>
        <p className="dud__unsupported" role="alert">{unsupported}</p>
      </div>
    );

  return (
    <div
      className={`dud dud--${theme} ${fullscreen ? "dud--full" : ""}`}
      style={insets ? { padding: `${insets.top}px ${insets.right}px ${insets.bottom}px ${insets.left}px` } : undefined}
    >
      <div className="dud__board">
        <div className="whiteboard">
          <Excalidraw
            excalidrawAPI={onApi}
            onChange={onChange}
            onPointerUpdate={({ pointer, button }) => agentRef.current?.setHumanPointer(pointer, button === "down")}
            theme={theme === "dark" ? THEME.DARK : THEME.LIGHT}
            UIOptions={{
              canvasActions: { changeViewBackgroundColor: false, clearCanvas: false, export: false, loadScene: false, saveAsImage: false, saveToActiveFile: false, toggleTheme: false },
              tools: { image: false },
            }}
          />
          <Toolbar activeTool={activeTool} penColor={penColor} onSelectTool={(t) => applyTool(t, penColor)} onSelectColor={selectColor} onClear={clearMine} />
          {agent && <TutorPresence agent={agent} />}
        </div>
        {needsPlay && !unlocked && !elsewhere && (
          <button type="button" className="dud__play" onClick={pressPlay}>
            <span>Play the lesson</span>
            <small>Dudeling explains it out loud as it draws</small>
          </button>
        )}
        {elsewhere && (
          <button type="button" className="dud__play" onClick={() => void useHere()}>
            <span>Use this board here</span>
            <small>It's playing in a newer place in the chat</small>
          </button>
        )}
        {!started && !needsPlay && !elsewhere && <div className="dud__waiting">{title ? `“${title}”: the board fills in as Dudeling explains.` : "Dudeling is getting the board ready…"}</div>}
      </div>
      <div className="dud__bar">
        <div className="dud__caption" aria-live="polite">
          {embedded && !elsewhere && <b className="dud__status">{status}</b>}
          <span>{sentDrawing ? "Dudeling can see your drawing now. Ask “is this right?”" : caption || title || "Dudeling"}</span>
        </div>
        {!elsewhere && (
          <div className="dud__controls">
            {embedded && (
              <>
                <button
                  type="button"
                  className={`dud__talk dud__talk--${talk}`}
                  onClick={() => void toggleTalk()}
                  aria-pressed={talking}
                  title={talking ? "Stop listening" : "Talk to Dudeling: ask, answer and interrupt out loud"}
                >
                  <span>{{ off: "Talk", starting: "Starting…", listening: "Listening", hearing: "Hearing you", transcribing: "Listening", denied: "Mic blocked" }[talk]}</span>
                </button>
                {/* No <form>: sandboxed boards can't submit one. */}
                <input
                  className="dud__text"
                  value={draft}
                  maxLength={2000}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter" && !e.nativeEvent.isComposing) void sendDraft();
                  }}
                  placeholder={playing.waiting ? "Type your answer" : "Ask or answer"}
                  aria-label="Type to Dudeling"
                  disabled={expired}
                />
                {draft.trim() && (
                  <button type="button" onClick={() => void sendDraft()}>
                    <span>Send</span>
                  </button>
                )}
              </>
            )}
            {showContinue && (
              <button type="button" className="dud__continue" onClick={() => void continueInChat()}>
                <span>Continue in the chat</span>
              </button>
            )}
            {started && (playing.narrating || playing.paused) && (
              <button type="button" onClick={togglePause} title={playing.paused ? "Carry on" : "Pause Dudeling"}>
                <span>{playing.waiting ? "Skip" : playing.paused ? "Resume" : "Pause"}</span>
              </button>
            )}
            {embedded && (
              <button type="button" onClick={toggleVoice} aria-pressed={unlocked && !muted} title={unlocked && !muted ? "Mute Dudeling" : "Hear Dudeling"}>
                <span>{!unlocked ? "Voice" : muted ? "Muted" : voiceKind === "browser" ? "Voice on (basic)" : "Voice on"}</span>
              </button>
            )}
            {fullscreen !== null && (
              <button type="button" onClick={() => void toggleFullscreen()} title={fullscreen ? "Back to the chat" : "Full screen"}>
                <span>{fullscreen ? "Exit" : "Full screen"}</span>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Board />
  </StrictMode>,
);
