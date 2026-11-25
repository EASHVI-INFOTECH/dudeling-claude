/**
 * Parts prepared ahead. While one part plays, Claude writes the next one (`when: "after_right"`) and, if it likes,
 * a short fix for a wrong answer (`when: "after_wrong"`); the plugin makes their audio in the background. When
 * Claude has judged the learner's answer (`answer` on say / reply_and_listen), the board says the reply and plays
 * the matching part at once: no wait for Claude to write it, nor for its audio.
 *
 * Shared by the plugin (what's on the board) and the board (what to play): the same rule, in one place.
 */
export type When = "now" | "after_right" | "after_wrong";
export type Answer = "right" | "wrong";

interface Ev {
  seq: number;
  at?: number;
  clear?: unknown;
  part?: { when?: When };
  release?: { answer: Answer };
}

/**
 * Events in the order the board plays them. A prepared part is held back until a verdict releases it; it then
 * plays at the release, under the release's seq (so the played-up-to position only moves forward). "right" also
 * drops a fix that wasn't needed; "wrong" keeps the next part for when they've got it. A clear drops both.
 */
export class PlayOrder<E extends Ev> {
  private held: Partial<Record<Answer, E>> = {};

  /** The events to play, from these new ones (released parts are marked `released`). */
  feed(events: E[]): (E & { released?: true })[] {
    const out: (E & { released?: true })[] = [];
    for (const e of events) {
      const when = e.part?.when;
      if (when === "after_right" || when === "after_wrong") {
        this.held[when === "after_right" ? "right" : "wrong"] = e;
        continue;
      }
      if (e.release) {
        const answer = e.release.answer;
        const part = this.held[answer];
        delete this.held[answer];
        if (answer === "right") delete this.held.wrong;
        if (part) out.push({ ...part, seq: e.seq, at: e.at ?? part.at, released: true });
        continue;
      }
      if (e.clear) this.held = {};
      out.push(e);
    }
    return out;
  }

  get pending(): E[] {
    return Object.values(this.held) as E[];
  }

  /** What's prepared and waiting, for the tool results. */
  get waiting(): Answer[] {
    return (["right", "wrong"] as const).filter((a) => this.held[a]);
  }
}
