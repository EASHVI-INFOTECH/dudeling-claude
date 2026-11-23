/** What the board is sent, and how it becomes steps to play. */
import type { Answer, When } from "../server/prepared";
import { checkLine } from "../server/speech-text";
import { completeSteps, type PlayStep } from "./player";

export interface BoardEvent {
  seq: number;
  at?: number;
  actions: unknown[];
  caption?: string;
  clear?: { title: string };
  part?: {
    steps: { say: string; actions: unknown[] }[];
    check?: { question: string; answer?: string };
    /** Teach this part in its own box on the board (a new subtopic), or go back to the box with this title. */
    section?: { title: string; about?: string };
    /** Prepared ahead: held until Claude's verdict releases it (server/prepared.ts). */
    when?: When;
  };
  /** Claude's verdict on the learner's check answer: plays the part prepared for it. */
  release?: { answer: Answer };
  pause?: boolean;
  resume?: boolean;
  talk?: string;
}
export interface Played {
  seq: number;
  step: number;
}

/** A sketch (draw): drawn without words. */
export const sketchSteps = (e: BoardEvent, fast: boolean): PlayStep[] =>
  completeSteps({ steps: [{ say: "", actions: e.actions }] }, true).map((s) => ({ ...s, fast }));

/**
 * A part's steps. Lines already played (this board is being shown again) are drawn fast and silently;
 * the rest are narrated. `awaiting`: its check was asked and nothing has followed, so it still waits.
 */
export function partSteps(e: BoardEvent, played: Played, awaiting: boolean): PlayStep[] {
  const lines: PlayStep[] = completeSteps({ steps: e.part!.steps }, true);
  const question = e.part!.check?.question;
  if (question) lines.push({ say: checkLine(question), actions: [], check: question });
  return lines.map((line, i) => {
    const heard = e.seq < played.seq || (e.seq === played.seq && i < played.step);
    if (!heard) return { ...line, mark: { seq: e.seq, step: i + 1 } };
    return { ...line, say: "", fast: true, check: awaiting ? line.check : undefined };
  });
}

/** The boxes on one board (reset when the board is cleared). The first box is the hub the others link to. */
export class Sections {
  private byTitle = new Map<string, string>();
  private hub: string | null = null;

  /**
   * The board moves that come before a part: the first part opens the hub (titled after the board, or after
   * its own section); a new subtopic gets a new box placed by the hub, linked to `about`, after a look at the
   * map so far; a title seen before goes back to that box. Played silently, never with a line's mark.
   */
  before(e: BoardEvent, boardTitle: string, fast: boolean): PlayStep[] {
    const section = e.part?.section;
    const key = (t: string) => t.trim().toLowerCase().replace(/\s+/g, " ");
    const nav = (actions: PlayStep["actions"]): PlayStep[] => [{ say: "", actions, fast }];
    if (!this.hub) {
      const title = (section?.title || boardTitle || "Lesson").trim();
      this.hub = "s1";
      this.byTitle.set(key(title), this.hub);
      return nav([{ type: "open_section", id: this.hub, title }]);
    }
    if (!section?.title.trim()) return [];
    const known = this.byTitle.get(key(section.title));
    if (known) return nav([{ type: "go_to", section: known }]);
    const id = `s${this.byTitle.size + 1}`;
    const map = this.byTitle.size >= 2 && !fast ? ([{ type: "overview" }, { type: "wait", ms: 900 }] as PlayStep["actions"]) : [];
    this.byTitle.set(key(section.title), id);
    return nav([
      ...map,
      { type: "open_section", id, title: section.title.trim(), near: this.hub, ...(section.about ? { about: section.about } : {}) },
    ]);
  }
}
