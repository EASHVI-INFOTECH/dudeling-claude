import assert from "node:assert/strict";
import { test } from "node:test";
import { PlayOrder, type When } from "../server/prepared.ts";

type E = { seq: number; at?: number; clear?: unknown; part?: { when?: When; name: string }; release?: { answer: "right" | "wrong" } };
const part = (seq: number, name: string, when?: When): E => ({ seq, part: { name, ...(when ? { when } : {}) } });
const verdict = (seq: number, answer: "right" | "wrong"): E => ({ seq, release: { answer } });
const names = (es: E[]) => es.map((e) => `${e.part?.name ?? "?"}@${e.seq}`);

test("prepared parts wait for the verdict, then play under its seq", () => {
  const o = new PlayOrder<E>();
  assert.deepEqual(names(o.feed([part(1, "p1"), part(2, "p2", "after_right"), part(3, "fix1", "after_wrong")])), ["p1@1"]);
  assert.deepEqual(o.waiting, ["right", "wrong"]);
  assert.deepEqual(names(o.feed([verdict(4, "wrong")])), ["fix1@4"], "wrong: the fix");
  assert.deepEqual(o.waiting, ["right"], "the next part is kept for when they've got it");
  assert.deepEqual(names(o.feed([verdict(5, "right")])), ["p2@5"]);
  assert.deepEqual(o.waiting, []);
});

test("right drops an unneeded fix; a newer preparation replaces an older one; a clear drops both", () => {
  const o = new PlayOrder<E>();
  o.feed([part(1, "a", "after_right"), part(2, "fix", "after_wrong"), part(3, "b", "after_right")]);
  assert.deepEqual(names(o.feed([verdict(4, "right")])), ["b@4"], "the newest after_right");
  assert.deepEqual(o.waiting, [], "the fix went with it");
  o.feed([part(5, "c", "after_right")]);
  o.feed([{ seq: 6, clear: true }]);
  assert.deepEqual(o.waiting, []);
  assert.deepEqual(names(o.feed([verdict(7, "right")])), [], "nothing prepared: nothing plays");
});

test("the same events fed in pieces or at once give the same order (a board shown again replays them)", () => {
  const all = [part(1, "p1"), part(2, "p2", "after_right"), { seq: 3 } as E, verdict(4, "right"), part(5, "p3")];
  const once = names(new PlayOrder<E>().feed(all));
  const o = new PlayOrder<E>();
  const pieces = all.flatMap((e) => names(o.feed([e])));
  assert.deepEqual(pieces, once);
  assert.deepEqual(once, ["p1@1", "?@3", "p2@4", "p3@5"]);
});
