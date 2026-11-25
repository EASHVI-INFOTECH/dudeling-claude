/**
 * Builds the Claude Desktop extension (.mcpb): one file with the server, the whiteboard, and the voice
 * and hearing models, so installing it is all a user needs. One bundle per platform: Apple-silicon Macs
 * (dudeling-darwin-arm64.mcpb) and 64-bit Windows (dudeling-win32-x64.mcpb), each packed and tested on
 * that platform (CI does both).
 *
 * Only what runs is shipped: the server is bundled; beside it, just the packages the engine thread loads
 * (no web runtime, no sharp, one voice). Models must match models.lock.json. A pack only counts if the
 * packed file passes test/packed.test.ts.
 *   npm run pack   →   dudeling-<platform>-<arch>.mcpb + .sha256
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { Zip, ZipPassThrough } from "fflate";
import { deflateRawSync } from "node:zlib";
import { closeSync, openSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { FILE, TARGET, TARGETS, supported } from "./target.mjs";

const MAX_MB = 135;
const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(root, "bundle");
const mods = join(root, "node_modules");
const win = process.platform === "win32";
// npm is npm.cmd on Windows, which only runs through a shell.
const run = (cmd, args, env = {}) => execFileSync(cmd, args, { cwd: root, stdio: "inherit", shell: win && cmd === "npm", env: { ...process.env, ...env } });
const mcpb = (...args) => execFileSync(process.execPath, [join(mods, "@anthropic-ai/mcpb/dist/cli/cli.js"), ...args], { stdio: ["ignore", args[0] === "pack" ? "ignore" : "inherit", "inherit"] });
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

if (!supported()) throw new Error(`packs on the platform it's for: ${Object.values(TARGETS).map((t) => t.label).join(" or ")} (this is ${TARGET})`);
const pkg = readJson(join(root, "package.json"));
const manifest = readJson(join(root, "manifest.json"));
if (manifest.version !== pkg.version) throw new Error(`manifest ${manifest.version} ≠ package ${pkg.version}`);

const models = readJson(join(root, "models.lock.json")).files;
if (Object.keys(models).some((f) => !existsSync(join(root, "models", f)))) run("npm", ["run", "voice"]); // fetch them once
for (const [file, hash] of Object.entries(models))
  if (sha256(join(root, "models", file)) !== hash) throw new Error(`models/${file} isn't the pinned file (models.lock.json)`);

run("npm", ["run", "build"]);
rmSync(out, { recursive: true, force: true });
mkdirSync(out);
const copy = (from, to = from) => cpSync(join(root, from), join(out, to), { recursive: true, dereference: true });

// The server and the engine thread, as plain JS (Claude's built-in Node may not run TypeScript).
const bundled = await build({
  absWorkingDir: root,
  entryPoints: { stdio: "server/stdio.ts", "engine-worker": "server/engine-worker.ts" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["kokoro-js", "@huggingface/transformers"],
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
  outdir: join(out, "server"),
  metafile: true,
  logLevel: "warning",
});
writeFileSync(join(out, "package.json"), `${JSON.stringify({ name: pkg.name, version: pkg.version, private: true, type: "module" }, null, 2)}\n`);
copy("dist/board.html");
// The bundle's manifest names only the platform it carries the engine for.
writeFileSync(join(out, "manifest.json"), `${JSON.stringify({ ...manifest, compatibility: { ...manifest.compatibility, platforms: [TARGETS[TARGET].os] } }, null, 2)}\n`);
copy("assets/icon.png", "icon.png");
for (const file of readdirSync(join(root, "assets/icons"))) copy(`assets/icons/${file}`, `icons/${file}`);
copy("assets/cover.png", "cover.png"); // the manifest's screenshot: shown when installing
copy("PRIVACY.md");
for (const file of Object.keys(models)) copy(`models/${file}`);

// Exactly the files the engine thread loads.
const RUNTIME = {
  "kokoro-js": ["dist/kokoro.js", "voices/af_heart.bin"],
  phonemizer: ["dist/phonemizer.js", ...(win ? ["dist/phonemizer.cjs"] : [])],
  "@huggingface/transformers": ["dist/transformers.node.mjs"],
  "@huggingface/jinja": ["dist"],
  "onnxruntime-node": ["dist", ...{
    // (the Mac's other dylib is the same file again)
    "darwin-arm64": ["bin/napi-v6/darwin/arm64/onnxruntime_binding.node", "bin/napi-v6/darwin/arm64/libonnxruntime.1.dylib"],
    // DirectML.dll is only delay-loaded, for the GPU, which Dudeling doesn't use; dxcompiler.dll isn't loaded at all.
    "win32-x64": ["bin/napi-v6/win32/x64/onnxruntime_binding.node", "bin/napi-v6/win32/x64/onnxruntime.dll"],
  }[TARGET]],
  "onnxruntime-common": ["dist"],
};
for (const [name, files] of Object.entries(RUNTIME)) {
  for (const file of ["package.json", ...files]) copy(`node_modules/${name}/${file}`);
  for (const file of readdirSync(join(mods, name))) if (/^(licen[cs]e|notice|thirdpartynotices)/i.test(file)) copy(`node_modules/${name}/${file}`);
}
// The engine needs the Microsoft C++ runtime, which not every Windows PC has installed: ship it beside the
// engine, where Windows looks first (Microsoft allows these files to be redistributed with an app).
const VC_RUNTIME = ["msvcp140.dll", "msvcp140_1.dll", "msvcp140_atomic_wait.dll", "vcruntime140.dll", "vcruntime140_1.dll"];
if (TARGET === "win32-x64")
  for (const dll of VC_RUNTIME) cpSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", dll), join(out, "node_modules/onnxruntime-node/bin/napi-v6/win32/x64", dll));

// transformers.js imports sharp at load, for images, which Dudeling never gives it.
const sharp = join(out, "node_modules/sharp");
mkdirSync(sharp, { recursive: true });
writeFileSync(join(sharp, "package.json"), '{ "name": "sharp", "version": "0.0.0-not-included", "type": "module", "main": "index.js" }\n');
writeFileSync(join(sharp, "index.js"), 'export default function sharp() {\n  throw new Error("Images aren\'t supported in Dudeling\'s engine.");\n}\n');

for (const file of readdirSync(out, { recursive: true })) if (/\.map$|\.d\.[cm]?ts$/.test(file)) rmSync(join(out, file));

// Third-party notices: what's beside the server, inside it, and inside the board.
const shipped = new Set(Object.keys(RUNTIME).map((name) => join(mods, name)));
for (const input of Object.keys(bundled.metafile.inputs)) {
  const dir = resolve(root, input).match(/^(.*node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/)?.[1];
  if (dir) shipped.add(dir);
}
for (const dir of readJson(join(root, "dist/board-packages.json"))) shipped.add(dir);
const entries = new Map();
for (const dir of shipped) {
  if (!existsSync(join(dir, "package.json"))) continue;
  const p = readJson(join(dir, "package.json"));
  if (!p.name) continue;
  const texts = readdirSync(dir).filter((f) => /^(licen[cs]e|copying|notice)/i.test(f) && statSync(join(dir, f)).isFile());
  const repo = typeof p.repository === "string" ? p.repository : (p.repository?.url ?? p.homepage ?? "");
  entries.set(
    `${p.name}@${p.version}`,
    `## ${p.name}@${p.version}\nLicence: ${typeof p.license === "string" ? p.license : "see its source"}\nSource: ${repo}\n\n` +
      texts.map((f) => readFileSync(join(dir, f), "utf8").trim()).join("\n\n"),
  );
}
const vcNotice =
  TARGET === "win32-x64"
    ? "\n\n## Microsoft Visual C++ runtime\n\nThe Windows bundle includes Microsoft's redistributable C++ runtime files " +
      `(${VC_RUNTIME.join(", ")}), distributed under the Microsoft Visual C++ Redistributable licence terms. They are not covered by the GPL.`
    : "";
writeFileSync(
  join(out, "THIRD_PARTY_NOTICES.md"),
  `${readFileSync(join(root, "licenses/NOTICES.md"), "utf8").trim()}${vcNotice}\n\n# Packages\n\n${[...entries.keys()].sort().map((k) => entries.get(k)).join("\n\n")}\n`,
);
copy("licenses/GPL-3.0.txt");
if (existsSync(join(root, "LICENSE"))) copy("LICENSE");

const name = FILE;
const file = join(root, name);
rmSync(file, { force: true });
mcpb("validate", join(out, "manifest.json"));
// Stream one compressed entry at a time to keep memory bounded while packing the models.
const fd = openSync(file, "w");
try {
  const archive = new Zip((err, chunk) => {
    if (err) throw err;
    let offset = 0;
    while (offset < chunk.length) offset += writeSync(fd, chunk, offset, chunk.length - offset);
  });
  for (const path of readdirSync(out, { recursive: true }).sort()) {
    const src = join(out, path);
    const stat = statSync(src);
    if (!stat.isFile()) continue;
    const entry = new ZipPassThrough(path.replaceAll("\\", "/"));
    entry.compression = 8;
    entry.process = (bytes, final) => entry.ondata(null, deflateRawSync(bytes, { level: 9 }), final);
    if (!win) {
      entry.os = 3;
      entry.attrs = (stat.mode & 0o777) << 16;
    }
    archive.add(entry);
    entry.push(readFileSync(src), true);
  }
  archive.end();
} finally {
  closeSync(fd);
}
const mb = statSync(file).size / 1e6;
console.log(`${name}: ${mb.toFixed(1)} MB (${manifest.version})`);
if (mb > MAX_MB) throw new Error(`over the ${MAX_MB} MB limit`);
// Shared CI machines are too noisy for the start-up timing; release:check times it on a real computer.
run(process.execPath, ["--test", ...(process.env.CI ? ["--test-skip-pattern=^timing:"] : []), "test/packed.test.ts"], { DUDELING_PACKED: file });
writeFileSync(join(dirname(file), `${name}.sha256`), `${sha256(file)}  ${name}\n`);
console.log(`→ ${name}, tested`);
