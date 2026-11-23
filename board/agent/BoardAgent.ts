import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  exportToBlob,
  getCommonBounds,
  getVisibleSceneBounds,
} from "@excalidraw/excalidraw";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { Collaborator, ExcalidrawImperativeAPI, SocketId } from "@excalidraw/excalidraw/types";
import { HIGHLIGHTER, PEN_COLORS } from "../whiteboard/tools";
import type { ActionResult, AgentAction, BoardObservation, InkColor, Target } from "./actions";
import { Interrupted, dist, easeInOut, easeOut, lerp, sleep, tween } from "./animate";
import { collides, findFreeSpot, placeLabel, routeArrow, type Box as LayoutBox, type Obstacles } from "./layout.ts";
import { placeSection, union, type Rect } from "./sections.ts";

type Point = { x: number; y: number };
type Box = { x1: number; y1: number; x2: number; y2: number };
type CaptureUpdate = (typeof CaptureUpdateAction)[keyof typeof CaptureUpdateAction];

/**
 * Excalidraw colours remote cursors by hashing this id into a pastel hue
 * (`getClientColor`); it ignores `collaborator.color`. This id lands on hue 260: purple.
 */
const AGENT_SOCKET = "dudeling-agent-53" as SocketId;
const AGENT_NAME = "Dudeling";
const AGENT_COLOR = "#7048e8";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const boundsOf = (pts: Point[]): Box => ({
  x1: Math.min(...pts.map((p) => p.x)),
  y1: Math.min(...pts.map((p) => p.y)),
  x2: Math.max(...pts.map((p) => p.x)),
  y2: Math.max(...pts.map((p) => p.y)),
});
const randomSeed = () => Math.floor(Math.random() * 2 ** 31);

/**
 * Lets an AI agent work on the whiteboard alongside the human.
 *
 * - The agent has its own visible cursor (rendered as an Excalidraw collaborator).
 * - Every action is animated the way a person would do it: the cursor travels,
 *   shapes are dragged out, text is typed, things are laser-pointed at.
 * - The agent only ever touches its own elements and never changes the human's
 *   tool or selection. It moves the human's view (to follow it across sections)
 *   only while the human is *following* it: scrolling or zooming by hand stops
 *   following, and the agent never pans while the human is mid-stroke.
 * - Big lessons spread across *sections* (see sections.ts): titled areas in free
 *   space, each with its own local coordinates.
 * - `interrupt()` stops immediately (the current stroke is completed, not left
 *   half-drawn) and drops anything queued — for when the human cuts in.
 */
export class BoardAgent {
  /** Animation speed multiplier: 2 = twice as fast. */
  speed = 1;

  /**
   * Keep the board readable: route arrows around things (curving or detouring),
   * put arrow labels in free space beside the line, and nudge text/shapes off
   * anything they'd land on. Off = draw exactly where told (used to measure the effect).
   */
  layoutAssist = true;

  /**
   * The camera keeps the pen in view on its own track: when the next ink would land off screen, the view
   * glides there WHILE the cursor travels and draws (never one after the other). Off by default; the small chat
   * frame turns it on.
   */
  followInk = false;

  /** Called the moment an action's ink starts appearing (after the cursor's glide) — for sync timing. */
  onInk: (() => void) | null = null;

  /**
   * How long the cursor's glide to an action's starting point will take, at speed 1 (ms).
   * Narration sync starts an action this much early, so the ink lands on the word.
   */
  leadTime(action: AgentAction): number {
    const a = this.toScene(action);
    const at = (t: Target): Point | null => {
      if (typeof t !== "string") return t;
      try {
        return this.resolvePoint(t);
      } catch {
        return null;
      }
    };
    let p: Point | null = null;
    switch (a.type) {
      case "draw_shape":
      case "write_text":
        p = { x: a.x, y: a.y };
        break;
      case "draw_arrow":
        p = at(a.from);
        break;
      case "draw_freehand":
        p = a.points[0] ? { x: a.points[0][0], y: a.points[0][1] } : null;
        break;
      case "point_at":
      case "circle":
      case "underline":
      case "highlight":
        p = at(a.target);
        break;
    }
    if (!p) return 0;
    const d = dist(this.cursor, p);
    return d < 1 ? 0 : clamp(150 + d * 0.6, 150, 800);
  }

  /** Screen space covered by UI at the top/bottom, which the camera keeps content clear of. */
  insets = { top: 80, bottom: 170 };

  /** What layout assist did, most recent last (for debugging and evals). */
  readonly layoutLog: { id: string; what: string }[] = [];

  private cursor: Point = { x: 0, y: 0 };
  private tool: "pointer" | "laser" = "pointer";
  private button: "up" | "down" = "up";
  private speaking = false;
  private humanPointer: BoardObservation["humanPointer"] = null;
  private queue: Promise<unknown> = Promise.resolve();
  private current: AbortController | null = null;
  /** The camera track's move in progress: replaced by a newer one, stopped by interrupt(). */
  private camera: AbortController | null = null;
  /** Where the camera is heading (zoom + the scene point it centres on), while a move is under way. */
  private cameraGoal: { z: number; c: Point } | null = null;
  private generation = 0;
  private idCounter = 0;

  private disposed = false;

  // Sections (map lessons) and the shared view.
  private sections = new Map<string, Rect & { title: string; outlined: boolean }>();
  private currentSection: string | null = null;
  private following = true;
  private nameTag = true;
  private humanPressed = false;
  private lastCameraWrite = 0;
  private listeners = new Set<() => void>();
  private emitScheduled = false;
  private unsubscribe: (() => void)[] = [];

  constructor(readonly api: ExcalidrawImperativeAPI) {
    // The canvas has no size until it's laid out; park the cursor once it does.
    requestAnimationFrame(() => {
      const v = this.viewport();
      this.cursor = { x: v.x1 + (v.x2 - v.x1) * 0.8, y: v.y1 + (v.y2 - v.y1) * 0.25 };
      this.render();
    });
    this.unsubscribe.push(
      // Any view change we didn't make ourselves means the human took the wheel.
      api.onScrollChange(() => {
        if (performance.now() - this.lastCameraWrite > 150 && this.following) this.following = false;
        this.emit();
      }),
      api.onPointerDown(() => {
        this.humanPressed = true;
      }),
      api.onPointerUp(() => {
        this.humanPressed = false;
      }),
    );
  }

  /** Run actions in order (queued behind any running batch). Resolves with one result per action. */
  run(actions: AgentAction[], opts: { speed?: number } = {}): Promise<ActionResult[]> {
    const generation = this.generation;
    const job = this.queue.then(async () => {
      // A per-batch speed (e.g. to fit a drawing into the time the voice spends on it).
      const base = this.speed;
      if (opts.speed) this.speed = base * opts.speed;
      try {
        return await this.execute(actions, generation);
      } finally {
        this.speed = base;
      }
    });
    this.queue = job.catch(() => undefined);
    return job;
  }

  /**
   * Roughly how long an action takes to animate at speed 1 (ms) — used to pace drawing
   * against speech. Mirrors the durations used by the animations below.
   */
  estimate(a: AgentAction): number {
    const glide = 450;
    const typing = (text: string) => clamp(1400 / Math.max(1, text.length), 18, 45) * text.length;
    switch (a.type) {
      case "write_text":
        return glide + typing(a.text);
      case "draw_shape":
        return glide + clamp(250 + (a.width + a.height) * 0.8, 300, 900) + (a.label ? 300 + typing(a.label) : 0);
      case "draw_arrow":
        return glide + 600 + (a.label ? 300 + typing(a.label) : 0);
      case "draw_freehand":
      case "circle":
      case "underline":
      case "highlight":
        return glide + 800;
      case "point_at":
        return glide + (a.durationMs ?? 1200);
      case "open_section":
      case "go_to":
      case "overview":
      case "focus":
        return 1200;
      case "wait":
        return a.ms;
      default:
        return 400;
    }
  }

  /** Stop what the agent is doing right now and drop anything queued. */
  interrupt() {
    this.generation++;
    this.current?.abort();
    this.camera?.abort();
  }

  /**
   * Frame what's drawn in the current section (everything, without sections) on the camera track: returns at
   * once, so the next line can start while the view settles.
   */
  frameWork() {
    if (!this.following || this.disposed) return;
    const s = this.currentSection ? this.sections.get(this.currentSection) : undefined;
    const inside = (b: Box) => !s || (b.x2 > s.x && b.x1 < s.x + s.width && b.y2 > s.y && b.y1 < s.y + s.height);
    const boxes = this.api
      .getSceneElements()
      .filter((el) => !el.customData?.section)
      .map((el) => {
        const [x1, y1, x2, y2] = getCommonBounds([el]);
        return { x1, y1, x2, y2 };
      })
      .filter(inside)
      .map((b) => ({ x: b.x1, y: b.y1, width: b.x2 - b.x1, height: b.y2 - b.y1 }));
    const r = union(boxes) ?? (s ? { ...s } : null);
    if (!r) return;
    const pad = 60;
    this.cameraTrack({ x: r.x - pad, y: r.y - pad, width: r.width + 2 * pad, height: r.height + 2 * pad });
  }

  /** Start a camera move on its own track. The pen never waits for it; a newer move takes over from wherever this one is. */
  private cameraTrack(r: Rect) {
    if (!this.following || this.humanPressed || this.disposed) return;
    this.camera?.abort();
    const c = new AbortController();
    this.camera = c;
    void this.moveCamera(r, c.signal, 1, false)
      .catch(() => {})
      .finally(() => {
        if (this.camera === c) this.camera = null;
      });
  }

  /**
   * About to put ink at `b` (scene coordinates): if that's off screen, pan just enough (same zoom; zoom out only
   * if it can't fit), a little past it in the direction of travel, so the next ink is likely in view too.
   */
  private keepInView(b: Box) {
    if (!this.followInk || !this.following || this.disposed) return;
    // Judge by where the camera is heading, not where it is mid-move: a zoom still settling from the last step
    // would otherwise leave the pen drawing off screen.
    const st = this.api.getAppState();
    const usableH = st.height - this.insets.top - this.insets.bottom;
    const z = this.cameraGoal?.z ?? st.zoom.value;
    const c = this.cameraGoal?.c ?? { x: st.width / 2 / z - st.scrollX, y: (this.insets.top + usableH / 2) / z - st.scrollY };
    const w = (st.width - 80) / z;
    const h = usableH / z;
    if (w <= 0 || h <= 0) return;
    const usable = { x1: c.x - w / 2, x2: c.x + w / 2, y1: c.y - h / 2, y2: c.y + h / 2 };
    const pad = 24 / z;
    const box = { x1: b.x1 - pad, y1: b.y1 - pad, x2: b.x2 + pad, y2: b.y2 + pad };
    if (box.x1 >= usable.x1 && box.x2 <= usable.x2 && box.y1 >= usable.y1 && box.y2 <= usable.y2) return;
    if (box.x2 - box.x1 > w || box.y2 - box.y1 > h) {
      this.cameraTrack({ x: box.x1, y: box.y1, width: box.x2 - box.x1, height: box.y2 - box.y1 });
      return;
    }
    const ahead = 0.15; // look ahead: the next thing usually follows in the same direction
    const shift = (lo: number, hi: number, ulo: number, uhi: number, span: number) =>
      lo < ulo ? Math.max(lo - ulo - span * ahead, hi - uhi) : hi > uhi ? Math.min(hi - uhi + span * ahead, lo - ulo) : 0;
    const dx = shift(box.x1, box.x2, usable.x1, usable.x2, w);
    const dy = shift(box.y1, box.y2, usable.y1, usable.y2, h);
    this.cameraTrack({ x: usable.x1 + dx, y: usable.y1 + dy, width: w, height: h });
  }

  /** Stop for good and remove the agent's cursor from the board. */
  dispose() {
    this.interrupt();
    this.unsubscribe.forEach((u) => u());
    this.listeners.clear();
    this.api.updateScene({ collaborators: new Map(), captureUpdate: CaptureUpdateAction.NEVER });
    this.disposed = true;
  }

  get busy() {
    return this.current !== null;
  }

  /** Is the human's view following the agent around the board? */
  get isFollowing() {
    return this.following;
  }

  /** Start following the agent again: jump the view to where it's working. */
  follow() {
    this.following = true;
    this.emit();
    const target = this.currentSection ? this.sections.get(this.currentSection)! : this.rectAround(this.cursor);
    void this.moveCamera(target, new AbortController().signal).catch(() => undefined);
  }

  /** Stop moving the human's view (they keep exploring on their own). */
  unfollow() {
    this.following = false;
    this.emit();
  }

  /** Where the agent's cursor is, in scene coordinates. */
  get cursorPosition(): Point {
    return { ...this.cursor };
  }

  /** A fingerprint of what the human has drawn (changes whenever they draw/edit/erase). */
  humanDrawingVersion(): string {
    return this.api
      .getSceneElements()
      .filter((el) => el.customData?.by !== "agent")
      .map((el) => `${el.id}:${el.version}`)
      .join(",");
  }

  /** An image of just what the human drew (null if nothing). */
  async snapshotHumanDrawing(): Promise<Blob | null> {
    const mine = this.api.getSceneElements().filter((el) => el.customData?.by !== "agent");
    if (!mine.length) return null;
    // Include the human's text labels bound to their shapes; render light so the model reads it easily.
    return exportToBlob({
      elements: mine,
      appState: { ...this.api.getAppState(), exportBackground: true, viewBackgroundColor: "#ffffff", exportWithDarkMode: false },
      files: this.api.getFiles(),
      mimeType: "image/png",
      maxWidthOrHeight: 1024,
    });
  }

  /** An image of the whole board (light background, for sharing/printing). */
  async snapshotBoard(): Promise<Blob | null> {
    const elements = this.api.getSceneElements();
    if (!elements.length) return null;
    return exportToBlob({
      elements,
      appState: { ...this.api.getAppState(), exportBackground: true, viewBackgroundColor: "#ffffff", exportWithDarkMode: false },
      files: this.api.getFiles(),
      mimeType: "image/png",
      exportPadding: 40,
    });
  }

  /** Rebuild the section map from a restored board (section frames carry their id and title). */
  restoreSections() {
    this.sections.clear();
    const all = this.api.getSceneElements();
    for (const el of all) {
      const id = el.customData?.section as string | undefined;
      if (!id || el.type !== "rectangle" || this.sections.has(id)) continue;
      const title = all.find((t) => t.id === `section-${id}-title`);
      this.sections.set(id, { x: el.x, y: el.y, width: el.width, height: el.height, title: title?.type === "text" ? title.text : id, outlined: true });
    }
    this.currentSection = null;
    this.emit();
  }

  /** Sections opened so far, in order. */
  listSections() {
    return [...this.sections].map(([id, s]) => ({ id, title: s.title, x: s.x, y: s.y, width: s.width, height: s.height }));
  }

  /** Be told when the cursor moves, the view changes or follow mode flips (batched per frame). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    if (this.emitScheduled) return;
    this.emitScheduled = true;
    requestAnimationFrame(() => {
      this.emitScheduled = false;
      this.listeners.forEach((l) => l());
    });
  }

  /** Everything the agent needs to know about the board to decide what to do next. */
  observe(): BoardObservation {
    const v = this.viewport();
    const all = this.api.getSceneElements();
    const labels = new Map<string, string>();
    for (const el of all) {
      if (el.type === "text" && el.containerId) labels.set(el.containerId, el.text);
    }
    const round = (n: number) => Math.round(n);
    return {
      viewport: { x: round(v.x1), y: round(v.y1), width: round(v.x2 - v.x1), height: round(v.y2 - v.y1) },
      humanPointer: this.humanPointer,
      agentCursor: { x: round(this.cursor.x), y: round(this.cursor.y) },
      following: this.following,
      currentSection: this.currentSection,
      sections: this.listSections(),
      elements: all
        .filter((el) => !(el.type === "text" && el.containerId)) // labels are folded into their shape
        .map((el) => {
          const [x1, y1, x2, y2] = getCommonBounds([el]);
          const text = el.type === "text" ? el.text : labels.get(el.id);
          return {
            id: el.id,
            type: el.type,
            by: el.customData?.by === "agent" ? ("agent" as const) : ("human" as const),
            x: round(x1),
            y: round(y1),
            width: round(x2 - x1),
            height: round(y2 - y1),
            ...(text ? { text } : {}),
          };
        }),
    };
  }

  /** Feed the human's pointer in (from Excalidraw's onPointerUpdate). */
  setHumanPointer(pointer: { x: number; y: number }, pressed: boolean) {
    this.humanPointer = { x: Math.round(pointer.x), y: Math.round(pointer.y), pressed };
  }

  /** Show the "speaking" glow on the agent's cursor. */
  setSpeaking(speaking: boolean) {
    this.speaking = speaking;
    this.render();
  }

  private async execute(actions: AgentAction[], generation: number): Promise<ActionResult[]> {
    const interrupted = (a: AgentAction): ActionResult => ({ ok: false, action: a.type, error: "interrupted" });
    if (generation !== this.generation) return actions.map(interrupted);

    const controller = new AbortController();
    this.current = controller;
    const results: ActionResult[] = [];
    try {
      for (const action of actions) {
        if (controller.signal.aborted) {
          results.push(interrupted(action));
          continue;
        }
        try {
          const id = await this.perform(action, controller.signal);
          results.push({ ok: true, action: action.type, ...(id ? { id } : {}) });
        } catch (err) {
          results.push(
            err instanceof Interrupted
              ? interrupted(action)
              : { ok: false, action: action.type, error: err instanceof Error ? err.message : String(err) },
          );
        }
      }
    } finally {
      if (this.current === controller) this.current = null;
      this.tool = "pointer";
      this.button = "up";
      this.render();
    }
    return results;
  }

  private async perform(action: AgentAction, signal: AbortSignal): Promise<string | void> {
    const a = this.toScene(action);
    switch (a.type) {
      case "open_section":
        return this.openSection(a, signal);
      case "go_to": {
        const s = this.sections.get(a.section);
        if (!s) throw new Error(`No section "${a.section}"`);
        this.currentSection = a.section;
        return this.travelTo(s, signal);
      }
      case "overview":
        return this.overview(signal);
      case "move_cursor":
        return this.moveCursor(this.resolvePoint(a.to), signal);
      case "point_at":
        return this.pointAt(a.target, a.durationMs ?? 1200, signal);
      case "draw_shape":
        return this.drawShape(a, signal);
      case "draw_arrow":
        return this.drawArrow(a, signal);
      case "write_text":
        return this.writeText(a, signal);
      case "draw_freehand":
        return this.drawStroke(
          this.claimId(a.id),
          a.points.map(([x, y]) => ({ x, y })),
          { color: this.ink(a.color) },
          signal,
        );
      case "circle":
        return this.drawStroke(this.claimId(a.id), this.loopAround(a.target), { color: this.ink(a.color ?? "red"), annotation: true }, signal);
      case "underline": {
        const b = this.boxOf(a.target);
        const y = b.y2 + 6;
        const pts = wavyLine({ x: b.x1 - 4, y }, { x: b.x2 + 4, y }, 1.5);
        return this.drawStroke(this.claimId(a.id), pts, { color: this.ink(a.color ?? "red"), annotation: true }, signal);
      }
      case "highlight": {
        const b = this.boxOf(a.target);
        const y = (b.y1 + b.y2) / 2;
        const pts = wavyLine({ x: b.x1 - 4, y }, { x: b.x2 + 4, y }, 0.8);
        return this.drawStroke(
          this.claimId(a.id),
          pts,
          { color: HIGHLIGHTER.color, strokeWidth: HIGHLIGHTER.strokeWidth, opacity: HIGHLIGHTER.opacity, annotation: true },
          signal,
        );
      }
      case "erase":
        for (const id of a.targets) this.elementById(id); // throws on unknown ids
        this.deleteElements(new Set(a.targets));
        return;
      case "clear":
        this.deleteElements(new Set(this.api.getSceneElements().map((el) => el.id)));
        // A fresh board: forget the sections too, so new lessons start from the middle again.
        this.sections.clear();
        this.currentSection = null;
        this.emit();
        return;
      case "focus": {
        if (!a.target) return this.overview(signal);
        const b = this.boxOf(a.target);
        const pad = 120;
        return this.moveCamera({ x: b.x1 - pad, y: b.y1 - pad, width: b.x2 - b.x1 + 2 * pad, height: b.y2 - b.y1 + 2 * pad }, signal);
      }
      case "wait":
        return sleep(a.ms, signal);
      default: {
        const unknown: never = a;
        throw new Error(`Unknown action: ${JSON.stringify(unknown)}`);
      }
    }
  }

  /** Translate section-local coordinates in an action to scene coordinates. */
  private toScene(a: AgentAction): AgentAction {
    const s = this.currentSection ? this.sections.get(this.currentSection) : undefined;
    if (!s) return a;
    const P = (p: Point): Point => ({ x: p.x + s.x, y: p.y + s.y });
    const T = (t: Target): Target => (typeof t === "string" ? t : P(t));
    switch (a.type) {
      case "move_cursor":
        return { ...a, to: T(a.to) };
      case "point_at":
        return { ...a, target: T(a.target) };
      case "circle":
        return { ...a, target: T(a.target) };
      case "draw_shape":
      case "write_text":
        return { ...a, ...P(a) };
      case "draw_arrow":
        return { ...a, from: T(a.from), to: T(a.to) };
      case "draw_freehand":
        return { ...a, points: a.points.map(([x, y]) => [x + s.x, y + s.y] as [number, number]) };
      default:
        return a;
    }
  }

  private async openSection(a: Extract<AgentAction, { type: "open_section" }>, signal: AbortSignal) {
    if (this.sections.has(a.id)) {
      this.currentSection = a.id;
      await this.travelTo(this.sections.get(a.id)!, signal);
      return a.id;
    }
    const occupied: Rect[] = [
      ...this.api.getSceneElements().map((el) => {
        const [x1, y1, x2, y2] = getCommonBounds([el]);
        return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
      }),
      // Reserve each section plus the title band above it.
      ...[...this.sections.values()].map((r) => ({ x: r.x, y: r.y - 60, width: r.width, height: r.height + 60 })),
    ];
    const v = this.viewport();
    const anchorId = a.near && this.sections.has(a.near) ? a.near : [...this.sections.keys()][0];
    const anchor = anchorId ? this.sections.get(anchorId) : undefined;
    const about = a.about ? this.api.getSceneElements().find((el) => el.id === a.about) : undefined;
    const focus = about ? this.resolvePoint(about.id) : undefined;
    // The link from `about` shouldn't cut through other drawings (bound labels and section frames aside).
    const obstacles: Rect[] = about
      ? this.api
          .getSceneElements()
          .filter((el) => el.id !== about.id && !(el.type === "text" && el.containerId === about.id) && !el.customData?.section)
          .map((el) => {
            const [x1, y1, x2, y2] = getCommonBounds([el]);
            return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
          })
      : [];
    const rect = placeSection(occupied, { x: v.x1, y: v.y1, width: v.x2 - v.x1, height: v.y2 - v.y1 }, anchor, focus, obstacles);
    this.sections.set(a.id, { ...rect, title: a.title, outlined: false });
    this.currentSection = a.id;

    // A single section needs no frame; from the second one on, every section gets one.
    if (this.sections.size >= 2) this.outlineSections(a.id);
    await this.travelTo(rect, signal);
    if (this.sections.size >= 2) this.outlineSections();
    // Tie the section to what it explains: an arrow from the section to that element.
    if (about && this.sections.get(a.id)!.outlined) {
      const link: AgentAction = { type: "draw_arrow", id: `section-${a.id}-link`, from: `section-${a.id}`, to: about.id, color: "blue" };
      const saved = this.currentSection;
      this.currentSection = null; // ids only, no coordinates to translate
      try {
        await this.drawArrow(link as Extract<AgentAction, { type: "draw_arrow" }>, signal);
      } finally {
        this.currentSection = saved;
      }
    }
    this.emit();
    return a.id;
  }

  /** Draw the dashed frame + title of every section not outlined yet (optionally skipping one). */
  private outlineSections(skip?: string) {
    const elements: ExcalidrawElement[] = [];
    for (const [id, s] of this.sections) {
      if (s.outlined || id === skip) continue;
      s.outlined = true;
      const style = { strokeColor: "#868e96", locked: true, customData: { section: id } };
      elements.push(
        ...this.build(
          {
            type: "rectangle",
            id: `section-${id}`,
            x: s.x,
            y: s.y,
            width: s.width,
            height: s.height,
            strokeStyle: "dashed",
            strokeWidth: 1,
            roughness: 0,
            opacity: 70,
            roundness: { type: 3 },
            ...style,
          },
          randomSeed(),
        ),
        ...this.build({ type: "text", id: `section-${id}-title`, x: s.x + 4, y: s.y - 48, text: s.title, fontSize: 28, ...style }, randomSeed()),
      );
    }
    if (elements.length) this.render(elements, CaptureUpdateAction.IMMEDIATELY);
  }

  /** Go somewhere on the board: the cursor glides there, and the view follows (if the human is following). */
  private async travelTo(r: Rect, signal: AbortSignal) {
    const cursorTo = { x: r.x + 60, y: r.y + 50 };
    if (!this.following) return this.moveCursor(cursorTo, signal);
    await this.waitForHumanIdle(signal);
    this.button = "down"; // grabbing the board
    try {
      await Promise.all([this.moveCamera(r, signal), this.moveCursor(cursorTo, signal)]);
    } finally {
      this.button = "up";
      this.render();
    }
  }

  /** Zoom out to everything the lesson covers. */
  private async overview(signal: AbortSignal) {
    const sections = [...this.sections.values()].map((s) => ({ x: s.x, y: s.y - 60, width: s.width, height: s.height + 60 }));
    const rect =
      union(sections) ??
      union(
        this.api.getSceneElements().map((el) => {
          const [x1, y1, x2, y2] = getCommonBounds([el]);
          return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
        }),
      );
    if (!rect) return;
    await this.waitForHumanIdle(signal);
    await this.moveCamera(rect, signal);
  }

  /**
   * Animate the human's view to fit `r` (only while they're following). Interpolates
   * the focal point and zoom (not raw scroll), so the move reads as one smooth glide.
   */
  private async moveCamera(r: Rect, signal: AbortSignal, maxZoom = 1, finishOnAbort = true) {
    if (!this.following || this.disposed) return;
    // A move in the action queue (to a section, the map) takes the camera over from the camera track.
    if (finishOnAbort) this.camera?.abort();
    const s = this.api.getAppState();
    const TOP = this.insets.top; // keep clear of the toolbar (and the module tray)
    const PAD = 40;
    const BOTTOM = this.insets.bottom; // …and of the ask bar + captions at the bottom
    const usableH = s.height - TOP - BOTTOM;
    const z1 = clamp(Math.min((s.width - 2 * PAD) / r.width, usableH / r.height), 0.1, maxZoom);
    const focal = { x: s.width / 2, y: TOP + usableH / 2 }; // screen point the target centres on
    const z0 = s.zoom.value;
    const p0 = { x: focal.x / z0 - s.scrollX, y: focal.y / z0 - s.scrollY }; // scene point under the focal point now
    const p1 = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    const screenDistance = dist(p0, p1) * Math.min(z0, z1);
    if (screenDistance < 2 && Math.abs(z1 - z0) < 0.01) return;
    const goal = { z: z1, c: p1 };
    this.cameraGoal = goal;
    const duration = clamp(450 + screenDistance * 0.25 + Math.abs(Math.log(z1 / z0)) * 300, 450, 1300) / this.speed;
    try {
      await tween(
        duration,
        (t) => {
          // The camera track stops where it is when a newer move (or an interruption) takes over: no jump.
          if (signal.aborted && !finishOnAbort) return;
          const e = easeInOut(t);
          const z = z0 * Math.pow(z1 / z0, e);
          const p = { x: lerp(p0.x, p1.x, e), y: lerp(p0.y, p1.y, e) };
          this.lastCameraWrite = performance.now();
          this.api.updateScene({
            appState: { scrollX: focal.x / z - p.x, scrollY: focal.y / z - p.y, zoom: { value: z as never } },
            captureUpdate: CaptureUpdateAction.NEVER,
          });
        },
        signal,
      );
    } finally {
      if (this.cameraGoal === goal) this.cameraGoal = null;
    }
    this.emit();
  }

  /** Never yank the view while the human is mid-stroke: wait (up to 10 s) for them to let go. */
  private async waitForHumanIdle(signal: AbortSignal) {
    for (let i = 0; i < 100 && this.humanPressed; i++) await sleep(100, signal);
  }

  private rectAround(p: Point): Rect {
    return { x: p.x - 400, y: p.y - 250, width: 800, height: 500 };
  }

  private async moveCursor(to: Point, signal: AbortSignal) {
    const from = { ...this.cursor };
    const d = dist(from, to);
    if (d < 1) return;
    const duration = clamp(150 + d * 0.6, 150, 800) / this.speed;
    await tween(
      duration,
      (t) => {
        const e = easeInOut(t);
        this.cursor = { x: lerp(from.x, to.x, e), y: lerp(from.y, to.y, e) };
        this.render();
      },
      signal,
    );
  }

  private async pointAt(target: Target, durationMs: number, signal: AbortSignal) {
    const box = typeof target === "string" ? this.boxOf(target) : null;
    const c = this.resolvePoint(target);
    const rx = box ? clamp((box.x2 - box.x1) * 0.3, 12, 60) : 16;
    const ry = box ? clamp((box.y2 - box.y1) * 0.3, 8, 40) : 12;
    this.keepInView(box ?? { x1: c.x - rx, y1: c.y - ry, x2: c.x + rx, y2: c.y + ry });
    await this.moveCursor({ x: c.x + rx, y: c.y }, signal);
    this.onInk?.(); // the glide is over: ink starts appearing now
    this.tool = "laser";
    this.button = "down";
    try {
      await tween(
        durationMs / this.speed,
        (t) => {
          const angle = t * Math.PI * 3; // one and a half loops
          this.cursor = { x: c.x + rx * Math.cos(angle), y: c.y + ry * Math.sin(angle) };
          this.render();
        },
        signal,
      );
    } finally {
      this.button = "up";
      this.render();
      this.tool = "pointer";
    }
  }

  private async drawShape(input: Extract<AgentAction, { type: "draw_shape" }>, signal: AbortSignal) {
    const id = this.claimId(input.id);
    // Drawing inside a labelled box whose centred label is in the way? Lift that label to the
    // top of its box rather than pushing the new shape out of the group it belongs to.
    if (this.layoutAssist) this.liftContainerLabels({ x: input.x, y: input.y, width: input.width, height: input.height }, id);
    const a = { ...input, ...this.clearSpot({ x: input.x, y: input.y, width: input.width, height: input.height }, "shape", id, !!input.label) };
    const seed = randomSeed();
    const stroke = this.ink(a.color);
    const build = (w: number, h: number, label?: string) =>
      this.build(
        {
          type: a.shape,
          id,
          x: a.x,
          y: a.y,
          width: Math.max(1, w),
          height: Math.max(1, h),
          strokeColor: stroke,
          strokeWidth: 2,
          // Shading is a soft solid tint, never hatching in the label's own colour: the label must stay readable.
          backgroundColor: a.fill ? this.tint(a.fill) : "transparent",
          fillStyle: "solid",
          ...(label ? { label: { text: label, strokeColor: stroke, ...labelIdOf(id) } } : {}),
        },
        seed,
      );

    this.keepInView({ x1: a.x, y1: a.y, x2: a.x + a.width, y2: a.y + a.height });
    await this.moveCursor({ x: a.x, y: a.y }, signal);
    this.onInk?.();
    let last = build(1, 1);
    this.button = "down";
    try {
      await tween(
        clamp(250 + (a.width + a.height) * 0.8, 300, 900) / this.speed,
        (t) => {
          const e = easeOut(t);
          this.cursor = { x: a.x + a.width * e, y: a.y + a.height * e };
          this.render((last = build(a.width * e, a.height * e)));
        },
        signal,
      );
      this.button = "up";
      if (a.label) {
        const label = a.label;
        await this.moveCursor({ x: a.x + a.width / 2, y: a.y + a.height / 2 }, signal);
        await this.typeOut(label, signal, (partial) => this.render((last = build(a.width, a.height, partial))));
      }
    } finally {
      this.button = "up";
      this.render(last, CaptureUpdateAction.IMMEDIATELY);
    }
    return id;
  }

  private async drawArrow(input: Extract<AgentAction, { type: "draw_arrow" }>, signal: AbortSignal) {
    const id = this.claimId(input.id);
    // An endpoint given as a point on (or right next to) something means that thing.
    let a = input;
    if (this.layoutAssist) {
      const from = this.snapTarget(input.from, id);
      const to = this.snapTarget(input.to, id);
      // Both ends snapping to the same thing would make a loop: keep the original points then.
      if (!(typeof from === "string" && from === to)) a = { ...input, from, to };
    }
    const seed = randomSeed();
    const stroke = this.ink(a.color);
    const lane = this.planLane(a.from, a.to, id);
    if (lane) this.relayoutSiblings(lane);
    const offset = lane?.offset ?? 0;
    const path = this.arrowPath(a.from, a.to, offset, id);
    const labelId = `${id}:label`;
    // Arrows sharing lanes (several messages between the same two things) keep their label ON
    // the line, sequence-diagram style — a label beside the line would sit in the next lane.
    const inLanes = !!lane && lane.siblings.length > 0;
    const freeLabel = this.layoutAssist && !inLanes;
    const meta = {
      fromId: typeof a.from === "string" ? a.from : null,
      toId: typeof a.to === "string" ? a.to : null,
      ...(lane ? { link: lane.link, from: a.from, to: a.to, offset } : {}),
      ...(a.label && freeLabel ? { labelId } : {}),
    };
    const p = path[0];
    const lengths = cumulative(path);
    const total = lengths[lengths.length - 1] || 1;
    /** The arrow drawn up to `fraction` of its length (bound label only in plain mode). */
    const build = (fraction: number, boundLabel?: string) => {
      const pts = slicePath(path, lengths, fraction * total);
      return this.build(
        {
          type: "arrow",
          id,
          x: p.x,
          y: p.y,
          points: pts.map((pt) => [pt.x - p.x, pt.y - p.y]).map(([x, y], i) => (i && !x && !y ? [0.5, 0.5] : [x, y])) as never,
          strokeColor: stroke,
          strokeWidth: 2,
          endArrowhead: "arrow",
          roundness: path.length > 2 ? { type: 2 } : null,
          customData: meta,
          ...(boundLabel ? { label: { text: boundLabel, strokeColor: stroke, ...labelIdOf(id) } } : {}),
        },
        seed,
      );
    };

    this.keepInView(boundsOf(path));
    await this.moveCursor(p, signal);
    this.onInk?.();
    let last = build(0);
    this.button = "down";
    try {
      await tween(
        clamp(200 + total * 0.9, 250, 1100) / this.speed,
        (t) => {
          const e = easeOut(t);
          this.cursor = pointAt(path, lengths, e * total);
          this.render((last = build(e)));
        },
        signal,
      );
      this.button = "up";
      if (a.label && !freeLabel) {
        const label = a.label;
        await this.moveCursor(pointAt(path, lengths, total / 2), signal);
        await this.typeOut(label, signal, (partial) => this.render((last = build(1, partial))));
      }
    } finally {
      this.button = "up";
      this.render(last, CaptureUpdateAction.IMMEDIATELY);
    }
    // Readable labels: written beside the line, in free space — never on top of other things.
    if (a.label && freeLabel) await this.writeArrowLabel(id, labelId, a.label, path, stroke, signal);
    return id;
  }

  /** Straight between the endpoints (lane-shifted), or routed around whatever is in the way. */
  private arrowPath(from: Target, to: Target, offset: number, selfId: string): Point[] {
    const { from: p, to: q } = this.arrowEndpoints(from, to, offset);
    if (!this.layoutAssist) return [p, q];
    const ends = [from, to].filter((t): t is string => typeof t === "string");
    const containers = new Set(this.containersOf(ends));
    const scene = this.sceneObstacles(new Set([selfId, `${selfId}:label`, ...ends]));
    const obstacles = scene.boxes.filter((b) => !b.id || !containers.has(b.id));
    const otherArrows = scene.lines;
    const direct = routeArrow(p, q, obstacles, otherArrows);
    if (direct.path.length === 2 && !direct.blocked) return direct.path;
    const log = (what: string) => this.layoutLog.push({ id: selfId, what });
    // Blocked: route centre-to-centre instead, then cut the path where it leaves each
    // endpoint's box. The arrow then leaves from whichever side faces the detour (top,
    // bottom…), instead of being boxed in by neighbours on the straight line.
    const { from: c1, to: c2 } = this.arrowEndpoints(from, to, offset, true);
    const routed = routeArrow(c1, c2, obstacles, otherArrows);
    if (routed.blocked) {
      log(direct.blocked ? "arrow: no clear route" : "arrow: curved");
      return direct.path;
    }
    const trimmed = this.trimToEdges(routed.path, from, to);
    log(trimmed.length >= 2 ? "arrow: routed around" : "arrow: trim failed");
    return trimmed.length >= 2 ? trimmed : direct.path;
  }

  /** A point target within ~24px of a shape/text becomes that element (the smallest, if nested). */
  private snapTarget(t: Target, selfId: string): Target {
    if (typeof t === "string") return t;
    const R = 24;
    let best: { id: string; area: number } | null = null;
    for (const el of this.api.getSceneElements()) {
      if (el.id === selfId || el.customData?.section || el.customData?.annotation || el.customData?.labelOf) continue;
      if (!["rectangle", "ellipse", "diamond", "text"].includes(el.type) || (el.type === "text" && el.containerId)) continue;
      const [x1, y1, x2, y2] = getCommonBounds([el]);
      if (t.x < x1 - R || t.x > x2 + R || t.y < y1 - R || t.y > y2 + R) continue;
      const area = (x2 - x1) * (y2 - y1);
      if (!best || area < best.area) best = { id: el.id, area };
    }
    if (best) this.layoutLog.push({ id: selfId, what: "arrow: snapped point to element" });
    return best ? best.id : t;
  }

  /**
   * Shapes that contain any of these elements (e.g. the "Vector store" box around its
   * chunks). An arrow to something inside a box has to cross that box's border — so
   * the box isn't an obstacle for it (its label still is).
   */
  private containersOf(ids: string[]): string[] {
    const boxes = ids.map((id) => this.boxOf(id));
    return this.api
      .getSceneElements()
      .filter((el) => ["rectangle", "ellipse", "diamond"].includes(el.type) && !ids.includes(el.id))
      .filter((el) => {
        const [x1, y1, x2, y2] = getCommonBounds([el]);
        return boxes.some((b) => b.x1 >= x1 - 2 && b.y1 >= y1 - 2 && b.x2 <= x2 + 2 && b.y2 <= y2 + 2);
      })
      .map((el) => el.id);
  }

  /** Drop the parts of `path` inside the start/end elements (plus a small gap). */
  private trimToEdges(path: Point[], from: Target, to: Target): Point[] {
    const GAP = 10;
    const box = (t: Target) => {
      if (typeof t !== "string") return null;
      const b = this.boxOf(t);
      return { x: b.x1 - GAP, y: b.y1 - GAP, width: b.x2 - b.x1 + 2 * GAP, height: b.y2 - b.y1 + 2 * GAP };
    };
    const inside = (pt: Point, r: Rect | null) => !!r && pt.x > r.x && pt.x < r.x + r.width && pt.y > r.y && pt.y < r.y + r.height;
    const a = box(from);
    const b = box(to);
    let i = 0;
    while (i < path.length - 1 && inside(path[i + 1], a)) i++;
    let j = path.length - 1;
    while (j > i + 1 && inside(path[j - 1], b)) j--;
    // Interpolate the exact crossing points so the arrow starts/ends on the gap boundary.
    const cross = (inPt: Point, outPt: Point, r: Rect | null): Point => {
      if (!r || !inside(inPt, r)) return inPt;
      let lo = 0;
      let hi = 1;
      for (let k = 0; k < 20; k++) {
        const mid = (lo + hi) / 2;
        if (inside({ x: lerp(inPt.x, outPt.x, mid), y: lerp(inPt.y, outPt.y, mid) }, r)) lo = mid;
        else hi = mid;
      }
      return { x: lerp(inPt.x, outPt.x, hi), y: lerp(inPt.y, outPt.y, hi) };
    };
    const start = cross(path[i], path[i + 1], a);
    const end = cross(path[j], path[j - 1], b);
    return [start, ...path.slice(i + 1, j), end];
  }

  private async writeArrowLabel(arrowId: string, labelId: string, text: string, path: Point[], color: string, signal: AbortSignal) {
    const seed = randomSeed();
    const fontSize = 16;
    const [measured] = this.build({ type: "text", id: labelId, x: 0, y: 0, text, fontSize }, seed);
    const spot = placeLabel(path, { width: measured.width, height: measured.height }, this.sceneObstacles(new Set([arrowId, labelId])), this.placementBounds());
    const build = (partial: string) =>
      this.build({ type: "text", id: labelId, x: spot.x, y: spot.y, text: partial, fontSize, strokeColor: color, customData: { labelOf: arrowId } }, seed);
    await this.moveCursor({ x: spot.x, y: spot.y + spot.height / 2 }, signal);
    let last = build(text.slice(0, 1));
    try {
      await this.typeOut(text, signal, (partial) => this.render((last = build(partial))));
    } finally {
      this.render(last, CaptureUpdateAction.IMMEDIATELY);
    }
  }

  /** Where new things may be placed: the current section, or the visible board below the toolbar. */
  private placementBounds(): Rect {
    const s = this.currentSection ? this.sections.get(this.currentSection) : undefined;
    if (s) return { x: s.x + 10, y: s.y + 10, width: s.width - 20, height: s.height - 20 };
    const v = this.viewport();
    return { x: v.x1 + 10, y: v.y1 + 80, width: v.x2 - v.x1 - 20, height: v.y2 - v.y1 - 90 };
  }

  /** Everything on the board that new content must not overlap (annotations and section frames aside). */
  private sceneObstacles(exclude: Set<string> = new Set()): Obstacles {
    const boxes: LayoutBox[] = [];
    const lines: Point[][] = [];
    for (const el of this.api.getSceneElements()) {
      if (exclude.has(el.id)) continue;
      if (el.type === "text" && el.containerId && exclude.has(el.containerId)) continue;
      if (el.customData?.section || el.customData?.annotation) continue;
      if (el.type === "arrow" || el.type === "line" || el.type === "freedraw") {
        lines.push(el.points.map(([x, y]) => ({ x: el.x + x, y: el.y + y })));
      } else if (["text", "rectangle", "ellipse", "diamond", "image"].includes(el.type)) {
        const [x1, y1, x2, y2] = getCommonBounds([el]);
        const kind = el.type !== "text" ? "shape" : el.containerId ? "label" : "text";
        boxes.push({ id: el.id, x: x1, y: y1, width: x2 - x1, height: y2 - y1, kind });
      }
    }
    return { boxes, lines };
  }

  /** Move the centred label of any box that contains `r` (and collides with it) to the top or bottom of that box. */
  private liftContainerLabels(r: Rect, selfId: string) {
    const all = this.api.getSceneElements();
    const lifted: ExcalidrawElement[] = [];
    for (const label of all) {
      if (label.type !== "text" || !label.containerId || label.containerId === selfId || label.verticalAlign !== "middle") continue;
      const box = all.find((e) => e.id === label.containerId);
      if (!box || box.type === "arrow") continue;
      const [x1, y1, x2, y2] = getCommonBounds([box]);
      const inside = r.x >= x1 && r.y >= y1 && r.x + r.width <= x2 && r.y + r.height <= y2;
      const hits = r.x < label.x + label.width && label.x < r.x + r.width && r.y < label.y + label.height && label.y < r.y + r.height;
      if (!inside || !hits) continue;
      // Move it to the top of its box — or the bottom — whichever is free (of the new shape too).
      const obs = this.sceneObstacles(new Set([label.id, box.id]));
      obs.boxes.push({ ...r, kind: "shape" });
      const spots = [
        { y: y1 + 8, verticalAlign: "top" },
        { y: y2 - label.height - 8, verticalAlign: "bottom" },
      ];
      const free = spots.find((sp) => !collides({ x: label.x, y: sp.y, width: label.width, height: label.height }, "text", obs, 2));
      if (!free) continue; // no room: the new shape gets nudged instead
      lifted.push({ ...label, verticalAlign: free.verticalAlign, y: free.y } as ExcalidrawElement);
      this.layoutLog.push({ id: box.id, what: `label: moved to ${free.verticalAlign} of its box` });
    }
    if (lifted.length) this.render(lifted, CaptureUpdateAction.IMMEDIATELY);
  }

  /** Nudge a new text/shape box to the nearest free spot (no-op when layout assist is off or it's already clear). */
  private clearSpot(r: Rect, kind: "text" | "shape", selfId: string, labelled = false): { x: number; y: number } {
    if (!this.layoutAssist) return { x: r.x, y: r.y };
    const obs = this.sceneObstacles(new Set([selfId]));
    // A labelled shape's label lands in its middle: existing text inside it would clash, so it may not contain any.
    if (labelled) obs.boxes = obs.boxes.map((b) => (b.kind === "text" ? { ...b, kind: "label" } : b));
    if (!collides(r, kind, obs)) return { x: r.x, y: r.y };
    const spot = findFreeSpot(r, kind, obs, this.placementBounds());
    this.layoutLog.push({ id: selfId, what: spot ? `${kind}: moved ${Math.round(Math.hypot(spot.x - r.x, spot.y - r.y))}px` : `${kind}: no free spot` });
    return spot ? { x: spot.x, y: spot.y } : { x: r.x, y: r.y };
  }

  private async writeText(input: Extract<AgentAction, { type: "write_text" }>, signal: AbortSignal) {
    const id = this.claimId(input.id);
    const seed = randomSeed();
    // Measure the real text, then make sure it lands on free space.
    const [measured] = this.build({ type: "text", id, x: input.x, y: input.y, text: input.text, fontSize: input.fontSize ?? 20 }, seed);
    const a = { ...input, ...this.clearSpot({ x: input.x, y: input.y, width: measured.width, height: measured.height }, "text", id) };
    const build = (text: string) =>
      this.build(
        { type: "text", id, x: a.x, y: a.y, text, fontSize: a.fontSize ?? 20, strokeColor: this.ink(a.color) },
        seed,
      );

    this.keepInView({ x1: a.x, y1: a.y, x2: a.x + measured.width, y2: a.y + measured.height });
    await this.moveCursor({ x: a.x, y: a.y + (a.fontSize ?? 20) * 0.6 }, signal);
    this.onInk?.();
    let last = build(a.text.slice(0, 1));
    try {
      await this.typeOut(a.text, signal, (partial) => {
        last = build(partial);
        const el = last[0];
        this.cursor = { x: a.x + el.width + 4, y: a.y + el.height - (a.fontSize ?? 20) * 0.4 };
        this.render(last);
      });
    } finally {
      this.render(last, CaptureUpdateAction.IMMEDIATELY);
    }
    return id;
  }

  /** A freehand pen stroke following `path`, drawn progressively under the cursor. */
  private async drawStroke(
    id: string,
    path: Point[],
    style: { color: string; strokeWidth?: number; opacity?: number; annotation?: boolean },
    signal: AbortSignal,
  ) {
    if (path.length === 0) throw new Error("A stroke needs at least one point");
    const pts = densify(path, 4);
    const seed = randomSeed();
    const build = (n: number) => [this.freedraw(id, pts.slice(0, Math.max(1, n)), style, seed)];

    this.keepInView(boundsOf(pts));
    await this.moveCursor(pts[0], signal);
    this.onInk?.();
    let last = build(1);
    this.button = "down";
    try {
      await tween(
        clamp(pathLength(pts) * 1.6, 250, 1600) / this.speed,
        (t) => {
          const n = Math.max(1, Math.ceil(t * pts.length));
          this.cursor = pts[n - 1];
          this.render((last = build(n)));
        },
        signal,
      );
    } finally {
      this.button = "up";
      this.render(last, CaptureUpdateAction.IMMEDIATELY);
    }
    return id;
  }

  /** Reveal `text` a character at a time. Whole strings take ~0.4–1.6s. */
  private typeOut(text: string, signal: AbortSignal, frame: (partial: string) => void) {
    const perChar = clamp(1400 / text.length, 18, 45);
    let shown = 0;
    return tween(
      (perChar * text.length) / this.speed,
      (t) => {
        const n = Math.max(1, Math.ceil(t * text.length));
        if (n !== shown) frame(text.slice(0, (shown = n)));
      },
      signal,
    );
  }

  /** Show the "Dudeling" name tag under the tutor's cursor (a Settings toggle). */
  get showNameTag() {
    return this.nameTag;
  }
  set showNameTag(on: boolean) {
    if (on === this.nameTag) return;
    this.nameTag = on;
    this.render();
  }

  /**
   * Push the agent's cursor (and optionally its changed elements) to the canvas.
   * Element changes are merged into the *current* scene, so human edits made in
   * the meantime are never overwritten.
   */
  private render(changed?: readonly ExcalidrawElement[], capture: CaptureUpdate = CaptureUpdateAction.EVENTUALLY) {
    if (this.disposed) return;
    this.emit();
    const collaborators = new Map<SocketId, Collaborator>([
      [
        AGENT_SOCKET,
        {
          id: AGENT_SOCKET,
          username: this.nameTag ? AGENT_NAME : "", // Excalidraw skips the label for an empty name
          color: { background: AGENT_COLOR, stroke: AGENT_COLOR },
          isSpeaking: this.speaking,
          button: this.button,
          pointer: { x: this.cursor.x, y: this.cursor.y, tool: this.tool, laserColor: AGENT_COLOR },
        },
      ],
    ]);

    if (!changed) {
      this.api.updateScene({ collaborators, captureUpdate: CaptureUpdateAction.NEVER });
      return;
    }

    const pending = new Map(changed.map((el) => [el.id, el]));
    const elements = this.api.getSceneElementsIncludingDeleted().map((el) => {
      const next = pending.get(el.id);
      if (!next) return el;
      pending.delete(el.id);
      return { ...next, version: el.version + 1, versionNonce: randomSeed() };
    });
    elements.push(...pending.values());
    this.api.updateScene({ elements, collaborators, captureUpdate: capture });
  }

  /** Build elements from a skeleton with a fixed id and seed (so the sketchy outline doesn't jitter between frames). */
  private build(skeleton: ExcalidrawElementSkeleton, seed: number): ExcalidrawElement[] {
    return convertToExcalidrawElements([skeleton], { regenerateIds: false }).map((el) => ({
      ...el,
      seed,
      customData: { ...el.customData, by: "agent" },
    }));
  }

  private freedraw(
    id: string,
    abs: Point[],
    style: { color: string; strokeWidth?: number; opacity?: number; annotation?: boolean },
    seed: number,
  ): ExcalidrawElement {
    const origin = abs[0];
    // Borrow a line element for all the base fields, then turn it into a pen stroke.
    const [base] = this.build(
      {
        type: "line",
        id,
        x: origin.x,
        y: origin.y,
        strokeColor: style.color,
        strokeWidth: style.strokeWidth ?? 1, // freehand renders ~4px per unit; 1 reads like a marker
        opacity: style.opacity ?? 100,
      },
      seed,
    );
    const { startBinding, endBinding, startArrowhead, endArrowhead, polygon, ...rest } = base as never as Record<
      string,
      unknown
    >;
    void [startBinding, endBinding, startArrowhead, endArrowhead, polygon];
    const points = abs.map((p) => [p.x - origin.x, p.y - origin.y] as [number, number]);
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    return {
      ...rest,
      type: "freedraw",
      // Annotations (circle/underline/highlight) overlap their target on purpose: layout ignores them.
      ...(style.annotation ? { customData: { ...(rest.customData as object), annotation: true } } : {}),
      points,
      pressures: [],
      simulatePressure: true,
      lastCommittedPoint: null,
      roundness: null,
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    } as never as ExcalidrawElement;
  }

  private deleteElements(ids: Set<string>) {
    if (ids.size === 0) return;
    const labelOf = (el: ExcalidrawElement) => el.type === "text" && el.containerId && ids.has(el.containerId);
    this.api.updateScene({
      elements: this.api
        .getSceneElementsIncludingDeleted()
        .map((el) =>
          ids.has(el.id) || labelOf(el)
            ? { ...el, isDeleted: true, version: el.version + 1, versionNonce: randomSeed() }
            : el,
        ),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  }

  private claimId(requested?: string): string {
    if (requested) {
      const existing = this.api.getSceneElements().find((el) => el.id === requested);
      if (existing && existing.customData?.by !== "agent") {
        throw new Error(`id "${requested}" belongs to an element the human drew`);
      }
      return requested; // reusing one of the agent's own ids redraws that element
    }
    const taken = new Set(this.api.getSceneElementsIncludingDeleted().map((el) => el.id));
    let id: string;
    do id = `agent-${++this.idCounter}`;
    while (taken.has(id));
    return id;
  }

  private elementById(id: string): ExcalidrawElement {
    const el = this.api.getSceneElements().find((e) => e.id === id);
    if (!el) throw new Error(`No element with id "${id}" on the board`);
    return el;
  }

  private boxOf(id: string): Box {
    const [x1, y1, x2, y2] = getCommonBounds([this.elementById(id)]);
    return { x1, y1, x2, y2 };
  }

  private resolvePoint(target: Target): Point {
    if (typeof target !== "string") return target;
    const b = this.boxOf(target);
    return { x: (b.x1 + b.x2) / 2, y: (b.y1 + b.y2) / 2 };
  }

  private viewport(): Box {
    const [x1, y1, x2, y2] = getVisibleSceneBounds(this.api.getAppState());
    return { x1, y1, x2, y2 };
  }

  /**
   * Several arrows between the same two elements (e.g. the messages of a protocol
   * exchange) are laid out as parallel lanes, centred on the line between them and
   * ordered top→bottom (or left→right) in the order they were drawn. Lanes are
   * shared by both directions. Returns null for arrows that don't join two elements.
   */
  private planLane(from: Target, to: Target, selfId: string) {
    if (typeof from !== "string" || typeof to !== "string") return null;
    const LANE = 48;
    const link = [from, to].sort().join("|");
    const siblings = this.api
      .getSceneElements()
      .filter((el) => el.type === "arrow" && el.id !== selfId && el.customData?.link === link);
    const count = siblings.length + 1;
    const perp = this.lanePerpendicular(from, to);
    // Keep every lane inside the smaller element so arrows still meet both of them.
    const extent = (id: string) => {
      const b = this.boxOf(id);
      return (Math.abs(perp.x) * (b.x2 - b.x1)) / 2 + (Math.abs(perp.y) * (b.y2 - b.y1)) / 2;
    };
    const half = Math.max(0, Math.min(extent(from), extent(to)) - 8);
    const spacing = count > 1 ? Math.min(LANE, (2 * half) / (count - 1)) : 0;
    const offsetOf = (i: number) => (i - (count - 1) / 2) * spacing;
    return {
      link,
      offset: offsetOf(count - 1),
      siblings: siblings.map((el, i) => ({ el, offset: offsetOf(i) })),
    };
  }

  /** Unit vector across the line joining two elements, pointing down (or right for vertical links). */
  private lanePerpendicular(from: string, to: string): Point {
    const a = this.resolvePoint(from);
    const b = this.resolvePoint(to);
    const len = dist(a, b) || 1;
    let perp = { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
    if (perp.y < -1e-6 || (Math.abs(perp.y) <= 1e-6 && perp.x < 0)) perp = { x: -perp.x, y: -perp.y };
    return perp;
  }

  /** Move already-drawn arrows of a link to their new lanes (labels move with them). */
  private relayoutSiblings(lane: NonNullable<ReturnType<BoardAgent["planLane"]>>) {
    const moved: ExcalidrawElement[] = [];
    const all = this.api.getSceneElements();
    for (const { el, offset } of lane.siblings) {
      const { from, to } = el.customData as { from: Target; to: Target };
      const free = all.find((t) => t.id === el.customData?.labelId);
      if (el.type !== "arrow" || (el.customData?.offset === offset && !free)) continue;
      const path = this.arrowPath(from, to, offset, el.id);
      // Joining a lane group: its label beside the line becomes a label on the line.
      if (free && free.type === "text") {
        const p0 = path[0];
        const { labelId: _dropped, ...meta } = el.customData as Record<string, unknown>;
        void _dropped;
        moved.push(
          ...this.build(
            {
              type: "arrow",
              id: el.id,
              x: p0.x,
              y: p0.y,
              points: path.map((pt) => [pt.x - p0.x, pt.y - p0.y]) as never,
              strokeColor: el.strokeColor,
              strokeWidth: el.strokeWidth,
              endArrowhead: "arrow",
              roundness: path.length > 2 ? { type: 2 } : null,
              customData: { ...meta, offset },
              label: { text: free.text, strokeColor: el.strokeColor, ...labelIdOf(el.id) },
            },
            el.seed,
          ),
        );
        continue;
      }
      const p = path[0];
      const xs = path.map((pt) => pt.x);
      const ys = path.map((pt) => pt.y);
      const last = el.points[el.points.length - 1];
      const oldMid = { x: el.x + last[0] / 2, y: el.y + last[1] / 2 };
      moved.push({
        ...el,
        x: p.x,
        y: p.y,
        points: path.map((pt) => [pt.x - p.x, pt.y - p.y]),
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys),
        roundness: path.length > 2 ? { type: 2 } : null,
        customData: { ...el.customData, offset },
      } as never);
      // Bound label (plain mode) follows the midpoint; a free label gets a fresh spot beside the new path.
      const bound = all.find((t) => t.type === "text" && t.containerId === el.id);
      if (bound) {
        const newMid = { x: (path[0].x + path[path.length - 1].x) / 2, y: (path[0].y + path[path.length - 1].y) / 2 };
        moved.push({ ...bound, x: bound.x + newMid.x - oldMid.x, y: bound.y + newMid.y - oldMid.y });
      }
      if (free) {
        const spot = placeLabel(path, { width: free.width, height: free.height }, this.sceneObstacles(new Set([el.id, free.id])), this.placementBounds());
        moved.push({ ...free, x: spot.x, y: spot.y });
      }
    }
    if (moved.length) this.render(moved);
  }

  /** Arrow start/end: centre-to-centre (shifted sideways by `offset`), trimmed to element edges. */
  private arrowEndpoints(from: Target, to: Target, offset: number, centresOnly = false): { from: Point; to: Point } {
    const GAP = 10;
    const perp =
      offset && typeof from === "string" && typeof to === "string" ? this.lanePerpendicular(from, to) : { x: 0, y: 0 };
    const ca = this.resolvePoint(from);
    const cb = this.resolvePoint(to);
    const a = { x: ca.x + perp.x * offset, y: ca.y + perp.y * offset };
    const b = { x: cb.x + perp.x * offset, y: cb.y + perp.y * offset };
    const len = dist(a, b) || 1;
    const dir = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
    /** Walk from `p` along `d` until leaving the target's bounding box, then add a gap. */
    const exit = (target: Target, p: Point, d: Point): Point => {
      if (typeof target !== "string") return p;
      const box = this.boxOf(target);
      const tx = d.x > 0 ? (box.x2 - p.x) / d.x : d.x < 0 ? (box.x1 - p.x) / d.x : Infinity;
      const ty = d.y > 0 ? (box.y2 - p.y) / d.y : d.y < 0 ? (box.y1 - p.y) / d.y : Infinity;
      const t = Math.max(0, Math.min(tx, ty)) + GAP;
      return { x: p.x + d.x * t, y: p.y + d.y * t };
    };
    if (centresOnly) return { from: a, to: b };
    return { from: exit(from, a, dir), to: exit(to, b, { x: -dir.x, y: -dir.y }) };
  }

  /** A slightly imperfect hand-drawn loop around a target. */
  private loopAround(target: Target): Point[] {
    const box =
      typeof target === "string"
        ? this.boxOf(target)
        : { x1: target.x - 20, y1: target.y - 20, x2: target.x + 20, y2: target.y + 20 };
    const c = { x: (box.x1 + box.x2) / 2, y: (box.y1 + box.y2) / 2 };
    const rx = (box.x2 - box.x1) / 2 + 16;
    const ry = (box.y2 - box.y1) / 2 + 14;
    const start = -2.3;
    const pts: Point[] = [];
    const steps = 72;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const angle = start + t * Math.PI * 2 * 1.08; // overshoot a little, like a real pen
      const wobble = 1 + 0.03 * Math.sin(t * 9) + 0.04 * t;
      pts.push({ x: c.x + rx * wobble * Math.cos(angle), y: c.y + ry * wobble * Math.sin(angle) });
    }
    return pts;
  }

  /** A pale background tint for a named colour (Excalidraw's own light fills; they invert well in dark mode). */
  private tint(color: InkColor): string {
    const tints: Record<string, string> = { ink: "#e9ecef", red: "#ffc9c9", blue: "#a5d8ff", green: "#b2f2bb", orange: "#ffec99" };
    return tints[color.toLowerCase()] ?? tints.ink;
  }

  private ink(color?: InkColor): string {
    if (!color) return PEN_COLORS[0].value;
    const named = PEN_COLORS.find((c) => c.name.toLowerCase() === color.toLowerCase());
    return named ? named.value : color;
  }
}

/**
 * A stable id for a shape's label, so re-rendering the label while it's being typed
 * updates one text element instead of spawning a new one each frame. Excalidraw's
 * skeleton types omit `id` on labels, but `bindTextToContainer` passes it through.
 */
const labelIdOf = (ownerId: string) => ({ id: `${ownerId}:label` }) as object;

function cumulative(path: Point[]): number[] {
  const out = [0];
  for (let i = 1; i < path.length; i++) out.push(out[i - 1] + dist(path[i - 1], path[i]));
  return out;
}

function pointAt(path: Point[], lengths: number[], at: number): Point {
  if (path.length === 1) return path[0];
  let i = 1;
  while (i < path.length - 1 && lengths[i] < at) i++;
  const seg = lengths[i] - lengths[i - 1] || 1;
  const t = clamp((at - lengths[i - 1]) / seg, 0, 1);
  return { x: lerp(path[i - 1].x, path[i].x, t), y: lerp(path[i - 1].y, path[i].y, t) };
}

/** The part of `path` up to length `at` (always at least two points). */
function slicePath(path: Point[], lengths: number[], at: number): Point[] {
  const out = [path[0]];
  for (let i = 1; i < path.length && lengths[i] < at; i++) out.push(path[i]);
  out.push(pointAt(path, lengths, at));
  return out;
}

function densify(path: Point[], maxStep: number): Point[] {
  const out: Point[] = [path[0]];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const n = Math.max(1, Math.ceil(dist(a, b) / maxStep));
    for (let k = 1; k <= n; k++) out.push({ x: lerp(a.x, b.x, k / n), y: lerp(a.y, b.y, k / n) });
  }
  return out;
}

function pathLength(path: Point[]): number {
  let len = 0;
  for (let i = 1; i < path.length; i++) len += dist(path[i - 1], path[i]);
  return len;
}

function wavyLine(from: Point, to: Point, amplitude: number): Point[] {
  const pts: Point[] = [];
  const steps = Math.max(8, Math.ceil(dist(from, to) / 6));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    pts.push({ x: lerp(from.x, to.x, t), y: lerp(from.y, to.y, t) + amplitude * Math.sin(t * Math.PI * 3) });
  }
  return pts;
}
