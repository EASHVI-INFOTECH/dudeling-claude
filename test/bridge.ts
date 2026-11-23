/**
 * DEV ONLY (never packed): lets the board's test host talk to the plugin over stdio, as Claude Desktop
 * does. Each page gets its own copy of the plugin, over Vite's dev socket, which only listens on this
 * computer and refuses other origins. There is no web server in the product.
 *   DUDELING_PLUGIN    the entry to run (default: the source; or an unpacked extension's server/stdio.js)
 *   DUDELING_STATE_DIR where boards go (default: a scratch folder, never the real lessons)
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

export const SEND = "dudeling:to-plugin";
export const RECEIVE = "dudeling:from-plugin";

export function pluginBridge(): Plugin {
  return {
    name: "dudeling-plugin-bridge",
    apply: "serve",
    configureServer(server) {
      const entry = process.env.DUDELING_PLUGIN ?? fileURLToPath(new URL("../server/stdio.ts", import.meta.url));
      const state = process.env.DUDELING_STATE_DIR ?? mkdtempSync(join(tmpdir(), "dudeling-test-"));
      const copies = new Map<unknown, ChildProcessWithoutNullStreams>();

      server.ws.on(SEND, (message: unknown, page) => {
        const socket = page.socket;
        let copy = copies.get(socket);
        if (!copy) {
          copy = spawn(process.execPath, [entry], { env: { ...process.env, DUDELING_STATE_DIR: state, DUDELING_VOICE_DOWNLOAD: "off", NODE_TEST_CONTEXT: undefined } });
          copies.set(socket, copy);
          let buf = "";
          copy.stdin.on("error", () => {});
          copy.stderr.resume();
          copy.stdout.setEncoding("utf8");
          copy.stdout.on("data", (d: string) => {
            buf += d;
            for (let i; (i = buf.indexOf("\n")) >= 0; ) {
              page.send(RECEIVE, { line: buf.slice(0, i) });
              buf = buf.slice(i + 1);
            }
          });
          const started = copy;
          socket.on("close", () => {
            started.stdin.end();
            copies.delete(socket);
          });
        }
        copy.stdin.write(`${JSON.stringify(message)}\n`);
      });
      server.httpServer?.on("close", () => {
        for (const copy of copies.values()) copy.stdin.end();
      });
    },
  };
}
