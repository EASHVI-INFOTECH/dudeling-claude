/** The board as a picture small enough for Claude (a tool result holds ~150,000 characters). */
import { exportToBlob } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

// As server/boards.ts → MAX_SNAPSHOT_CHARS.
const MAX_CHARS = 118_000;
const TRIES = [
  { mimeType: "image/png", side: 1024 },
  { mimeType: "image/jpeg", side: 1024, quality: 0.8 },
  { mimeType: "image/jpeg", side: 768, quality: 0.7 },
  { mimeType: "image/jpeg", side: 512, quality: 0.6 },
];

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

export async function boardPicture(api: ExcalidrawImperativeAPI, elements = api.getSceneElements()): Promise<{ image: string; mimeType: string } | null> {
  for (const { mimeType, side, quality } of TRIES) {
    const blob = await exportToBlob({
      elements,
      appState: { ...api.getAppState(), exportBackground: true, viewBackgroundColor: "#ffffff", exportWithDarkMode: false },
      files: api.getFiles(),
      mimeType,
      quality,
      maxWidthOrHeight: side,
    });
    if (4 * Math.ceil(blob.size / 3) <= MAX_CHARS) return { image: await blobToBase64(blob), mimeType };
  }
  return null;
}

export function sceneSummary(elements: ReturnType<ExcalidrawImperativeAPI["getSceneElements"]>) {
  const lines = elements.map(el => {
    const content = "text" in el ? el.text.slice(0, 250) : "";
    const label = el.customData?.section && el.type === "text" ? `Box "${content}"` : [el.id, el.type, content].filter(Boolean).join(" ");
    const owner = el.customData?.by === "agent" ? "" : " (learner)";
    const link = el.type === "text" && el.containerId ? ` label of ${el.containerId}` :
      el.type === "arrow" ? ` from ${el.startBinding?.elementId ?? "point"} to ${el.endBinding?.elementId ?? "point"}` : "";
    return `${label}${owner}${link} at (${Math.round(el.x)},${Math.round(el.y)}), ${Math.round(el.width)} × ${Math.round(el.height)}`;
  });
  const text = lines.join("\n") || "(empty canvas)";
  return text.length <= 16_000 ? text : text.slice(0, 15_960) + "\n(additional elements in the picture)";
}

type Scene = ReturnType<ExcalidrawImperativeAPI["getSceneElements"]>;
type Files = ReturnType<ExcalidrawImperativeAPI["getFiles"]>;
export type Drawing = { elements: Scene; files: Files };

export function learnerDrawing(api: ExcalidrawImperativeAPI): Drawing {
  const elements = api.getSceneElements().filter(el => el.customData?.by !== "agent");
  const files: Files = {};
  const allFiles = api.getFiles();
  for (const el of elements) if (el.type === "image" && el.fileId && allFiles[el.fileId]) files[el.fileId] = allFiles[el.fileId];
  return { elements, files };
}
