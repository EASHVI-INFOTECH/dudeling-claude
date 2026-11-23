/**
 * The action protocol an AI agent uses to work on the whiteboard.
 *
 * Everything here is plain JSON so an LLM can emit it directly (one tool call per
 * action, or a list of actions per turn). Coordinates are whiteboard *scene*
 * coordinates — call `observe()` to learn what's visible and where things are.
 */

/** A point on the board, or the id of an element on it (agent's or human's). */
export type Target = string | { x: number; y: number };

/** Named ink colours (matching the human's toolbar) or any CSS hex colour. */
export type InkColor = "ink" | "red" | "blue" | "green" | "orange" | (string & {});

export type AgentAction =
  /** Glide the agent's cursor somewhere without drawing. */
  | { type: "move_cursor"; to: Target }
  /** Laser-point at something: the cursor circles it, leaving a fading trail. */
  | { type: "point_at"; target: Target; durationMs?: number }
  /** Drag out a shape, optionally with a label typed inside it. */
  | {
      type: "draw_shape";
      id?: string;
      shape: "rectangle" | "ellipse" | "diamond";
      x: number;
      y: number;
      width: number;
      height: number;
      label?: string;
      color?: InkColor;
      fill?: InkColor;
    }
  /** Draw an arrow between two points/elements (edges are snapped to element bounds). */
  | { type: "draw_arrow"; id?: string; from: Target; to: Target; label?: string; color?: InkColor }
  /** Type text at a point (top-left anchored). */
  | { type: "write_text"; id?: string; x: number; y: number; text: string; fontSize?: number; color?: InkColor }
  /** Draw a pen stroke through the given points. */
  | { type: "draw_freehand"; id?: string; points: [number, number][]; color?: InkColor }
  /** Hand-draw a loop around an element or point. */
  | { type: "circle"; id?: string; target: Target; color?: InkColor }
  /** Hand-draw a line under an element. */
  | { type: "underline"; id?: string; target: string; color?: InkColor }
  /** Run a highlighter stroke across an element. */
  | { type: "highlight"; id?: string; target: string }
  /** Remove elements by id. */
  | { type: "erase"; targets: string[] }
  /** Wipe the board (human's work included). */
  | { type: "clear" }
  /** Pan/zoom so an element (or everything, if omitted) is in view. */
  | { type: "focus"; target?: string }
  /**
   * Start a new titled area of the board in free space and move there (dragging the
   * board with the hand). Until the next open_section/go_to, all x/y coordinates are
   * LOCAL to this section: 0..1200 × 0..680. Opening a second section outlines and
   * titles every section so the map reads clearly.
   */
  | {
      type: "open_section";
      id: string;
      title: string;
      /** Section to place it around (default: the first section, i.e. the hub). */
      near?: string;
      /** Element (e.g. a box in the hub) this section zooms into: placed next to it and linked to it. */
      about?: string;
    }
  /** Move back to a section opened earlier; coordinates become local to it again. */
  | { type: "go_to"; section: string }
  /** Zoom out to show every section at once. */
  | { type: "overview" }
  /** Pause, e.g. to let narration catch up. */
  | { type: "wait"; ms: number };

export type ActionResult =
  | { ok: true; action: AgentAction["type"]; id?: string }
  | { ok: false; action: AgentAction["type"]; error: string };

/** What the agent can see of the board. */
export interface BoardObservation {
  /** Scene-space rectangle currently visible to the human. */
  viewport: { x: number; y: number; width: number; height: number };
  /** Where the human's pointer is (scene coords), if it's over the board. */
  humanPointer: { x: number; y: number; pressed: boolean } | null;
  agentCursor: { x: number; y: number };
  /** Whether the human's view is following the agent. */
  following: boolean;
  /** Section the agent is working in (its x/y are local to it), if any. */
  currentSection: string | null;
  sections: { id: string; title: string; x: number; y: number; width: number; height: number }[];
  elements: {
    id: string;
    type: string;
    by: "agent" | "human";
    x: number;
    y: number;
    width: number;
    height: number;
    text?: string;
  }[];
}
