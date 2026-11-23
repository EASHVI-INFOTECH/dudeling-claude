import { useEffect, useState } from "react";
import type { BoardAgent } from "./BoardAgent";

/**
 * Shows where the tutor is on the shared board:
 * - a "Following Dudeling" toggle (scrolling/zooming yourself turns following off),
 * - an edge marker pointing at the tutor's cursor whenever it's off-screen.
 */
export function TutorPresence({ agent }: { agent: BoardAgent }) {
  const [, rerender] = useState(0);
  useEffect(() => agent.subscribe(() => rerender((n) => n + 1)), [agent]);

  const s = agent.api.getAppState();
  const zoom = s.zoom.value;
  const c = agent.cursorPosition;
  const screen = { x: (c.x + s.scrollX) * zoom, y: (c.y + s.scrollY) * zoom };
  const MARGIN = 28;
  const offscreen = screen.x < 0 || screen.y < 70 || screen.x > s.width || screen.y > s.height;

  let marker: { x: number; y: number; angle: number } | null = null;
  if (offscreen) {
    // Clamp the direction to the cursor onto the viewport edge.
    const cx = s.width / 2;
    const cy = s.height / 2;
    const dx = screen.x - cx;
    const dy = screen.y - cy;
    const scale = Math.min(
      Math.abs((cx - MARGIN - 40) / (dx || 1e-6)),
      Math.abs((cy - MARGIN - 40) / (dy || 1e-6)),
    );
    marker = { x: cx + dx * scale, y: cy + dy * scale, angle: (Math.atan2(dy, dx) * 180) / Math.PI };
  }

  return (
    <>
      {marker && (
        <button
          type="button"
          className="tutor-marker"
          style={{ left: marker.x, top: marker.y }}
          onClick={() => agent.follow()}
          title="Go to Dudeling"
        >
          <span className="tutor-marker__arrow" style={{ transform: `rotate(${marker.angle}deg)` }}>
            ➜
          </span>
          Dudeling
        </button>
      )}
      <button
        type="button"
        className="tutor-follow"
        aria-pressed={agent.isFollowing}
        onClick={() => (agent.isFollowing ? agent.unfollow() : agent.follow())}
        title={agent.isFollowing ? "Stop following (explore on your own)" : "Follow Dudeling around the board"}
      >
        <span className="tutor-follow__dot" />
        {agent.isFollowing ? "Following Dudeling" : "Follow Dudeling"}
      </button>
    </>
  );
}
