import type { AgentAction } from "../agent/actions.ts";

/**
 * What the tutor model returns for one turn: a short lesson broken into steps.
 * Each step pairs what to say with what to draw while saying it, so narration
 * and drawing stay in sync.
 */
export interface Lesson {
  title: string;
  steps: LessonStep[];
  /** How the voice should say unusual terms in this lesson; the board keeps the real spelling. */
  pronounce?: Pronunciation[];
}

/** A spoken form for a term: {term: "lsass", say: "L-sass"}. */
export interface Pronunciation {
  term: string;
  say: string;
}

export interface LessonStep {
  say: string;
  actions: AgentAction[];
  /**
   * When each action should start, as a fraction (0..1) of the way through `say`
   * (from the [n] markers in the model's narration). Same length as `actions`.
   */
  cues?: number[];
}

/** A deep-dive section of a map lesson, as listed by the planning call. */
export interface SectionSpec {
  id: string;
  title: string;
  /** Hub element id this section explains (it's placed next to it and linked to it). */
  about: string | null;
  /** What to teach there. */
  brief: string;
}

/** The planning call's reply: a lesson (single section, or the hub of a map) plus deep-dive sections. */
export interface LessonPlan extends Lesson {
  sections: SectionSpec[];
}

/** Actions the tutor is allowed to emit (a subset of the agent's protocol). */
export const TUTOR_ACTION_TYPES = [
  "write_text",
  "draw_shape",
  "draw_arrow",
  "draw_freehand",
  "point_at",
  "circle",
  "underline",
  "highlight",
  "wait",
] as const;

const color = { type: "string", enum: ["ink", "red", "blue", "green", "orange"] };
const num = { type: "number" };
const point = {
  type: "object",
  additionalProperties: false,
  required: ["x", "y"],
  properties: { x: num, y: num },
};
const target = { anyOf: [{ type: "string" }, point] };
const nullable = (schema: object) => ({ anyOf: [schema, { type: "null" }] });
/**
 * One action variant. Strict structured output requires every property to be listed
 * as required, so optional fields are "required but nullable"; the rails treat null
 * as "not given".
 */
const action = (type: string, required: string[], properties: Record<string, object>) => ({
  type: "object",
  additionalProperties: false,
  required: ["type", ...Object.keys(properties)],
  properties: {
    type: { type: "string", enum: [type] },
    ...Object.fromEntries(
      Object.entries(properties).map(([key, schema]) => [key, required.includes(key) ? schema : nullable(schema)]),
    ),
  },
});

/** JSON schema for structured output (provider-enforced where supported). */
export const LESSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "steps"],
  properties: {
    title: { type: "string" },
    /** Spoken forms for unusual terms. */
    pronounce: {
      anyOf: [
        {
          type: "array",
          items: { type: "object", additionalProperties: false, required: ["term", "say"], properties: { term: { type: "string" }, say: { type: "string" } } },
        },
        { type: "null" },
      ],
    },
    /** Parts of a lesson end with a question that checks understanding. */
    check: {
      anyOf: [
        { type: "object", additionalProperties: false, required: ["question", "answer"], properties: { question: { type: "string" }, answer: { type: "string" } } },
        { type: "null" },
      ],
    },
    steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["say", "actions"],
        properties: {
          say: { type: "string" },
          actions: {
            type: "array",
            items: {
              anyOf: [
                action("write_text", ["id", "x", "y", "text"], { id: { type: "string" }, x: num, y: num, text: { type: "string" }, fontSize: num, color }),
                action("draw_shape", ["id", "shape", "x", "y", "width", "height"], {
                  id: { type: "string" },
                  shape: { type: "string", enum: ["rectangle", "ellipse", "diamond"] },
                  x: num,
                  y: num,
                  width: num,
                  height: num,
                  label: { type: "string" },
                  color,
                  fill: color,
                }),
                action("draw_arrow", ["id", "from", "to"], { id: { type: "string" }, from: target, to: target, label: { type: "string" }, color }),
                action("draw_freehand", ["id", "points"], {
                  id: { type: "string" },
                  points: { type: "array", items: { type: "array", items: num } },
                  color,
                }),
                action("point_at", ["target"], { target }),
                action("circle", ["target"], { target, color }),
                action("underline", ["target"], { target: { type: "string" }, color }),
                action("highlight", ["target"], { target: { type: "string" } }),
                action("wait", ["ms"], { ms: num }),
              ],
            },
          },
        },
      },
    },
  },
} as const;

/** Planning call: a lesson plus an optional list of deep-dive sections (null = single-section lesson). */
export const PLAN_SCHEMA = {
  ...LESSON_SCHEMA,
  required: ["title", "steps", "sections"],
  properties: {
    ...LESSON_SCHEMA.properties,
    sections: nullable({
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "about", "brief"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          about: nullable({ type: "string" }),
          brief: { type: "string" },
        },
      },
    }),
  },
} as const;
