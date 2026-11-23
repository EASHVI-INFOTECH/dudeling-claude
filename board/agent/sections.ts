/**
 * Sections: titled areas of the infinite board that a lesson spreads across.
 *
 * Every section has the same local coordinate space (0..SECTION.width × 0..SECTION.height),
 * so the tutor model always draws "one screen" and never has to reason about where
 * on the infinite canvas things live. The agent translates local → scene coordinates
 * and finds free space for each new section.
 *
 * Pure geometry — no Excalidraw imports — so the tutor rails and evals can use it too.
 */

export const SECTION = { width: 1200, height: 680 } as const;

/** Where the tutor may draw inside a section (local coordinates). */
export const SECTION_SAFE_AREA = { x1: 30, y1: 30, x2: SECTION.width - 30, y2: SECTION.height - 30 } as const;

/** Space between sections: room for each section's title and for the arrows linking them. */
export const SECTION_GAP = 220;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const intersects = (a: Rect, b: Rect, margin = 0) =>
  a.x < b.x + b.width + margin && b.x < a.x + a.width + margin && a.y < b.y + b.height + margin && b.y < a.y + a.height + margin;

/**
 * Find a free spot for a new section.
 *
 * - First section: centred on `viewport`, or the nearest free spot around it.
 * - Later sections: around `anchor` (usually the hub). If `focus` is given (the
 *   point the section explains, e.g. a box in the hub), the free spot closest to it
 *   wins — sections sit right above/below/beside the thing they zoom into, so the
 *   link arrow between them is short and doesn't cross other content.
 *
 * `occupied` = everything already on the board (both human and agent content) plus
 * existing sections; a candidate must keep clear of all of it.
 */
export function placeSection(
  occupied: Rect[],
  viewport: Rect,
  anchor?: Rect,
  focus?: { x: number; y: number },
  /** Things a link from `focus` should not cut through (e.g. the other boxes in the hub). */
  obstacles: Rect[] = [],
): Rect {
  const { width: w, height: h } = SECTION;
  const free = (r: Rect) => !occupied.some((o) => intersects(r, o, SECTION_GAP / 2));

  const origin: Rect = anchor ?? {
    x: viewport.x + (viewport.width - w) / 2,
    y: viewport.y + Math.max(60, (viewport.height - h) / 2),
    width: w,
    height: h,
  };
  if (!anchor && free(origin)) return origin;

  const stepX = w + SECTION_GAP;
  const stepY = h + SECTION_GAP;
  const at = (x: number, y: number): Rect => ({ x, y, width: w, height: h });
  // Ring order: the four sides first (they read best as spokes), then corners.
  const ring = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [-1, 1],
    [1, -1],
    [-1, -1],
  ];
  const candidates: Rect[] = [];
  for (let d = 1; d <= 4; d++) for (const [dx, dy] of ring) candidates.push(at(origin.x + dx * stepX * d, origin.y + dy * stepY * d));
  if (focus) {
    // Rows above/below and columns left/right of the anchor, lined up with the focus point.
    for (let d = 1; d <= 3; d++)
      for (let j = -3; j <= 3; j++) {
        candidates.push(at(focus.x - w / 2 + j * stepX, origin.y - stepY * d));
        candidates.push(at(focus.x - w / 2 + j * stepX, origin.y + stepY * d));
        candidates.push(at(origin.x - stepX * d, focus.y - h / 2 + j * stepY));
        candidates.push(at(origin.x + stepX * d, focus.y - h / 2 + j * stepY));
      }
  }
  const freeOnes = candidates.filter(free);
  if (freeOnes.length) {
    if (!focus) return freeOnes[0];
    // Closest free spot wins — but a link that would cut through other drawings costs a lot,
    // so sections prefer spots their link can reach through empty space.
    const centre = (r: Rect) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
    const cost = (r: Rect) => {
      const c = centre(r);
      const crossings = obstacles.filter((o) => segmentHitsRect(focus, c, o)).length;
      return Math.hypot(c.x - focus.x, c.y - focus.y) * (1 + crossings * 3);
    };
    return freeOnes.reduce((best, r) => (cost(r) < cost(best) ? r : best));
  }
  // Board is crowded beyond 4 rings: fall back to the right of everything.
  const right = Math.max(...occupied.map((o) => o.x + o.width), origin.x);
  return at(right + SECTION_GAP, origin.y);
}

/** Does the segment a→b pass through rect r (slightly shrunk, so grazing an edge doesn't count)? Liang–Barsky. */
export function segmentHitsRect(a: { x: number; y: number }, b: { x: number; y: number }, r: Rect): boolean {
  const pad = 4;
  const [x1, y1, x2, y2] = [r.x + pad, r.y + pad, r.x + r.width - pad, r.y + r.height - pad];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  for (const [p, q] of [
    [-dx, a.x - x1],
    [dx, x2 - a.x],
    [-dy, a.y - y1],
    [dy, y2 - a.y],
  ]) {
    if (p === 0) {
      if (q < 0) return false;
    } else {
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
      if (t0 > t1) return false;
    }
  }
  return true;
}

export function union(rects: Rect[]): Rect | null {
  if (!rects.length) return null;
  const x1 = Math.min(...rects.map((r) => r.x));
  const y1 = Math.min(...rects.map((r) => r.y));
  const x2 = Math.max(...rects.map((r) => r.x + r.width));
  const y2 = Math.max(...rects.map((r) => r.y + r.height));
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}
