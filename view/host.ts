/**
 * DEV ONLY: a tiny MCP Apps host for testing the board locally, the way Claude/ChatGPT embed it:
 * talks to a copy of the plugin over stdio (test/bridge.ts), renders ui://dudeling/board.html in a sandboxed iframe via
 * the SDK's AppBridge, and lets you play Claude (open_board, draw…). Not part of the build.
 * Run: `npm run dev:view`, then open http://127.0.0.1:5173/host.html
 */
import { Client, type JSONRPCMessage, type Transport } from "@modelcontextprotocol/client";
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import { DEMO } from "./demo";

const $ = (id: string) => document.getElementById(id)!;
const log = (msg: string, err = false) => {
  const line = document.createElement("div");
  line.textContent = `${new Date().toLocaleTimeString()} ${msg}`;
  if (err) line.className = "err";
  $("log").prepend(line);
};

/** MCP over Vite's dev socket, to this page's own copy of the plugin. */
class BridgeTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private sent = new Map<unknown, number>();
  private receive = ({ line }: { line: string }) => {
    const message = JSON.parse(line);
    if (!("method" in message)) this.sent.delete(message.id);
    this.onmessage?.(message);
  };
  private longest = 0;
  async start() {
    import.meta.hot!.on("dudeling:from-plugin", this.receive);
  }
  async send(message: JSONRPCMessage) {
    const w = window as unknown as { __toolCalls: number; __longestCall: () => number; __transcription?: () => Promise<Record<string, unknown>> };
    w.__longestCall ??= () => this.longest;
    if ("method" in message && "id" in message && message.method === "tools/call") {
      w.__toolCalls++;
      if (message.params?.name === "transcribe" && w.__transcription) {
        const result = await w.__transcription();
        this.onmessage?.({ jsonrpc: "2.0", id: message.id, result });
        return;
      }
      const id = message.id;
      const at = performance.now();
      this.sent.set(id, at);
      const watch = setInterval(() => {
        this.longest = Math.max(this.longest, performance.now() - at); // also calls the chat app gives up on
        if (!this.sent.has(id) || performance.now() - at > 70_000) clearInterval(watch);
      }, 1000);
    }
    import.meta.hot!.send("dudeling:to-plugin", message);
  }
  async close() {
    import.meta.hot!.off("dudeling:from-plugin", this.receive);
    this.onclose?.();
  }
}
(window as unknown as { __toolCalls: number }).__toolCalls = 0;
const client = new Client({ name: "dudeling-test-host", version: "0" });
await client.connect(new BridgeTransport());
log("connected to the plugin");

// The board's address carries the plugin's version: take it from the open_board tool, as a chat app does.
const { tools } = await client.listTools();
const boardUri = (tools.find((t) => t.name === "open_board")?._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri ?? "ui://dudeling/board.html";
const { contents } = await client.readResource({ uri: boardUri });
const html = (contents[0] as { text: string }).text;
log(`board.html ${Math.round(html.length / 1024)} KB`);

const theme = () => (($("dark") as HTMLInputElement).checked ? "dark" : "light");
const iframe = document.createElement("iframe");
// Like a host: sandboxed. Real hosts serve the board from its own secure origin (Claude: <hash>.claudemcpcontent.com),
// which the microphone needs; ?origin gives this srcdoc frame the page's (localhost) origin to match that.
iframe.setAttribute("sandbox", new URLSearchParams(location.search).has("origin") ? "allow-scripts allow-same-origin" : "allow-scripts");
iframe.setAttribute("allow", "microphone"); // the board asks for it (voice sessions)
iframe.style.height = "560px";
$("frame").append(iframe);

const bridge = new AppBridge(client, { name: "TestHost", version: "0" }, { serverTools: {}, logging: {}, openLinks: {}, updateModelContext: { text: {} }, message: { text: {} } } as never, {
  hostContext: { theme: theme(), displayMode: "inline", availableDisplayModes: ["inline", "fullscreen"] },
});
bridge.onloggingmessage = (p) => log(`[board ${p.level}] ${JSON.stringify(p.data)}`, p.level === "error");
bridge.onsizechange = (p) => {
  if (p.height) iframe.style.height = `${p.height}px`;
  log(`size → ${p.width ?? "?"}×${p.height ?? "?"}`);
};
bridge.onupdatemodelcontext = async (p) => (log(`model context: ${JSON.stringify(p.content).slice(0, 160)}`), {});
bridge.onrequestdisplaymode = async (p) => (log(`display mode → ${p.mode}`), { mode: p.mode });
// Messages the board puts in the chat box (Claude isn't listening). Like Claude, nothing answers until Enter.
bridge.onmessage = async (p) => {
  const text = p.content.map((c) => ("text" in c ? c.text : "")).join(" ");
  log(`MESSAGE from the board: ${text}`);
  $("say").textContent = `You (via the board): ${text}`;
  return {};
};
const ready = new Promise<void>((r) => (bridge.oninitialized = () => (log("board initialized"), r())));
// The sandbox a host puts the board in: nothing from the network.
const CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self'; connect-src 'none'";
iframe.srcdoc = html.replace(/<head>/, () => `<head><meta http-equiv="Content-Security-Policy" content="${CSP}">`);
await new Promise((r) => (iframe.onload = r));
await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
$("dark").addEventListener("change", () => bridge.sendHostContextChange({ theme: theme() }));

let boardId = "";
let next = 0;
const call = async (name: string, args: Record<string, unknown>) => {
  const r = await client.callTool({ name, arguments: args });
  log(`${name} → ${JSON.stringify(r.content).slice(0, 140)}`, !!r.isError);
  return r;
};

$("open").onclick = async () => {
  await ready;
  const args = { title: DEMO.title };
  await bridge.sendToolInput({ arguments: args });
  const r = await call("open_board", args);
  await bridge.sendToolResult(r as never);
  boardId = (r.structuredContent as { board_id: string }).board_id;
  next = 0;
};
const drawNext = async () => {
  if (!boardId) return log("open the board first", true);
  const step = DEMO.steps[next++];
  if (!step) return log("no more steps");
  $("say").textContent = `Claude says: ${step.say.replace(/\[\d+\]\s*/g, "")}`;
  await call("draw", { board_id: boardId, actions: step.actions, caption: `Step ${next}` });
};
$("step").onclick = () => void drawNext();
$("all").onclick = async () => {
  for (let i = next; i < DEMO.steps.length; i++) (await drawNext(), await new Promise((r) => setTimeout(r, 1000)));
};
$("part").onclick = async () => {
  if (!boardId) return log("open the board first", true);
  $("say").textContent = "Claude says: Watch the board.";
  await call("teach_part", { board_id: boardId, steps: DEMO.steps.map((s) => ({ say: s.say, actions: s.actions })), check: DEMO.check });
};
$("pause").onclick = () => void call("pause_board", { board_id: boardId });
$("resume").onclick = () => void call("resume_board", { board_id: boardId });
$("clear").onclick = async () => {
  if (!boardId) return log("open the board first", true);
  await call("clear_board", { board_id: boardId, title: "Heat pumps" });
  next = 0;
};
$("look").onclick = async () => {
  const r = await call("look_at_board", { board_id: boardId });
  const img = (r.content as { type: string; data?: string }[]).find((c) => c.type === "image");
  if (img?.data) {
    const el = document.createElement("img");
    el.src = `data:${(img as { mimeType?: string }).mimeType ?? "image/png"};base64,${img.data}`;
    el.style.maxWidth = "100%";
    $("log").prepend(el);
  }
};

// ?auto: open a board and draw every step by itself (for screenshots).
if (new URLSearchParams(location.search).has("auto")) {
  await ready;
  ($("open") as HTMLButtonElement).click();
  await new Promise((r) => setTimeout(r, 1500));
  ($("all") as HTMLButtonElement).click();
}

// ?board=<id>: replay a board that already exists on the server (e.g. from a real chat), as the board would show it.
const replay = new URLSearchParams(location.search).get("board");
if (replay) {
  await ready;
  await bridge.sendToolInput({ arguments: { title: "(replay)" } });
  await bridge.sendToolResult({ content: [], structuredContent: { board_id: replay, title: "(replay)" } } as never);
  boardId = replay;
  log(`replaying board ${replay} (read-only: buttons disabled)`);
  for (const b of document.querySelectorAll("#side button")) (b as HTMLButtonElement).disabled = true;
}
