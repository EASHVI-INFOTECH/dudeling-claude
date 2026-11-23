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

export async function boardPicture(api: ExcalidrawImperativeAPI): Promise<{ image: string; mimeType: string } | null> {
  for (const { mimeType, side, quality } of TRIES) {
    const blob = await exportToBlob({
      elements: api.getSceneElements(),
      appState: { ...api.getAppState(), exportBackground: true, viewBackgroundColor: "#ffffff", exportWithDarkMode: false },
      files: api.getFiles(),
      mimeType,
      quality,
      maxWidthOrHeight: side,
    });
    const image = await blobToBase64(blob);
    if (image.length <= MAX_CHARS) return { image, mimeType };
  }
  return null;
}
