#!/usr/bin/env node
/** Local use (Claude Desktop and other desktop clients): MCP over stdin/stdout. */
import { protectProcess } from "./safety.ts";
protectProcess({ stdio: true }); // first: before anything can print to stdout
const { StdioServerTransport } = await import("@modelcontextprotocol/server/stdio");
const { createDudelingServer, loadBoardHtml } = await import("./app.ts");
const engine = await import("./engine.ts");

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  // Exiting during an inference aborts natively (a crash report each time Claude quits): wait for it.
  if (await engine.stop().catch(() => false)) process.exit(0);
  process.kill(process.pid, "SIGKILL"); // the engine is hung: leave without the abort
}
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

const server = createDudelingServer(loadBoardHtml());
await server.connect(new StdioServerTransport());
void engine.start(); // one voice/hearing engine per computer (Claude Desktop starts this plugin twice)
