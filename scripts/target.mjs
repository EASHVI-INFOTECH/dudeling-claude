/** What this computer packs for: a release bundle is built and tested on the platform it's for. */
export const TARGETS = {
  "darwin-arm64": { os: "darwin", label: "an Apple-silicon Mac" },
  "win32-x64": { os: "win32", label: "64-bit Windows (Intel/AMD)" },
};
export const TARGET = `${process.platform}-${process.arch}`;
export const FILE = `dudeling-${TARGET}.mcpb`;
export const supported = () => TARGET in TARGETS;
