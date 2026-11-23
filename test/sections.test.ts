import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// The board's events → steps and the player's layout repair, bundled as the board bundles them.
let ev: any;
before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "dudeling-test-sections-"));
  const bundle = async (file: string) => {
    const outfile = join(dir, file.replace(/\.ts$/, ".mjs"));
    await build({
      entryPoints: [fileURLToPath(new URL(`../view/${file}`, import.meta.url))],
      bundle: true,
      format: "esm",
      platform: "node",
      alias: { "@board": fileURLToPath(new URL("../board", import.meta.url)) },
      outfile,
      logLevel: "error",
    });
    return import(outfile);
  };
  ev = { ...(await bundle("events.ts")), repairBySection: (await bundle("player.ts")).repairBySection };
});

const part = (seq: number, section?: { title: string; about?: string }) => ({
  seq,
  actions: [],
  part: { steps: [{ say: "[1] Here.", actions: [{ type: "draw_shape", id: `box-${seq}`, shape: "rectangle", x: 100 + (seq % 2 ? 0 : 60), y: 100 + (seq % 2 ? 0 : 30), width: 200, height: 80 }] }], ...(section ? { section } : {}) },
});

test("sections: the first part opens the hub; a subtopic opens a linked box; its title again goes back", () => {
  const s = new ev.Sections();
  const nav = (e: unknown) => s.before(e, "Active Directory", false).flatMap((st: any) => st.actions);
  assert.deepEqual(nav(part(1)), [{ type: "open_section", id: "s1", title: "Active Directory" }]);
  assert.deepEqual(nav(part(2)), [], "no section: keep drawing in the current box");
  assert.deepEqual(nav(part(3, { title: "Domains and OUs", about: "box-1" })), [
    { type: "open_section", id: "s2", title: "Domains and OUs", near: "s1", about: "box-1" },
  ]);
  const third = nav(part(4, { title: "Domain controllers" }));
  assert.deepEqual(third.map((a: any) => a.type), ["overview", "wait", "open_section"], "from the third box on, a look at the map first");
  assert.equal(third[2].id, "s3");
  assert.deepEqual(nav(part(5, { title: "  domains and  OUs " })), [{ type: "go_to", section: "s2" }], "same title, any spacing or case: back to it");
});

test("sections: a board shown again replays its boxes without the map pause", () => {
  const s = new ev.Sections();
  s.before(part(1), "T", true);
  s.before(part(2, { title: "A" }), "T", true);
  const again = s.before(part(3, { title: "B" }), "T", true);
  assert.deepEqual(again[0].actions.map((a: any) => a.type), ["open_section"]);
  assert.equal(again[0].fast, true);
  assert.equal(again[0].say, "");
});

test("sections: each box is laid out on its own, so the same local spot isn't pushed away by another box", () => {
  const s = new ev.Sections();
  const steps = [part(1), part(2, { title: "Next" })].flatMap((e) => [...s.before(e, "T", false), ...ev.partSteps(e, { seq: 0, step: 0 }, false)]);
  const fixed = ev.repairBySection("T", steps);
  const shapes = fixed.flatMap((st: any) => st.actions).filter((a: any) => a.type === "draw_shape");
  assert.equal(shapes.length, 2);
  assert.deepEqual(shapes.map((a: any) => [a.x, a.y]), [[100, 100], [160, 130]], "both stay where they were drawn, in their own boxes");
  assert.equal(fixed.length, steps.length, "no step lost");
  assert.ok(fixed.filter((st: any) => st.actions.some((a: any) => a.type === "open_section")).length === 2, "box moves kept as given");
});

test("sections: inside one box, overlapping drawings are still moved apart", () => {
  const s = new ev.Sections();
  const steps = [part(1), part(2)].flatMap((e) => [...s.before(e, "T", false), ...ev.partSteps(e, { seq: 0, step: 0 }, false)]);
  const shapes = ev.repairBySection("T", steps).flatMap((st: any) => st.actions).filter((a: any) => a.type === "draw_shape");
  assert.deepEqual([shapes[0].x, shapes[0].y], [100, 100]);
  assert.notDeepEqual([shapes[1].x, shapes[1].y], [160, 130], "the second one is moved off the first");
});
