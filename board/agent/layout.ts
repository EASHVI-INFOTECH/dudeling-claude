/**
 * Collision-aware layout for the agent: nothing it draws should cut through or sit on
 * top of something else.
 *
 * - routeArrow    straight if the way is clear; otherwise the gentlest single-bend
 *                 curve that clears everything; otherwise a path around obstacles
 *                 found on a grid (A*), pulled taut and smoothed.
 * - findFreeSpot  nearest position for a box (text, shape) that doesn't overlap boxes
 *                 or cross lines — containment (text inside a shape) is allowed.
 * - placeLabel    a spot for an arrow's label beside the line, clear of everything.
 *
 * Pure geometry (no Excalidraw), so it can be tested on its own.
 */
import { segmentHitsRect, type Rect } from "./sections.ts";

export type Point = { x: number; y: number };
/** "label" = the label inside some shape: nothing may overlap it, not even something nested in that shape. */
export type Box = Rect & { kind?: "text" | "shape" | "label"; id?: string };

export const inflate = (r: Rect, by: number): Rect => ({ x: r.x - by, y: r.y - by, width: r.width + 2 * by, height: r.height + 2 * by });
const contains = (outer: Rect, inner: Rect, slack = 2) =>
  inner.x >= outer.x - slack &&
  inner.y >= outer.y - slack &&
  inner.x + inner.width <= outer.x + outer.width + slack &&
  inner.y + inner.height <= outer.y + outer.height + slack;
const overlaps = (a: Rect, b: Rect, gap = 0) =>
  a.x < b.x + b.width + gap && b.x < a.x + a.width + gap && a.y < b.y + b.height + gap && b.y < a.y + a.height + gap;

export function polylineHitsRect(points: Point[], r: Rect): boolean {
  for (let i = 1; i < points.length; i++) if (segmentHitsRect(points[i - 1], points[i], r)) return true;
  return false;
}

/** Clearance kept between an arrow and anything it passes. */
const CLEARANCE = 12;

/**
 * A path from p to q that avoids `obstacles` (already excluding the arrow's own
 * endpoints). Returns a polyline; more than two points means it bends.
 * `blocked` is true when no clear path was found (the straight line is returned).
 */
export function routeArrow(p: Point, q: Point, obstacles: Rect[], avoid: Point[][] = []): { path: Point[]; blocked: boolean } {
  const blockers = obstacles.map((o) => inflate(o, CLEARANCE));
  // Crossing another arrow is fine; running along one (so the two read as one line) is not.
  const clear = (path: Point[]) => !blockers.some((b) => polylineHitsRect(path, b)) && !runsAlong(path, avoid);
  const straight = [p, q];
  if (clear(straight)) return { path: straight, blocked: false };

  // 1. One smooth bend: a curve through a point pushed sideways from the midpoint.
  const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
  const n = { x: -(q.y - p.y) / len, y: (q.x - p.x) / len };
  const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
  for (const d of [50, 90, 140, 200, 270, 350, 450]) {
    for (const sign of [1, -1]) {
      const through = { x: mid.x + n.x * d * sign, y: mid.y + n.y * d * sign };
      const curve = quadraticThrough(p, through, q, 24);
      if (clear(curve)) return { path: curve, blocked: false };
    }
  }

  // 2. Around the obstacles on a grid.
  const grid = gridRoute(p, q, blockers, avoid);
  if (grid && clear(grid)) return { path: grid, blocked: false };
  return { path: straight, blocked: true };
}

/** Points along the quadratic Bézier from a to b that passes through `through` at t = 0.5. */
function quadraticThrough(a: Point, through: Point, b: Point, samples: number): Point[] {
  const c = { x: 2 * through.x - (a.x + b.x) / 2, y: 2 * through.y - (a.y + b.y) / 2 };
  const pts: Point[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const u = 1 - t;
    pts.push({ x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y });
  }
  return pts;
}

/** A* on a 16px grid around the obstacles, then string-pulled to a few waypoints and densified. */
function gridRoute(p: Point, q: Point, blockers: Rect[], avoid: Point[][]): Point[] | null {
  const CELL = 16;
  const MARGIN = 360;
  const x0 = Math.min(p.x, q.x) - MARGIN;
  const y0 = Math.min(p.y, q.y) - MARGIN;
  const cols = Math.ceil((Math.abs(q.x - p.x) + 2 * MARGIN) / CELL);
  const rows = Math.ceil((Math.abs(q.y - p.y) + 2 * MARGIN) / CELL);
  if (cols * rows > 60_000) return null;
  const blocked = new Uint8Array(cols * rows);
  for (const b of blockers) {
    const c1 = Math.max(0, Math.floor((b.x - x0) / CELL));
    const c2 = Math.min(cols - 1, Math.floor((b.x + b.width - x0) / CELL));
    const r1 = Math.max(0, Math.floor((b.y - y0) / CELL));
    const r2 = Math.min(rows - 1, Math.floor((b.y + b.height - y0) / CELL));
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) blocked[r * cols + c] = 1;
  }
  const cellOf = (pt: Point) => [Math.min(cols - 1, Math.max(0, Math.floor((pt.x - x0) / CELL))), Math.min(rows - 1, Math.max(0, Math.floor((pt.y - y0) / CELL)))];
  const [sc, sr] = cellOf(p);
  const [gc, gr] = cellOf(q);
  const start = sr * cols + sc;
  const goal = gr * cols + gc;
  // Endpoints often sit just inside some obstacle's clearance zone: free their immediate neighbourhood.
  for (const [cc, rr] of [
    [sc, sr],
    [gc, gr],
  ])
    for (let dr = -1; dr <= 1; dr++)
      for (let dc = -1; dc <= 1; dc++) {
        const c = cc + dc;
        const r = rr + dr;
        if (c >= 0 && r >= 0 && c < cols && r < rows) blocked[r * cols + c] = 0;
      }

  // Cells on existing arrows cost extra: crossing them is fine, following them isn't.
  const penalty = new Uint8Array(cols * rows);
  for (const line of avoid)
    for (const pt of sampleLine(line, CELL / 2)) {
      const [c, r] = cellOf(pt);
      if (c > 0 && r > 0 && c < cols - 1 && r < rows - 1) penalty[r * cols + c] = 1;
    }
  const g = new Float64Array(cols * rows).fill(Infinity);
  const came = new Int32Array(cols * rows).fill(-1);
  const h = (i: number) => Math.hypot((i % cols) - gc, Math.floor(i / cols) - gr);
  const open = new MinHeap();
  g[start] = 0;
  open.push(start, h(start));
  const steps = [
    [1, 0, 1],
    [-1, 0, 1],
    [0, 1, 1],
    [0, -1, 1],
    [1, 1, Math.SQRT2],
    [1, -1, Math.SQRT2],
    [-1, 1, Math.SQRT2],
    [-1, -1, Math.SQRT2],
  ];
  while (open.size) {
    const cur = open.pop();
    if (cur === goal) break;
    const c = cur % cols;
    const r = Math.floor(cur / cols);
    for (const [dc, dr, cost] of steps) {
      const nc = c + dc;
      const nr = r + dr;
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
      const ni = nr * cols + nc;
      if (blocked[ni]) continue;
      if (dc && dr && (blocked[r * cols + nc] || blocked[nr * cols + c])) continue; // no corner cutting
      const ng = g[cur] + cost + penalty[ni] * 4;
      if (ng < g[ni]) {
        g[ni] = ng;
        came[ni] = cur;
        open.push(ni, ng + h(ni));
      }
    }
  }
  if (came[goal] === -1 && goal !== start) return null;

  const cells: Point[] = [];
  for (let i = goal; i !== -1; i = came[i]) cells.push({ x: x0 + ((i % cols) + 0.5) * CELL, y: y0 + (Math.floor(i / cols) + 0.5) * CELL });
  cells.reverse();
  cells[0] = p;
  cells[cells.length - 1] = q;

  // String-pull: keep only the waypoints needed to stay clear.
  const visible = (a: Point, b: Point) => !blockers.some((o) => segmentHitsRect(a, b, o));
  const waypoints = [cells[0]];
  let i = 0;
  while (i < cells.length - 1) {
    let j = cells.length - 1;
    while (j > i + 1 && !visible(cells[i], cells[j])) j--;
    waypoints.push(cells[j]);
    i = j;
  }
  return densify(waypoints, 24);
}

/** Does `path` run within 6px of another line for more than ~40px (its ends aside)? */
export function runsAlong(path: Point[], lines: Point[][]): boolean {
  if (!lines.length) return false;
  const pts = sampleLine(path, 8).slice(3, -3);
  for (const line of lines) {
    let close = 0;
    for (const c of pts) if (distToLine(c, line) < 6 && ++close > 5) return true;
  }
  return false;
}

function sampleLine(pts: Point[], step: number): Point[] {
  const out: Point[] = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
    for (let k = 0; k < n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  }
  if (pts.length) out.push(pts[pts.length - 1]);
  return out;
}

function distToLine(c: Point, pts: Point[]): number {
  let d = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((c.x - a.x) * dx + (c.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
    d = Math.min(d, Math.hypot(a.x + t * dx - c.x, a.y + t * dy - c.y));
  }
  return d;
}

function densify(path: Point[], step: number): Point[] {
  const out = [path[0]];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
    for (let k = 1; k <= n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  }
  return out;
}

class MinHeap {
  private items: { v: number; k: number }[] = [];
  get size() {
    return this.items.length;
  }
  push(v: number, k: number) {
    const a = this.items;
    a.push({ v, k });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].k <= a[i].k) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): number {
    const a = this.items;
    const top = a[0].v;
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].k < a[m].k) m = l;
        if (r < a.length && a[r].k < a[m].k) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

export interface Obstacles {
  boxes: Box[];
  /** Arrows, lines and pen strokes as polylines. */
  lines: Point[][];
}

/** Would `r` collide with anything? Text may sit fully inside a shape (and a shape inside a shape). */
export function collides(r: Rect, kind: "text" | "shape", obs: Obstacles, gap = 4): boolean {
  for (const b of obs.boxes) {
    if (!overlaps(r, b, gap)) continue;
    if (b.kind === "label") return true;
    const bothText = kind === "text" && b.kind === "text";
    if (!bothText && (contains(b, r) || contains(r, b))) continue;
    return true;
  }
  const padded = inflate(r, gap);
  return obs.lines.some((l) => polylineHitsRect(l, padded));
}

/**
 * Nearest position for `r` (same size) inside `bounds` that doesn't collide.
 * Searches outward in rings, preferring below and to the right. Returns null if
 * there's no free spot within reach.
 */
export function findFreeSpot(r: Rect, kind: "text" | "shape", obs: Obstacles, bounds: Rect): Rect | null {
  const fit = (x: number, y: number): Rect => ({
    x: Math.min(Math.max(x, bounds.x), Math.max(bounds.x, bounds.x + bounds.width - r.width)),
    y: Math.min(Math.max(y, bounds.y), Math.max(bounds.y, bounds.y + bounds.height - r.height)),
    width: r.width,
    height: r.height,
  });
  const start = fit(r.x, r.y);
  if (!collides(start, kind, obs)) return start;
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
  for (let d = 16; d <= 480; d += 16) {
    for (const [dx, dy] of dirs) {
      const c = fit(start.x + dx * d, start.y + dy * d);
      if (!collides(c, kind, obs)) return c;
    }
  }
  return null;
}

/**
 * Where to put an arrow's label: beside the line (not on it), near the middle,
 * clear of every box and other line. `size` is the label's width/height.
 */
export function placeLabel(path: Point[], size: { width: number; height: number }, obs: Obstacles, bounds?: Rect): Rect {
  const lengths = [0];
  for (let i = 1; i < path.length; i++) lengths.push(lengths[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y));
  const total = lengths[lengths.length - 1] || 1;
  const at = (f: number) => {
    const target = f * total;
    let i = 1;
    while (i < path.length - 1 && lengths[i] < target) i++;
    const a = path[i - 1];
    const b = path[i];
    const seg = lengths[i] - lengths[i - 1] || 1;
    const t = (target - lengths[i - 1]) / seg;
    const tangent = { x: (b.x - a.x) / seg, y: (b.y - a.y) / seg };
    return { p: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, n: { x: -tangent.y, y: tangent.x } };
  };
  const ownLine = { boxes: [], lines: [path] };
  const inBounds = (r: Rect) => !bounds || contains(bounds, r, 0);
  // Least-bad fallback: fewest things touched, then nearest to the line's middle.
  const badness = (r: Rect) =>
    obs.boxes.filter((b) => overlaps(r, b, 2)).length + obs.lines.filter((l) => polylineHitsRect(l, r)).length + (polylineHitsRect(path, r) ? 1 : 0) + (inBounds(r) ? 0 : 2);
  let best: { r: Rect; score: number } | null = null;
  // Stay close to the line (a label far from its arrow doesn't read as its label): at most ~80px away.
  for (const extra of [0, 10, 20, 35, 55, 80]) {
    for (const f of [0.5, 0.44, 0.56, 0.38, 0.62, 0.32, 0.68, 0.26, 0.74, 0.2, 0.8]) {
      const { p, n } = at(f);
      // Prefer the side above / left of the line.
      const side = n.y < 0 || (n.y === 0 && n.x < 0) ? 1 : -1;
      for (const s of [side, -side]) {
        // Offset so the label's nearest edge sits clear of the line, whatever its orientation.
        const reach = Math.abs(n.x) * (size.width / 2) + Math.abs(n.y) * (size.height / 2) + 8 + extra;
        const c = { x: p.x + n.x * reach * s, y: p.y + n.y * reach * s };
        const r = { x: c.x - size.width / 2, y: c.y - size.height / 2, width: size.width, height: size.height };
        if (inBounds(r) && !collides(r, "text", obs, 4) && !collides(r, "text", ownLine, 2)) return r;
        const score = badness(r) + extra / 1000;
        if (!best || score < best.score) best = { r, score };
      }
    }
  }
  return best!.r;
}
