export class Interrupted extends Error {
  constructor() {
    super("Agent interrupted");
    this.name = "Interrupted";
  }
}

export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
export const easeOut = (t: number) => 1 - (1 - t) ** 3;

/**
 * Drive `onFrame(t)` from 0→1 over `durationMs`, once per animation frame.
 * If `signal` aborts mid-way, the final frame (t=1) is still applied so nothing is
 * left half-drawn, then `Interrupted` is thrown.
 */
export function tween(
  durationMs: number,
  onFrame: (t: number) => void,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Interrupted());
    const start = performance.now();
    let raf = 0;
    const onAbort = () => {
      cancelAnimationFrame(raf);
      onFrame(1);
      reject(new Interrupted());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const step = (now: number) => {
      const t = !(durationMs > 0) ? 1 : Math.min(1, (now - start) / durationMs); // NaN-safe
      onFrame(t);
      if (t < 1) {
        raf = requestAnimationFrame(step);
      } else {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }
    };
    raf = requestAnimationFrame(step);
  });
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Interrupted());
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Interrupted());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(b.x - a.x, b.y - a.y);
