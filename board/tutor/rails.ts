/**
 * Rails: make whatever the model returned safe and tidy before it touches the board.
 *
 * 1. parseLesson   – pull a lesson out of the raw reply (tolerates chatter / code fences).
 * 2. repairLesson  – validate every action and fix what can be fixed deterministically:
 *                    unknown types, bad fields, duplicate/missing ids, references to things
 *                    not drawn yet, oversized text, off-screen positions, overlaps.
 * 3. needsRetry    – is the result too broken to show? Then ask the model again with
 *                    `retryMessage(issues)` describing exactly what was wrong.
 */
import type { AgentAction, InkColor, Target } from "../agent/actions.ts";
import { TUTOR_ACTION_TYPES, type Lesson, type LessonStep, type Pronunciation } from "./lesson.ts";
import { SECTION_SAFE_AREA } from "../agent/sections.ts";
import { safeArea, type Viewport } from "./viewport.ts";

type Box = { x1: number; y1: number; x2: number; y2: number };
type Point = { x: number; y: number };

const CHAR_W = 0.55; // average glyph width / font size for the hand-drawn font
const LINE_H = 1.25;
const LABEL_FONT = 20; // Excalidraw's default label size
const MAX_STEPS = 8;
const MAX_ACTIONS = 40; // prompt allows 7 steps × 5 actions = 35
const MAX_LINE_CHARS = 60;
const GAP = 2; // only real overlaps count: tight layouts (array cells 8px apart) are deliberate
const COLORS = new Set(["ink", "red", "blue", "green", "orange"]);

export interface RepairResult {
  lesson: Lesson;
  issues: string[];
  /** Actions received / actions dropped as unusable. */
  total: number;
  dropped: number;
  /** Actions kept but changed (moved, resized, wrapped, renamed…). */
  repaired: number;
}

/**
 * What can be read from a reply that's still arriving: the title, if complete, and every step
 * object in "steps" that has fully arrived (raw, unrepaired). Tolerates code fences and prose before
 * the JSON. Steps that are still being written are not included.
 */
export function partialLesson(text: string): { title?: string; steps: Record<string, unknown>[] } {
  const steps: Record<string, unknown>[] = [];
  const start = text.indexOf("{");
  if (start < 0) return { steps };
  const titleMatch = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text.slice(start));
  let title: string | undefined;
  if (titleMatch) {
    try {
      title = JSON.parse(`"${titleMatch[1]}"`);
    } catch {
      /* odd escape — skip */
    }
  }
  const key = /"steps"\s*:\s*\[/.exec(text.slice(start));
  if (!key) return { title, steps };
  let i = start + key.index + key[0].length;
  // Scan the array: each top-level {...} is a step; strings may contain braces.
  let depth = 0;
  let inString = false;
  let escaped = false;
  let from = -1;
  for (; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") {
      if (depth++ === 0) from = i;
    } else if (c === "}") {
      if (--depth === 0 && from >= 0) {
        try {
          const step = JSON.parse(text.slice(from, i + 1));
          if (step && typeof step === "object") steps.push(step);
        } catch {
          break;
        }
        from = -1;
      }
    } else if (c === "]" && depth === 0) break; // end of the steps array
  }
  return { title, steps };
}

/** The optional "pronounce" list: [{term, say}] (an object map is accepted too). Junk is dropped. */
export function parsePronounce(raw: unknown): Pronunciation[] | undefined {
  const pairs: [unknown, unknown][] = Array.isArray(raw)
    ? raw.map((p) => (p && typeof p === "object" ? [(p as any).term, (p as any).say] : [null, null]))
    : raw && typeof raw === "object"
      ? Object.entries(raw)
      : [];
  const out = pairs
    .filter((p): p is [string, string] => typeof p[0] === "string" && typeof p[1] === "string")
    .map(([term, say]) => ({ term: term.trim(), say: say.trim() }))
    .filter((p) => p.term && p.say && p.term.length <= 40 && p.say.length <= 80 && p.term.toLowerCase() !== p.say.toLowerCase())
    .slice(0, 20);
  return out.length ? out : undefined;
}

export function parseLesson(content: string): { lesson?: Lesson; error?: string } {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end < start) return { error: "The reply contained no JSON object." };
  let json: unknown;
  try {
    json = JSON.parse(content.slice(start, end + 1));
  } catch (e) {
    return { error: `The reply was not valid JSON (${(e as Error).message.slice(0, 80)}).` };
  }
  const obj = json as Record<string, unknown>;
  if (Array.isArray(obj.steps)) {
    const steps = obj.steps.filter((s): s is Record<string, unknown> => !!s && typeof s === "object");
    return {
      lesson: {
        title: typeof obj.title === "string" ? obj.title : "",
        steps: steps.map((s) => ({
          say: typeof s.say === "string" ? s.say : "",
          actions: Array.isArray(s.actions) ? (s.actions as AgentAction[]) : [],
        })),
        ...(parsePronounce(obj.pronounce) ? { pronounce: parsePronounce(obj.pronounce) } : {}),
      },
    };
  }
  // Older flat format: {narration: [], actions: []}
  if (Array.isArray(obj.actions)) {
    const narration = Array.isArray(obj.narration) ? obj.narration.filter((n) => typeof n === "string") : [];
    return { lesson: { title: "", steps: [{ say: narration.join(" "), actions: obj.actions as AgentAction[] }] } };
  }
  return { error: 'The JSON had no "steps" array.' };
}

/**
 * `bounds` is where drawing is allowed: a section's local safe area
 * (SECTION_SAFE_AREA, the default for tutor lessons) or a screen viewport (legacy
 * single-screen lessons; its toolbar band and margins are excluded).
 * `limits` defaults to one generated lesson's size; a live board repairs everything on it so far and needs more.
 */
export function repairLesson(
  input: Lesson,
  bounds: Viewport | Box = SECTION_SAFE_AREA,
  knownIds: Iterable<string> = [],
  limits: { steps: number; actions: number } = { steps: MAX_STEPS, actions: MAX_ACTIONS },
): RepairResult {
  const area: Box = "width" in bounds ? safeArea(bounds) : { ...bounds };
  const issues: string[] = [];
  // ids drawn so far, in order — seeded with things already on the board that may be referenced (pointed at)
  const drawn = new Set<string>(knownIds);
  const kindOf = new Map<string, string>(); // id → action type that drew it
  const placed: { id: string; box: Box }[] = []; // solid things (shapes, text) for overlap checks
  let total = 0;
  let dropped = 0;
  let repaired = 0;
  let autoId = 0;

  const fresh = (base: string) => {
    let id = base;
    while (drawn.has(id)) id = `${base}-${++autoId}`;
    return id;
  };

  const steps: LessonStep[] = [];
  const inputSteps = input.steps.slice(0, limits.steps);
  if (input.steps.length > limits.steps) issues.push(`Too many steps (${input.steps.length}); kept the first ${limits.steps}.`);

  for (const [si, step] of inputSteps.entries()) {
    const actions: AgentAction[] = [];
    const keptFrom: number[] = []; // original index of each kept action
    for (const [ai, raw] of (step.actions ?? []).entries()) {
      total++;
      const where = `step ${si + 1} action ${ai + 1}`;
      if (total > limits.actions) {
        dropped++;
        if (total === limits.actions + 1) issues.push(`More than ${limits.actions} actions; the rest were dropped.`);
        continue;
      }
      const result = repairAction(raw, where);
      if (typeof result === "string") {
        issues.push(result);
        dropped++;
        continue;
      }
      if (result.changed) repaired++;
      actions.push(result.action);
      keptFrom.push(ai);
    }
    const { text: say, at } = parseCues(typeof step.say === "string" ? step.say : "");
    steps.push({ say: limitSentences(say, 900), actions, cues: cueTimes(actions.length, keptFrom.map((i) => at.get(i + 1))) });
  }

  const drawable = steps.flatMap((s) => s.actions).filter((a) => a.type !== "wait").length;
  if (drawable === 0) issues.push("Nothing would be drawn: the lesson has no usable actions.");

  const title = input.title?.trim() || firstText(steps) || "Lesson";
  return { lesson: { title, steps, ...(input.pronounce?.length ? { pronounce: input.pronounce } : {}) }, issues, total, dropped, repaired };

  function repairAction(raw: unknown, where: string): { action: AgentAction; changed: boolean } | string {
    if (!raw || typeof raw !== "object") return `${where}: not an object.`;
    // null means "not given" (strict structured output sends optional fields as null).
    const a = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== null)) as Record<string, unknown>;
    const type = a.type as string;
    if (!(TUTOR_ACTION_TYPES as readonly string[]).includes(type)) return `${where}: unknown action type "${String(type)}".`;
    let changed = false;
    const mark = <T>(v: T) => ((changed = true), v);

    const ink = (c: unknown): InkColor | undefined => {
      if (c === undefined) return undefined;
      if (typeof c === "string" && COLORS.has(c)) return c as InkColor;
      return mark("ink");
    };
    /**
     * Pick the element id. Reusing an id with the same action type is a deliberate
     * redraw (e.g. recolouring the discarded half of an array) — the agent replaces
     * the element in place, so its old box is released. Reusing an id for a
     * different kind of thing is a mistake and gets a fresh id.
     */
    const claimId = (): string => {
      let id = typeof a.id === "string" && a.id.trim() ? a.id.trim() : mark(`${type.replace("draw_", "")}-${autoId + 1}`);
      if (id.startsWith("section-")) id = mark(`el-${id}`); // reserved for the agent's section frames
      if (drawn.has(id)) {
        if (kindOf.get(id) === type) {
          const i = placed.findIndex((p) => p.id === id);
          if (i >= 0) placed.splice(i, 1);
        } else {
          id = mark(fresh(id));
        }
      }
      drawn.add(id);
      kindOf.set(id, type);
      return id;
    };
    const target = (t: unknown, field: string, allowPoint: boolean): Target | string => {
      if (typeof t === "string") return drawn.has(t) ? t : `${where} (${type}): "${field}" refers to "${t}", which was not drawn before it.`;
      if (allowPoint && isPoint(t)) {
        const p = clampPoint(t);
        if (p.x !== t.x || p.y !== t.y) changed = true;
        return p;
      }
      return `${where} (${type}): "${field}" must be ${allowPoint ? "an id or an {x,y} point" : "the id of something already drawn"}.`;
    };

    switch (type) {
      case "write_text": {
        if (typeof a.text !== "string" || !a.text.trim()) return `${where} (write_text): missing "text".`;
        if (!isNum(a.x) || !isNum(a.y)) return `${where} (write_text): "x" and "y" must be numbers.`;
        let fontSize = isNum(a.fontSize) ? a.fontSize : 20;
        if (fontSize < 14 || fontSize > 40) fontSize = mark(clamp(fontSize, 14, 40));
        const areaW = area.x2 - area.x1;
        // Wrap long lines; shrink the font if even one word can't fit.
        let text = a.text.trim();
        const maxChars = Math.min(MAX_LINE_CHARS, Math.floor(areaW / (fontSize * CHAR_W)));
        const wrapped = wrap(text, maxChars);
        if (wrapped !== text) text = mark(wrapped);
        const id = claimId();
        let box = textBox(a.x, a.y, text, fontSize);
        box = settle(box, `"${text.slice(0, 20)}"`);
        if (box.x1 !== a.x || box.y1 !== a.y) changed = true;
        placed.push({ id, box });
        return {
          action: { type: "write_text", id, x: round(box.x1), y: round(box.y1), text, fontSize, ...(a.color !== undefined ? { color: ink(a.color) } : {}) },
          changed,
        };
      }

      case "draw_shape": {
        const shape = a.shape === "rectangle" || a.shape === "ellipse" || a.shape === "diamond" ? a.shape : mark("rectangle" as const);
        if (!isNum(a.x) || !isNum(a.y)) return `${where} (draw_shape): "x" and "y" must be numbers.`;
        let w = isNum(a.width) ? a.width : mark(180);
        let h = isNum(a.height) ? a.height : mark(80);
        if (w < 40 || w > 600) w = mark(clamp(w, 40, 600));
        if (h < 30 || h > 420) h = mark(clamp(h, 30, 420));
        let label = typeof a.label === "string" ? a.label.trim() : undefined;
        if (label) {
          // Make sure the label fits: wrap to the shape's inner width, grow the shape if needed.
          // Usable text width inside the outline: diamonds lose the most to their slanted sides.
          const fill = shape === "rectangle" ? 0.85 : shape === "ellipse" ? 0.65 : 0.5;
          const inner = fill * w;
          const maxChars = Math.max(6, Math.floor(inner / (LABEL_FONT * CHAR_W)));
          const wrapped = wrap(label, maxChars);
          if (wrapped !== label) label = mark(wrapped);
          const lines = label.split("\n");
          const needW = (Math.max(...lines.map((l) => l.length)) * LABEL_FONT * CHAR_W) / fill;
          const needH = (lines.length * LABEL_FONT * LINE_H) / (shape === "rectangle" ? 0.75 : shape === "ellipse" ? 0.6 : 0.5);
          if (needW > w) w = mark(Math.min(600, Math.ceil(needW)));
          if (needH > h) h = mark(Math.min(420, Math.ceil(needH)));
        }
        const id = claimId();
        let box = settle({ x1: a.x, y1: a.y, x2: a.x + w, y2: a.y + h }, `shape "${String(a.id ?? label ?? "")}"`);
        if (box.x1 !== a.x || box.y1 !== a.y) changed = true;
        placed.push({ id, box });
        return {
          action: {
            type: "draw_shape",
            id,
            shape,
            x: round(box.x1),
            y: round(box.y1),
            width: round(box.x2 - box.x1),
            height: round(box.y2 - box.y1),
            ...(label ? { label } : {}),
            ...(a.color !== undefined ? { color: ink(a.color) } : {}),
            ...(a.fill !== undefined ? { fill: ink(a.fill) } : {}),
          },
          changed,
        };
      }

      case "draw_arrow": {
        const from = target(a.from, "from", true);
        if (typeof from === "string" && !drawn.has(from)) return from;
        const to = target(a.to, "to", true);
        if (typeof to === "string" && !drawn.has(to)) return to;
        if (typeof from === "string" && from === to) return `${where} (draw_arrow): "from" and "to" are the same element.`;
        const id = claimId();
        let label = typeof a.label === "string" ? a.label.trim() : undefined;
        if (label && label.length > 40) label = mark(label.slice(0, 39) + "…");
        return {
          action: { type: "draw_arrow", id, from, to, ...(label ? { label } : {}), ...(a.color !== undefined ? { color: ink(a.color) } : {}) },
          changed,
        };
      }

      case "draw_freehand": {
        const pts = Array.isArray(a.points)
          ? a.points.filter((p): p is [number, number] => Array.isArray(p) && isNum(p[0]) && isNum(p[1]))
          : [];
        if (pts.length < 2) return `${where} (draw_freehand): needs at least 2 [x,y] points.`;
        if (pts.length !== (a.points as unknown[]).length) changed = true;
        const clamped = pts.slice(0, 80).map(([x, y]) => {
          const p = clampPoint({ x, y });
          if (p.x !== x || p.y !== y) changed = true;
          return [round(p.x), round(p.y)] as [number, number];
        });
        const id = claimId();
        return { action: { type: "draw_freehand", id, points: clamped, ...(a.color !== undefined ? { color: ink(a.color) } : {}) }, changed };
      }

      case "point_at": {
        const t = target(a.target, "target", true);
        if (typeof t === "string" && !drawn.has(t)) return t;
        return { action: { type: "point_at", target: t }, changed };
      }

      case "circle":
      case "underline":
      case "highlight": {
        // The agent can circle a bare point; underline/highlight need an element's bounds.
        const t = target(a.target, "target", type === "circle");
        if (type === "circle" && isPoint(t)) {
          return { action: { type, target: t, ...(a.color !== undefined ? { color: ink(a.color) } : {}) }, changed };
        }
        if (typeof t !== "string" || !drawn.has(t)) return typeof t === "string" ? t : `${where} (${type}): bad target.`;
        const color = type === "highlight" ? undefined : a.color !== undefined ? ink(a.color) : undefined;
        return { action: { type, target: t, ...(color ? { color } : {}) } as AgentAction, changed };
      }

      case "wait": {
        let ms = isNum(a.ms) ? a.ms : mark(500);
        if (ms < 0 || ms > 1500) ms = mark(clamp(ms, 0, 1500));
        return { action: { type: "wait", ms }, changed };
      }
    }
    return `${where}: unsupported action "${type}".`;
  }

  function clampPoint(p: Point): Point {
    return { x: clamp(p.x, area.x1, area.x2), y: clamp(p.y, area.y1, area.y2) };
  }

  /** Move a box inside the safe area, then nudge it to the nearest free spot if it overlaps anything. */
  function settle(box: Box, what: string): Box {
    let b = inside(box);
    if (!collides(b)) return b;
    // Search outward for the nearest free position, preferring below and to the right.
    const dirs = [
      [0, 1],
      [1, 0],
      [0, -1],
      [-1, 0],
      [1, 1],
      [-1, 1],
      [1, -1],
      [-1, -1],
    ];
    for (let r = 20; r <= 480; r += 20)
      for (const [dx, dy] of dirs) {
        const c = inside({ x1: b.x1 + dx * r, y1: b.y1 + dy * r, x2: b.x2 + dx * r, y2: b.y2 + dy * r });
        if (!collides(c)) return c;
      }
    issues.push(`${what} overlaps other content and no free space was found.`);
    return b;
  }

  function inside(b: Box): Box {
    const w = b.x2 - b.x1;
    const h = b.y2 - b.y1;
    const x1 = clamp(b.x1, area.x1, Math.max(area.x1, area.x2 - w));
    const y1 = clamp(b.y1, area.y1, Math.max(area.y1, area.y2 - h));
    return { x1, y1, x2: x1 + w, y2: y1 + h };
  }

  /** Partial overlaps (with a small gap) collide; full containment (text in a shape, nested shapes) is allowed. */
  function collides(b: Box): boolean {
    return placed.some(({ box: p }) => {
      const touching = b.x1 < p.x2 + GAP && p.x1 < b.x2 + GAP && b.y1 < p.y2 + GAP && p.y1 < b.y2 + GAP;
      if (!touching) return false;
      return !(contains(p, b) || contains(b, p));
    });
  }
}

/** Too broken to show as-is: ask the model again. */
export function needsRetry(r: RepairResult | null): boolean {
  if (!r) return true;
  const drawable = r.lesson.steps.flatMap((s) => s.actions).filter((a) => a.type !== "wait").length;
  return drawable === 0 || (r.total > 0 && r.dropped / r.total > 0.25);
}

export function retryMessage(problems: string[]): string {
  return `Your lesson could not be drawn as-is. Problems:\n${problems
    .slice(0, 12)
    .map((p) => `- ${p}`)
    .join("\n")}\nReturn the complete corrected lesson as JSON, following every rule in the instructions.`;
}

/** Flatten a lesson to the agent's action list. */
export const lessonActions = (lesson: Lesson): AgentAction[] => lesson.steps.flatMap((s) => s.actions);

/** Keep a spoken line under `max` characters without ever cutting a sentence (or word) in half. */
export function limitSentences(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  if (end > max * 0.4) return cut.slice(0, end + 1);
  return cut.slice(0, cut.lastIndexOf(" ")).replace(/[,;:\-–—]+$/, "") + "…";
}

/**
 * Pull the [n] sync markers out of a narration line. Returns the clean text (what is
 * spoken and shown) and, per action number, where in it the marker sat (0..1).
 */
export function parseCues(raw: string): { text: string; at: Map<number, number> } {
  const marks: { n: number; offset: number }[] = [];
  let text = "";
  let last = 0;
  for (const m of raw.matchAll(/\s*\[(\d{1,2})\]\s*/g)) {
    text += raw.slice(last, m.index);
    // Keep one space where the marker sat between words; none at the start/end or before punctuation.
    const after = raw.slice(m.index! + m[0].length);
    if (text && after && !/^[,.;:!?)]/.test(after)) text += " ";
    marks.push({ n: Number(m[1]), offset: text.length });
    last = m.index! + m[0].length;
  }
  text = (text + raw.slice(last)).replace(/\s{2,}/g, " ").trim();
  const at = new Map<number, number>();
  for (const { n, offset } of marks) if (!at.has(n)) at.set(n, text.length ? Math.min(1, offset / text.length) : 0);
  return { text, at };
}

/**
 * Start times (0..1) for `count` actions, given the positions of whichever had a marker.
 * Unmarked actions follow the previous one; with no markers at all, they're spread evenly.
 * Always non-decreasing: actions run in order.
 */
export function cueTimes(count: number, marked: (number | undefined)[]): number[] {
  if (!count) return [];
  const any = marked.some((v) => v !== undefined);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const own = marked[i];
    const fallback = any ? (out[i - 1] ?? 0) : (i / count) * 0.85;
    out.push(Math.max(own ?? fallback, out[i - 1] ?? 0));
  }
  return out;
}

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
function isPoint(v: unknown): v is Point {
  return !!v && typeof v === "object" && isNum((v as Point).x) && isNum((v as Point).y);
}
function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}
function round(v: number) {
  return Math.round(v);
}
function contains(a: Box, b: Box) {
  return b.x1 >= a.x1 - 2 && b.y1 >= a.y1 - 2 && b.x2 <= a.x2 + 2 && b.y2 <= a.y2 + 2;
}
function textBox(x: number, y: number, text: string, fontSize: number): Box {
  const lines = text.split("\n");
  const w = Math.max(...lines.map((l) => l.length)) * fontSize * CHAR_W;
  return { x1: x, y1: y, x2: x + w, y2: y + lines.length * fontSize * LINE_H };
}
/** Greedy word wrap to `maxChars` per line (keeps existing line breaks). */
function wrap(text: string, maxChars: number): string {
  return text
    .split("\n")
    .map((line) => {
      if (line.length <= maxChars) return line;
      const out: string[] = [];
      let cur = "";
      for (const word of line.split(/\s+/)) {
        if (!cur) cur = word;
        else if ((cur + " " + word).length <= maxChars) cur += " " + word;
        else {
          out.push(cur);
          cur = word;
        }
      }
      if (cur) out.push(cur);
      return out.join("\n");
    })
    .join("\n");
}
function firstText(steps: LessonStep[]): string | undefined {
  for (const s of steps) for (const a of s.actions) if (a.type === "write_text") return a.text;
  return undefined;
}
