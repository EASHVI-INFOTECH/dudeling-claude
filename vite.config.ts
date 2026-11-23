import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { pluginBridge } from "./test/bridge.ts";

/**
 * Builds the whiteboard View into ONE self-contained HTML file (dist/board.html) that the MCP server
 * serves as the `ui://dudeling/board.html` resource. The board engine and lesson rails live in
 * board/ and are imported as "@board/…".
 */
/** Excalidraw lazy-loads ~50 UI translations; the board shows no Excalidraw UI, so only English is kept. */
const englishOnly = {
  name: "dudeling-english-only",
  enforce: "pre" as const,
  resolveId(id: string, importer?: string) {
    if (importer?.includes("@excalidraw/excalidraw") && /\/locales\/(?!en-)[^/]+\.js$/.test(id)) return "\0dudeling-empty-locale";
    return null;
  },
  load(id: string) {
    return id === "\0dudeling-empty-locale" ? "export default {};" : null;
  },
};

/**
 * The board makes no network request. Excalidraw's Latin fonts are embedded and handed to FontFace as
 * bytes (a data: URL would need the host's CSP to allow it for fonts); the 12 MB CJK font is left out.
 */
const EXCALIDRAW_FONTS = fileURLToPath(new URL("./node_modules/@excalidraw/excalidraw/dist/prod/fonts/", import.meta.url));
let fontLoaderPatched = false;
const offlineFonts = {
  name: "dudeling-offline-fonts",
  apply: "build" as const,
  buildStart() {
    fontLoaderPatched = false;
  },
  enforce: "pre" as const,
  transform(code: string, id: string) {
    if (!id.includes("@excalidraw/excalidraw")) return null;
    // Its stylesheet's UI font (Assistant): that UI is hidden, and a host's CSP refuses data: fonts.
    if (/\.css($|\?)/.test(id)) return { code: code.replace(/@font-face\s*\{[^}]*\}/g, ""), map: null };
    if (!code.includes("new FontFace(")) return null;
    let out = code.replace(/"\.\/fonts\/([^"]+\.woff2)"/g, (_, file: string) => {
      const bytes = file.startsWith("Xiaolai/") ? "" : readFileSync(EXCALIDRAW_FONTS + file, "base64");
      return `"data:font/woff2;base64,${bytes}"`;
    });
    out = out.replace(
      /(constructor\((\w+),(\w+),\w+\)\{[^{}]*?createUrls\(\3\);[\s\S]{0,250}?new FontFace\(\2,)(\w+),/,
      (_, head: string, _family: string, uri: string, urls: string) => {
        fontLoaderPatched = true;
        return `${head}${uri}.startsWith("data:")?Uint8Array.from(atob(${uri}.slice(${uri}.indexOf(",")+1)),c=>c.charCodeAt(0)):${urls},`;
      },
    );
    return { code: out.replace("https://esm.sh/", "data:,"), map: null };
  },
  buildEnd(error?: Error) {
    if (!error && !fontLoaderPatched) throw new Error("Excalidraw's font loader changed: update offlineFonts in vite.config.ts");
  },
};

/** Which packages are inside board.html (scripts/pack.mjs writes their licences into the notices). */
const boardPackages = {
  name: "dudeling-board-packages",
  apply: "build" as const,
  generateBundle(this: { getModuleIds(): IterableIterator<string>; emitFile(file: { type: "asset"; fileName: string; source: string }): string }) {
    const dirs = new Set<string>();
    for (const id of this.getModuleIds()) {
      const dir = id.match(/^(\/.*node_modules\/(?:@[^/]+\/)?[^/@][^/]*)\//)?.[1];
      if (dir) dirs.add(dir);
    }
    this.emitFile({ type: "asset", fileName: "board-packages.json", source: JSON.stringify([...dirs].sort(), null, 1) });
  },
};

export default defineConfig({
  root: "view",
  plugins: [pluginBridge(), englishOnly, offlineFonts, react(), boardPackages, viteSingleFile()],
  resolve: {
    alias: {
      "@board": fileURLToPath(new URL("./board", import.meta.url)),
      "@excalidraw/mermaid-to-excalidraw": fileURLToPath(new URL("./view/stubs/mermaid.ts", import.meta.url)),
    },
    // The shared code lives next to another node_modules: always use this package's copies.
    dedupe: ["react", "react-dom", "@excalidraw/excalidraw"],
  },
  define: { "process.env.IS_PREACT": JSON.stringify("false") },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rollupOptions: { input: fileURLToPath(new URL("./view/board.html", import.meta.url)) },
  },
});
