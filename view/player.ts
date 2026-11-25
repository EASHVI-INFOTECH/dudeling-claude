/**
 * Plays steps on the board: each step's line is spoken and shown as a caption, and its actions are drawn
 * as the voice reaches their [n] markers.
 *
 * Live boards: a step with words waits until sound is unlocked (`canSpeak`); steps without words (quick
 * sketches, what was taught before this board was shown) are drawn at once.
 */
import type { BoardAgent } from "@board/agent/BoardAgent";
import type { AgentAction } from "@board/agent/actions";
import type { Lesson, LessonStep } from "@board/tutor/lesson";
import { cueTimes, parseCues, repairLesson } from "@board/tutor/rails";
import { speechMs, type Spoken } from "./voice";

export interface PlayStep extends LessonStep {
  /** Which line of which event this is (for the played-up-to position). */
  mark?: { seq: number; step: number };
  /** The check question this step asks: the board then waits for the answer. */
  check?: string;
  /** Taught before this board was shown: drawn fast. */
  fast?: boolean;
}

export interface PlayerState {
  narrating: boolean;
  paused: boolean;
  waiting: boolean;
  /** The line's audio is still being made. */
  preparing: boolean;
}

export interface PlayerEvents {
  caption(text: string, step: number, total: number): void;
  done(): void;
  state?(state: PlayerState): void;
  stepDone?(step: PlayStep): void;
  /** A line is waiting for the learner's first click (browsers need one before playing sound). */
  needsSound?(): void;
}

/** Something that can say a line (the board's Voice). */
export interface Sayer {
  say(text: string): Promise<Spoken>;
  prepare(text: string): void;
  stop(): void;
}

// repairLesson's defaults are one generated lesson's. A board holds many parts: the plugin bounds their size.
const WHOLE_BOARD = { steps: Infinity, actions: Infinity };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Board moves (sections and the map): played as given, never through the layout rails. */
const NAV = new Set(["open_section", "go_to", "overview"]);
export const isNavStep = (s: LessonStep) => s.actions.some((a) => NAV.has(a.type));

/**
 * Every section has the same local coordinates, so each is repaired on its own: otherwise the rails would push a
 * new box's drawing away from the last box's. Ids drawn anywhere on the board stay known (to point back at).
 */
export function repairBySection(title: string, steps: PlayStep[]): PlayStep[] {
  const groups = new Map<string, number[]>();
  let section = "";
  steps.forEach((s, i) => {
    if (isNavStep(s)) {
      for (const a of s.actions) if (a.type === "open_section") section = a.id;
      else if (a.type === "go_to") section = a.section;
      return;
    }
    if (!groups.has(section)) groups.set(section, []);
    groups.get(section)!.push(i);
  });
  const ids = steps.flatMap((s) => s.actions.map((a) => ("id" in a && typeof a.id === "string" ? a.id : ""))).filter(Boolean);
  const out = [...steps];
  for (const [group, idx] of groups) {
    const mine = new Set(idx.flatMap((i) => steps[i].actions.map((a) => ("id" in a && typeof a.id === "string" ? a.id : ""))));
    const lesson: Lesson = { title, steps: idx.map((i) => steps[i]) };
    const fixed = repairLesson(lesson, undefined, ids.filter((id) => !mine.has(id)), WHOLE_BOARD, group ? group + "-" : "").lesson.steps;
    idx.forEach((i, k) => (out[i] = { ...steps[i], ...fixed[k] }));
  }
  return out;
}
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Steps that are safe to play from a partial (still streaming) lesson: all but the last one. */
export function completeSteps(partial: { steps?: unknown }, final: boolean): PlayStep[] {
  const steps = Array.isArray(partial.steps) ? partial.steps : [];
  const ready = final ? steps : steps.slice(0, -1);
  return ready
    .filter((s): s is { say: string; actions: unknown[] } => !!s && typeof (s as any).say === "string" && Array.isArray((s as any).actions))
    .map((s) => ({ say: s.say, actions: s.actions.filter((a) => a && typeof a === "object" && typeof (a as any).type === "string") as AgentAction[] }));
}

export class Player {
  private queue: PlayStep[] = [];
  private played = 0;
  private running = false;
  private finished = false;
  private stopped = false;
  private title = "";
  private speaking = "";
  private preparing = false;
  /** Paused (the learner interrupted): the step that was cut off replays from its start on resume. */
  private paused = false;
  /** Bumped on every pause: a step that started before it stops at its next await, wherever it is. */
  private epoch = 0;
  private waiting: string | null = null;
  private agent: BoardAgent;
  private events: PlayerEvents;
  voice: Sayer | null = null;
  canSpeak: () => boolean = () => true;
  live = false;
  /** Timeline log (debugging): step start, audio ready, done, pause/resume. Never any of the words. */
  trace: (msg: string) => void = () => {};

  constructor(agent: BoardAgent, events: PlayerEvents) {
    this.agent = agent;
    this.events = events;
  }

  /** Give the player the lesson so far; steps already played are kept, new ones are queued. */
  update(title: string, steps: PlayStep[], final: boolean) {
    this.title = title || this.title;
    // Repair the whole known lesson (layout rails), so later steps are placed around earlier ones.
    try {
      this.queue = repairBySection(this.title, steps);
    } catch (e) {
      // Odd input the layout rails can't handle: draw it as given rather than not at all.
      this.trace(`layout repair failed (${String(e).slice(0, 120)}); drawing as given`);
      this.queue = steps;
    }
    if (final) this.finished = true;
    void this.run();
  }

  /** Go on, e.g. once sound is unlocked. */
  start() {
    void this.run();
  }

  private emit() {
    this.events.state?.({ narrating: this.isNarrating, paused: this.paused, waiting: this.waiting !== null, preparing: this.preparing && !this.paused });
  }

  private async run() {
    if (this.running) return;
    this.running = true;
    while (!this.stopped && !this.paused && this.played < this.queue.length) {
      const i = this.played;
      const step = this.queue[i];
      if (this.live && step.say && !this.canSpeak()) {
        this.events.needsSound?.();
        break;
      }
      this.played++;
      // This line's audio and the next one's: the plugin makes the rest of the part ahead anyway.
      if (this.voice) for (const st of this.queue.slice(i, i + 2)) if (st.say) this.voice.prepare(parseCues(st.say).text);
      const epoch = this.epoch;
      try {
        await this.playStep(step, i);
      } catch (e) {
        // One step failing (an odd action, an audio hiccup) must not stop the rest of the lesson.
        this.trace(`step ${i + 1} failed: ${String(e).slice(0, 160)}`);
      }
      if (this.stopped) break;
      if (this.epoch !== epoch) this.played = i; // cut off by a pause: say this step again
      else {
        this.events.stepDone?.(step);
        // Waits for the answer, unless Claude has already sent what comes next (it moved on: carry on).
        if (this.live && step.check && this.played >= this.queue.length) {
          this.paused = true;
          this.waiting = step.check;
          this.trace(`waiting for the answer to step ${i + 1}`);
        }
      }
    }
    this.running = false;
    this.speaking = "";
    this.preparing = false;
    if (this.stopped) return;
    this.emit();
    if (this.finished && this.played >= this.queue.length) this.events.done();
  }

  private async playStep(step: PlayStep, index: number) {
    const epoch = this.epoch;
    const cut = () => this.stopped || this.epoch !== epoch;
    const { text, at } = parseCues(step.say);
    const n = step.actions.length;
    const voiced = !!this.voice && !!text;
    this.speaking = text;
    this.preparing = voiced;
    this.emit();
    this.trace(`step ${index + 1} start`);
    // A spoken line's caption appears when its voice starts (not while its audio is still being made).
    if (!voiced && (text || !this.live)) this.events.caption(text, index + 1, this.queue.length);
    // Live, nothing to pace by: draw at a natural speed.
    if (this.live && !voiced && !text) {
      for (let i = 0; i < n && !cut(); i++) await this.agent.run([step.actions[i]], { speed: step.fast ? 12 : 1.3 });
      if (n) await this.reframe();
      return;
    }
    // Repair strips the [n] markers and leaves their positions in `cues`.
    const cues = step.cues?.length === n ? step.cues : cueTimes(n, step.actions.map((_, i) => at.get(i + 1)));
    const spoken = voiced ? await this.voice!.say(text) : { duration: speechMs(text), done: wait(speechMs(text)) };
    // Paused while the audio was being made: don't start talking now.
    if (cut()) return this.trace(`step ${index + 1} cut before speaking`);
    this.preparing = false;
    this.emit();
    this.trace(`step ${index + 1} audio ${spoken.duration | 0} ms`);
    if (voiced) this.events.caption(text, index + 1, this.queue.length);
    const { duration, done } = spoken;
    const t0 = performance.now();
    for (let i = 0; i < n && !cut(); i++) {
      const action = step.actions[i];
      const target = cues[i] * duration;
      const nextAt = i + 1 < n ? cues[i + 1] * duration : duration;
      const drawing = Math.max(200, this.agent.estimate(action) - 450);
      const room = Math.max(400, (nextAt - target) * 0.9);
      const speed = clamp(drawing / room, 1, 6);
      const startAt = target - this.agent.leadTime(action) / speed;
      while (!cut() && performance.now() - t0 < startAt - 10) await wait(Math.min(50, startAt - (performance.now() - t0)));
      if (cut()) break;
      await this.agent.run([action], { speed });
    }
    await done;
    this.trace(`step ${index + 1} audio done${cut() ? " (cut)" : ""}`);
    if (!cut() && n) this.reframe();
  }

  /**
   * A chat frame is small: after each step, frame what's drawn in this section so far (if following). On the
   * camera's own track: the next line starts while the view settles.
   */
  private reframe() {
    if (!this.stopped && this.agent.isFollowing) this.agent.frameWork();
  }

  /** Pause right away (voice and pen); `resume` carries on with the step that was cut off. */
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.epoch++;
    this.trace("pause");
    this.voice?.stop();
    this.agent.interrupt();
    this.emit();
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.waiting = null;
    this.trace(`resume (at step ${this.played + 1})`);
    this.emit();
    void this.run(); // (if the cut-off step is still unwinding, the running loop picks up from it)
  }

  get isPaused() {
    return this.paused;
  }

  /** The check question it's waiting on, for the learner's answer. */
  get waitingForAnswer() {
    return this.waiting;
  }

  /** The line being said. */
  get line() {
    return this.speaking;
  }

  /** Saying a line right now (not paused, not finished). */
  get isNarrating() {
    return this.running && !this.paused && !this.stopped && !!this.speaking;
  }

  /** Stop (e.g. before a replay). */
  stop() {
    this.stopped = true;
    this.epoch++;
    this.voice?.stop();
    this.agent.interrupt();
  }
}
