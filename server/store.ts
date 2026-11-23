/**
 * Where Dudeling keeps lessons: a folder only this user can read, in the operating system's place for
 * app data (not the temp folder, which is cleared and, on Linux, shared).
 *   DUDELING_STATE_DIR overrides it.
 */
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function defaultDir(): string {
  if (process.platform === "darwin") return join(homedir(), "Library/Application Support/Dudeling");
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData/Local"), "Dudeling");
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "dudeling");
}

/** Resolved on first use, so DUDELING_STATE_DIR can be set after import. */
let root: string | null = null;
export function stateDir(): string {
  if (!root) {
    const dir = process.env.DUDELING_STATE_DIR ?? defaultDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700); // also one that was already there
    root = dir;
  }
  return root;
}

export function privateDir(name: string): string {
  const dir = join(stateDir(), name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

const BUSY = new Set(["EPERM", "EACCES", "EBUSY"]);
const pause = new Int32Array(new SharedArrayBuffer(4));
/**
 * Rename, waiting out a short lock. On Windows a file that something has open (the other copy of the plugin
 * reading it, an antivirus scanning a new file) can't be renamed for a moment. Up to ~0.5 s, then it throws.
 */
export function renameWhenFree(from: string, to: string) {
  for (let tries = 0; ; tries++) {
    try {
      return renameSync(from, to);
    } catch (e) {
      if (tries >= 20 || !BUSY.has((e as NodeJS.ErrnoException).code ?? "")) throw e;
      Atomics.wait(pause, 0, 0, 25);
    }
  }
}

let writes = 0;
/** Atomic (readers never see half a file) and readable by this user only. */
export function writePrivate(path: string, data: unknown) {
  const tmp = `${path}.${process.pid}.${writes++}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    renameWhenFree(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}
