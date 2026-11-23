/**
 * The check that says it's ready on this computer (an Apple-silicon Mac, or 64-bit Windows for the Windows
 * bundle). Everything runs here; nothing is pushed or published. CI packs both bundles and publishes tags.
 *   npm run release:check
 *
 * Behaviour and timing run apart: timings taken while the computer is busy with other work mean nothing, so
 * those wait for it to settle, and a run on a busy computer is called invalid rather than failed. Every step
 * has a time limit, and ending the check ends everything it started.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FILE } from "./target.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const win = process.platform === "win32";
const QUIET = cpus().length * 0.75; // timings start below this
const SWAMPED = cpus().length * 1.5; // above this at any moment of a step, its result means nothing
const SETTLE_MS = 5 * 60_000;

let child = null;
const stopChild = () => {
  if (!child?.pid) return;
  try {
    if (win) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }); // its whole tree
    else process.kill(-child.pid, "SIGTERM"); // its whole process group
  } catch {
    /* already gone */
  }
};
process.on("exit", stopChild);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => process.exit(130));

let peak = 0; // the highest load during the step in progress

function run(cmd, args, { env = {}, minutes = 10 } = {}) {
  return new Promise((done) => {
    child = spawn(cmd, args, { cwd: root, stdio: "inherit", detached: !win, shell: win && cmd === "npm", env: { ...process.env, DUDELING_REQUIRE_MODELS: "1", ...env } });
    const timer = setTimeout(stopChild, minutes * 60_000);
    peak = loadavg()[0];
    const watch = setInterval(() => (peak = Math.max(peak, loadavg()[0])), 3000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      clearInterval(watch);
      child = null;
      done(code === 0);
    });
  });
}
function giveUp(why) {
  if (peak > SWAMPED) console.log(`\nINVALID: ${why}, but this computer was too busy to tell (load ${peak.toFixed(0)} on ${cpus().length} cores). Run it again when it's quiet.`);
  else console.log(`\nNOT READY: ${why}.`);
  process.exit(peak > SWAMPED ? 3 : 1);
}
async function must(what, cmd, args, options) {
  console.log(`\n### ${what}`);
  if (await run(cmd, args, options)) return;
  giveUp(`${what} failed`);
}

const tests = readdirSync(join(root, "test")).filter((f) => f.endsWith(".test.ts")).map((f) => `test/${f}`);
const node = (...args) => ["--test", "--test-concurrency=1", ...args];
for (const file of Object.keys(JSON.parse(readFileSync(join(root, "models.lock.json"), "utf8")).files))
  if (!existsSync(join(root, "models", file))) {
    console.log(`NOT READY: models/${file} is missing (npm run voice).`);
    process.exit(1);
  }

await must("typecheck", "npm", ["run", "typecheck"]);
await must("no known vulnerabilities", "npm", ["audit", "--omit=dev"]);
await must("pack, and test the packed file", "npm", ["run", "pack"]);
await must("behaviour, from source", process.execPath, node("--test-skip-pattern=^timing:", ...tests.filter((f) => !f.includes("board.test"))), { minutes: 10 });
await must("the board, on the packed bytes", process.execPath, node("--test-skip-pattern=^timing:", "test/board.test.ts"), { env: { DUDELING_PACKED: FILE }, minutes: 15 });

console.log("\n### timings");
for (const until = Date.now() + SETTLE_MS; loadavg()[0] > QUIET && Date.now() < until; ) await new Promise((r) => setTimeout(r, 10_000));
const timed = await run(process.execPath, node("--test-name-pattern=^timing:", "test/engine.test.ts", "test/board.test.ts", "test/packed.test.ts"), { env: { DUDELING_PACKED: FILE }, minutes: 10 });
console.log(`\n${FILE}: ${(statSync(join(root, FILE)).size / 1e6).toFixed(1)} MB, highest load during timings ${peak.toFixed(1)} on ${cpus().length} cores`);
if (timed) console.log("The automated checks pass on this computer. Next: test/claude-desktop.md, in Claude Desktop.");
else giveUp("a timing is over its bar");
