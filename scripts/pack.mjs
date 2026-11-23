/**
 * Builds the Claude Desktop extension (.mcpb): one file with the server, the whiteboard, and the voice
 * and hearing models, so installing it is all a user needs. v1 is for Apple-silicon Macs.
 *
 * Only what runs is shipped: the server is bundled; beside it, just the packages the engine thread loads
 * (no web runtime, no sharp, one voice). Models must match models.lock.json. A pack only counts if the
 * packed file passes test/packed.test.ts.
 *   npm run pack   →   dudeling-darwin-arm64.mcpb + .sha256
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const MAX_MB = 135;
const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(root, "bundle");
const mods = join(root, "node_modules");
const run = (cmd, args, env = {}) => execFileSync(cmd, args, { cwd: root, stdio: "inherit", env: { ...process.env, ...env } });
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("v1 packs on (and for) an Apple-silicon Mac");
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
copy("manifest.json");
copy("assets/icon.png", "icon.png");
for (const file of readdirSync(join(root, "assets/icons"))) copy(`assets/icons/${file}`, `icons/${file}`);
copy("assets/cover.png", "cover.png"); // the manifest's screenshot: shown when installing
copy("PRIVACY.md");
for (const file of Object.keys(models)) copy(`models/${file}`);

// Exactly the files the engine thread loads.
const RUNTIME = {
  "kokoro-js": ["dist/kokoro.js", "voices/af_heart.bin"],
  phonemizer: ["dist/phonemizer.js", "dist/phonemizer.cjs"],
  "@huggingface/transformers": ["dist/transformers.node.mjs"],
  "@huggingface/jinja": ["dist"],
  "onnxruntime-node": ["dist", "bin/napi-v6/darwin/arm64/onnxruntime_binding.node", "bin/napi-v6/darwin/arm64/libonnxruntime.1.dylib"], // (its other dylib is the same file again)
  "onnxruntime-common": ["dist"],
};
for (const [name, files] of Object.entries(RUNTIME)) {
  for (const file of ["package.json", ...files]) copy(`node_modules/${name}/${file}`);
  for (const file of readdirSync(join(mods, name))) if (/^(licen[cs]e|notice|thirdpartynotices)/i.test(file)) copy(`node_modules/${name}/${file}`);
}
// transformers.js imports sharp at load, for images, which Dudeling never gives it.
const sharp = join(out, "node_modules/sharp");
mkdirSync(sharp, { recursive: true });
writeFileSync(join(sharp, "package.json"), '{ "name": "sharp", "version": "0.0.0-not-included", "type": "module", "main": "index.js" }\n');
writeFileSync(join(sharp, "index.js"), 'export default function sharp() {\n  throw new Error("Images aren\'t supported in Dudeling\'s engine.");\n}\n');

for (const file of readdirSync(out, { recursive: true })) if (/\.map$|\.d\.[cm]?ts$/.test(file)) rmSync(join(out, file));

// Third-party notices: what's beside the server, inside it, and inside the board.
const shipped = new Set(Object.keys(RUNTIME).map((name) => join(mods, name)));
for (const input of Object.keys(bundled.metafile.inputs)) {
  const dir = resolve(root, input).match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//)?.[1];
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
writeFileSync(
  join(out, "THIRD_PARTY_NOTICES.md"),
  `${readFileSync(join(root, "licenses/NOTICES.md"), "utf8").trim()}\n\n# Packages\n\n${[...entries.keys()].sort().map((k) => entries.get(k)).join("\n\n")}\n`,
);
copy("licenses/GPL-3.0.txt");
if (existsSync(join(root, "LICENSE"))) copy("LICENSE");

const name = "dudeling-darwin-arm64.mcpb";
const file = join(root, name);
rmSync(file, { force: true });
execFileSync(join(mods, ".bin/mcpb"), ["validate", join(out, "manifest.json")], { stdio: "inherit" });
execFileSync(join(mods, ".bin/mcpb"), ["pack", out, file], { stdio: ["ignore", "ignore", "inherit"] });
const mb = statSync(file).size / 1e6;
console.log(`${name}: ${mb.toFixed(1)} MB (${manifest.version})`);
if (mb > MAX_MB) throw new Error(`over the ${MAX_MB} MB limit`);
run(process.execPath, ["--test", "test/packed.test.ts"], { DUDELING_PACKED: file });
writeFileSync(join(dirname(file), `${name}.sha256`), `${sha256(file)}  ${name}\n`);
console.log(`→ ${name}, tested`);
