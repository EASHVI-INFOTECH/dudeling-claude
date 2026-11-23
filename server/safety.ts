/**
 * Keep the plugin alive. An MCP server that dies takes the whole board down mid-lesson, so a stray error
 * is logged instead of crashing the process. And over stdio (Claude Desktop), stdout IS the protocol:
 * anything a library prints there would corrupt it, so console output is moved to stderr.
 */
import { log } from "./log.ts";

export function protectProcess(opts: { stdio: boolean }) {
  if (opts.stdio) {
    // Claude Desktop's built-in Node host exits on any stray error, and at once on SIGTERM (a native abort
    // if that lands mid-inference). The plugin handles both itself.
    for (const event of ["uncaughtException", "unhandledRejection", "SIGTERM", "SIGINT"]) process.removeAllListeners(event);
    // Libraries (speech engines, model loaders) may print progress/warnings with console.log/info.
    console.log = console.info = console.debug = (...args: unknown[]) => console.error(...args);
  }
  // A closed pipe is the app going away. Logging that error would fail on the same pipe, forever.
  process.stdout.on("error", () => {});
  process.stderr.on("error", () => {});
  process.on("unhandledRejection", (reason) => log(`unhandled rejection (kept running): ${reason instanceof Error ? reason.stack : String(reason)}`));
  process.on("uncaughtException", (err) => log(`uncaught exception (kept running): ${err?.stack ?? String(err)}`));
}
