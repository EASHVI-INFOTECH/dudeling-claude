import assert from "node:assert/strict";
import { test } from "node:test";
import { speechPieces } from "../server/speech-text.ts";

const long = "A fridge is really a heat mover: it pushes heat from inside the box out into the room, using a fluid that boils when it is very cold. That is the whole trick.";

test("speech pieces: the same words, in order, in short pieces", () => {
  for (const text of [long, "word ".repeat(70).trim(), "Yes.", "It costs $3.50, i.e. less than tea."]) {
    const pieces = speechPieces(text);
    assert.equal(pieces.join(" "), text);
    for (const p of pieces) assert.ok(p.split(" ").length <= 13, p);
  }
});

test("speech pieces: breaks at sentences and clauses, not inside numbers or abbreviations", () => {
  assert.equal(speechPieces(long)[0], "A fridge is really a heat mover:");
  assert.deepEqual(speechPieces("Use a solvent, e.g. Water works."), ["Use a solvent, e.g. Water works."]);
  assert.deepEqual(speechPieces("Dr. Curie found two new elements in 1898. She later won two Nobel prizes."), [
    "Dr. Curie found two new elements in 1898.",
    "She later won two Nobel prizes.",
  ]);
  assert.deepEqual(speechPieces("  "), []);
});
