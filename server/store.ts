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

let writes = 0;
/** Atomic (readers never see half a file) and readable by this user only. */
export function writePrivate(path: string, data: unknown) {
  const tmp = `${path}.${process.pid}.${writes++}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}
