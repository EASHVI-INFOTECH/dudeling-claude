import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useRef, type RefObject } from "react";
import { boardPicture, learnerDrawing, sceneSummary, type Drawing } from "./drawing";

export type BoardScope = { board_id: string; view: string; topic: number };
type Tool = <T>(name: string, args: Record<string, unknown>) => Promise<{ data?: T; failed: boolean }>;
type Part = { total: number; data?: string; key?: string };
const CHUNK = 40_000;

export function useBoardDrawing(apiRef: RefObject<ExcalidrawImperativeAPI | null>, call: Tool, notify: (id: string, erased: boolean) => void, warn: (s: string) => void) {
  const state = useRef({
    scope: null as BoardScope | null, hydrated: false, restored: null as Drawing | null,
    version: "", revision: 0, timer: undefined as ReturnType<typeof setTimeout> | undefined,
    pictureTimer: undefined as ReturnType<typeof setTimeout> | undefined, dirty: false,
    saving: Promise.resolve(), captures: Promise.resolve(),
  }).current;

  function applyRestore() {
    const api = apiRef.current;
    if (!api || !state.restored) return;
    const { elements, files } = state.restored;
    state.restored = null;
    const existing = api.getSceneElements();
    const ids = new Set(existing.map(el => el.id));
    const restored = elements.filter(el => !ids.has(el.id));
    api.addFiles(Object.values(files));
    api.updateScene({ elements: [...existing, ...restored], captureUpdate: CaptureUpdateAction.NEVER });
    state.version = elements.map(el => el.id + ":" + el.version).join(",");
    state.hydrated = true;
    change();
  }

  function reset() {
    clearTimeout(state.timer);
    clearTimeout(state.pictureTimer);
    state.scope = null;
    state.hydrated = state.dirty = false;
    state.version = "";
    state.restored = null;
  }

  async function restore(scope: BoardScope) {
    reset();
    state.scope = scope;
    let json = "", key: string | undefined;
    for (let part = 0; ; part++) {
      const { data, failed } = await call<Part>("board_ink", { ...scope, part });
      if (state.scope !== scope) return;
      if (failed || !data || (part && key !== data.key)) throw new Error("Could not restore this drawing.");
      if (!data.total) {
        state.hydrated = true;
        change(); // A pen stroke may have landed while the initial read was in flight.
        break;
      }
      json += data.data;
      key = data.key;
      if (part + 1 === data.total) {
        state.restored = JSON.parse(json) as Drawing;
        applyRestore();
        break;
      }
    }
  }

  function flush() {
    clearTimeout(state.timer);
    const scope = state.scope, api = apiRef.current;
    if (!scope || !api || !state.dirty) return state.saving;
    const revision = ++state.revision;
    const data = JSON.stringify(learnerDrawing(api));
    const total = Math.ceil(data.length / CHUNK);
    state.dirty = false;
    state.saving = state.saving.then(async () => {
      for (let part = 0; part < total; part++) {
        if (state.scope !== scope || state.revision !== revision) return;
        const result = await call("board_ink", { ...scope, part, total, revision, data: data.slice(part * CHUNK, (part + 1) * CHUNK) });
        if (result.failed) throw new Error("Could not save this drawing.");
      }
    }).catch(() => {
      if (state.scope !== scope || state.revision !== revision) return;
      warn("Could not save your drawing. Retrying.");
      state.dirty = true;
      state.timer = setTimeout(flush, 2000);
    });
    return state.saving;
  }

  function capture(request?: string) {
    const scope = state.scope;
    const job = state.captures.then(async () => {
      const api = apiRef.current;
      if (!scope || state.scope !== scope || !api) return;
      const elements = api.getSceneElements();
      const marks = elements.filter(el => el.customData?.by !== "agent").length;
      const summary = sceneSummary(elements);
      const picture = elements.length ? await boardPicture(api, elements).catch(() => null) : null;
      if (state.scope !== scope) return;
      const result = await call("learner_drew", { ...scope, request, summary, image: picture?.image ?? "",
        mime_type: picture?.mimeType ?? "image/png", note: marks ? `${marks} learner mark(s)` : "" });
      if (result.failed || state.scope !== scope) return;
      if (!request) notify(scope.board_id, !marks);
    });
    state.captures = job.catch(() => warn("Could not share the board picture."));
    return state.captures;
  }

  function change() {
    const api = apiRef.current;
    if (!api || !state.hydrated || !state.scope) return;
    const version = fingerprint(api);
    if (state.version === version) return;
    state.version = version;
    state.dirty = true;
    clearTimeout(state.timer);
    state.timer = setTimeout(flush, 200);
    clearTimeout(state.pictureTimer);
    state.pictureTimer = setTimeout(() => void capture(), 2500);
  }

  return { applyRestore, capture, change, flush, reset, restore };
}

function fingerprint(api: ExcalidrawImperativeAPI) {
  return api.getSceneElements().filter(el => el.customData?.by !== "agent").map(el => el.id + ":" + el.version).join(",");
}
