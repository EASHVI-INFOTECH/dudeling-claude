/** Board geometry shared by the prompt and the rails (no app dependencies, so the MCP whiteboard can use it). */
export interface Viewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Legacy single-screen safe area (viewport minus margins and the toolbar band). */
export function safeArea(v: Viewport) {
  return { x1: v.x + 40, y1: v.y + 100, x2: v.x + v.width - 40, y2: v.y + v.height - 30 };
}
