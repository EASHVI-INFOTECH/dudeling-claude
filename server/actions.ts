/**
 * What may be drawn: checked as it arrives, with a message Claude can act on. Loose on style (the board's
 * layout rails repair that), strict on what would break the board or balloon a result.
 */
import { z } from "zod";

export const ACTION_TYPES = ["write_text", "draw_shape", "draw_arrow", "draw_freehand", "point_at", "circle", "underline", "highlight", "wait"] as const;

const COORD_MAX = 10_000;
const TEXT_MAX = 300;
const POINTS_MAX = 200;

const coord = (v: unknown) => typeof v === "number" && Math.abs(v) <= COORD_MAX;
const text = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= TEXT_MAX;
const size = (v: unknown) => coord(v) && (v as number) > 0;
const point = (v: unknown) => !!v && typeof v === "object" && coord((v as { x?: unknown }).x) && coord((v as { y?: unknown }).y);
const target = (v: unknown) => text(v) || point(v);
const path = (v: unknown) =>
  Array.isArray(v) && v.length >= 2 && v.length <= POINTS_MAX && v.every((p) => (Array.isArray(p) ? p.length === 2 && p.every(coord) : point(p)));

type Rule = [field: string, ok: (v: unknown) => boolean, needs: string];
const XY: Rule[] = [
  ["x", coord, `a number within ±${COORD_MAX}`],
  ["y", coord, `a number within ±${COORD_MAX}`],
];
const TARGET: Rule[] = [["target", target, "the id of something already drawn"]];
const RULES: Record<(typeof ACTION_TYPES)[number], Rule[]> = {
  write_text: [...XY, ["text", text, `1-${TEXT_MAX} characters of text`]],
  draw_shape: [...XY, ["width", size, "a positive number"], ["height", size, "a positive number"]],
  draw_arrow: [
    ["from", target, "an id, or {x,y}"],
    ["to", target, "an id, or {x,y}"],
  ],
  draw_freehand: [["points", path, `2-${POINTS_MAX} points as [x,y]`]],
  point_at: TARGET,
  circle: TARGET,
  underline: [["target", text, "the id of something already drawn"]],
  highlight: [["target", text, "the id of something already drawn"]],
  wait: [],
};
const SHORT = ["id", "label", "color", "fill", "shape", "text"];

export const actionSchema = z.looseObject({ type: z.enum(ACTION_TYPES) }).superRefine((action, ctx) => {
  const a = action as Record<string, unknown>;
  const fail = (field: string, needs: string) => ctx.addIssue({ code: "custom", path: [field], message: `${action.type}.${field} must be ${needs}` });
  for (const [field, ok, needs] of RULES[action.type]) if (!ok(a[field])) fail(field, needs);
  for (const field of SHORT) if (typeof a[field] === "string" && (a[field] as string).length > TEXT_MAX) fail(field, `under ${TEXT_MAX} characters`);
  for (const field of ["fontSize", "ms"]) if (a[field] !== undefined && !(coord(a[field]) && (a[field] as number) >= 0)) fail(field, "a positive number");
  if (JSON.stringify(a).length > 6000) fail("type", "part of a smaller action (this one is over 6000 characters)");
});
