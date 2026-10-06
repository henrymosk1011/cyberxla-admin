/** Calls onIdle after `ms` with no keyboard, pointer, or scroll activity. Returns a stop function. */
export function watchIdle(ms: number, onIdle: () => void): () => void {
  let timer = setTimeout(onIdle, ms);
  const reset = () => {
    clearTimeout(timer);
    timer = setTimeout(onIdle, ms);
  };
  const events = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
  events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
  return () => {
    clearTimeout(timer);
    events.forEach((e) => window.removeEventListener(e, reset));
  };
}
