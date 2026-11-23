import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { VERSION } from "../server/version.ts";
import { startPlugin } from "./stdio.ts";

const json = (path: string) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));

test("one version everywhere", () => {
  assert.equal(json("package.json").version, VERSION);
  assert.equal(json("package-lock.json").version, VERSION);
  assert.equal(json("manifest.json").version, VERSION);
});

test("the manifest lists exactly the tools Claude sees", { timeout: 20_000 }, async (t) => {
  const p = startPlugin({ DUDELING_STATE_DIR: mkdtempSync(join(tmpdir(), "dudeling-test-release-")) });
  t.after(() => p.kill());
  await p.init();
  const { tools } = await p.request("tools/list", {}).reply;
  const visible = tools.filter((x: any) => !x._meta?.ui?.visibility || x._meta.ui.visibility.includes("model")).map((x: any) => x.name);
  assert.deepEqual(json("manifest.json").tools.map((x: any) => x.name).sort(), visible.sort());
});

// The model tests skip without models; a release must not pass that way.
test("the models are here, so no model test was skipped", { skip: process.env.DUDELING_REQUIRE_MODELS ? false : "set DUDELING_REQUIRE_MODELS for a release" }, () => {
  for (const file of Object.keys(json("models.lock.json").files)) assert.ok(existsSync(new URL(`../models/${file}`, import.meta.url)), file);
});
