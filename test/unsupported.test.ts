import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";

process.env.DUDELING_STATE_DIR = mkdtempSync(join(tmpdir(), "dudeling-test-intel-"));

test("an Intel Mac is told plainly, and no board is opened", { skip: process.platform !== "darwin" && "only a Mac checks its chip" }, async (t) => {
  const real = Object.getOwnPropertyDescriptor(process, "arch")!;
  Object.defineProperty(process, "arch", { ...real, value: "x64" });
  t.after(() => Object.defineProperty(process, "arch", real));
  const { createDudelingServer } = await import("../server/app.ts");
  const [near, far] = InMemoryTransport.createLinkedPair();
  await createDudelingServer("<html></html>").connect(far);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(near);
  const r = await client.callTool({ name: "open_board", arguments: { title: "Fridges" } });
  assert.ok(r.isError);
  assert.match((r.content as { text: string }[])[0].text, /Apple silicon/);
  await client.close();
});
