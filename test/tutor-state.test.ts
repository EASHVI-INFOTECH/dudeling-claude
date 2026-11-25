import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as boards from "../server/boards.ts";
import * as inbox from "../server/inbox.ts";
import { ink } from "../server/ink.ts";
import { listen } from "../server/listen.ts";

const dir = process.env.DUDELING_STATE_DIR = mkdtempSync(join(tmpdir(), "dudeling-journal-"));

test("clearing a topic drops its picture, pending input, and an outstanding listen", async () => {
  const id = boards.openBoard("One");
  const wait = listen(id, new AbortController().signal, 10_000);
  boards.clearBoard(id, "Two");
  assert.ok("error" in inbox.put(id, { text: "late", how: "spoken" }, 0));
  assert.equal(boards.setSnapshot(id, "AAAA", "old", "image/png", { topic: 0 }), false);
  assert.equal(boards.snapshot(id), undefined);
  inbox.put(id, { text: "new", how: "typed" }, 1);
  assert.equal((await wait).kind, "cancelled");
  assert.deepEqual(inbox.take(id).map(m => m.text), ["new"]);
});

test("an incomplete save or retired view cannot replace the saved editable drawing", () => {
  const board_id = boards.openBoard("Sketch"), topic = 0;
  boards.takeView(board_id, "first");
  const first = { view: "first", board_id, topic, part: 0 };
  assert.ok(ink({ ...first, total: 1, revision: 1, data: "one" })?.saved);
  assert.ok(ink({ ...first, total: 2, revision: 2, data: "half" })?.saved);
  boards.takeView(board_id, "second");
  assert.equal(ink({ ...first, total: 2, revision: 2, part: 1, data: "other half" }), undefined);
  const second = { ...first, view: "second" };
  assert.equal(ink(second)?.data, "one");
  ink({ ...second, total: 1, revision: 1, data: "[]" });
  assert.equal(ink(second)?.data, "[]");
  boards.clearBoard(board_id, "Next");
  assert.equal(ink(second), undefined);
  assert.equal(ink({ ...second, topic: 1 })?.total, 0);
});

test("active sketches survive retention and unused alternatives release their drawing budget", () => {
  const id = boards.openBoard("Decay");
  const old = new Date(Date.now() - 31 * 86400_000);
  utimesSync(join(dir, id + ".json"), old, old);
  boards.setSnapshot(id, "AAAA", "new drawing");
  boards.sweep();
  assert.ok(boards.getBoard(id));
  const part = { steps: [{ say: "example", actions: Array.from({ length: 8 }, () => ({ type: "circle" })) }], when: "after_wrong" as const };
  for (let n = 0; n < 55; n++) assert.ok("seq" in boards.teachPart(id, part));
  assert.ok("seq" in boards.draw(id, [{ type: "circle" }]));
  const released = boards.release(id, "right");
  assert.ok("discarded" in released && released.discarded);
});

test("old JSON boards and concurrent plugin writers replay every acknowledged turn in order", async () => {
  const id = boards.openBoard("Legacy");
  const path = join(dir, id + ".json");
  const legacy = JSON.parse(readFileSync(path, "utf8"));
  legacy.events = [{ seq: 1, actions: [], talk: "original" }];
  writeFileSync(path, JSON.stringify(legacy));
  const writer = (label: string) => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e",
      'import {talk} from "./server/boards.ts"; for(let i=0;i<40;i++) if(!talk(process.argv[1], process.argv[2]+i).seq) process.exit(1);', id, label]);
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve() : reject(Error("Writer exited " + code)));
  });
  await Promise.all([writer("A"), writer("B")]);
  const events = boards.updates(id, 0)!.events;
  assert.equal(events.length, 81);
  assert.equal(new Set(events.map(e => e.talk)).size, 81);
  assert.equal(events.at(-1)?.seq, 81);
  assert.deepEqual(boards.clearBoard(id, "New"), { seq: 82 });
  boards.talk(id, "first new line");
  assert.deepEqual(boards.updates(id, 0)?.events.map(e => e.seq), [82,83]);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), legacy);
});
