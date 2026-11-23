/** Test helper: a copy of the plugin over stdio, as Claude Desktop runs it. */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../server/stdio.ts", import.meta.url));

export function startPlugin(env: Record<string, string>) {
  const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, DUDELING_VOICE_DOWNLOAD: "off", DUDELING_VOICE_WARMUP: "off", NODE_TEST_CONTEXT: undefined, ...env } });
  const exited = new Promise<number | null>((done) => proc.on("close", done));
  const waiting = new Map<number, (m: any) => void>();
  let stderr = "";
  let buf = "";
  let id = 0;
  proc.stdin.on("error", () => {});
  proc.stderr.on("data", (d) => (stderr += d));
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (d) => {
    buf += d;
    for (let i; (i = buf.indexOf("\n")) >= 0; ) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      waiting.get(m.id)?.(m);
    }
  });

  function request(method: string, params: object) {
    const n = ++id;
    const reply = new Promise<any>((done, fail) => {
      waiting.set(n, (m) => (waiting.delete(n), m.error ? fail(new Error(JSON.stringify(m.error))) : done(m.result)));
      void exited.then((code) => fail(new Error(`plugin exited (${code}): ${stderr.slice(-600)}`)));
    });
    reply.catch(() => {}); // a call cancelled on purpose is never answered
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method, params })}\n`);
    return { id: n, reply };
  }

  return {
    exited,
    log: () => stderr,
    request,
    cancel: (requestId: number) => proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId } })}\n`),
    tool: (name: string, args: object = {}) => request("tools/call", { name, arguments: args }).reply,
    async init() {
      await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } }).reply;
      proc.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    },
    end: () => (proc.stdin.end(), exited),
    kill: () => (proc.kill("SIGKILL"), exited),
  };
}
export type Plugin = ReturnType<typeof startPlugin>;
