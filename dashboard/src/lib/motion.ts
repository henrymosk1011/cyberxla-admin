// Scripted animations (page transitions, reorder moves) don't see the CSS rule
// that turns motion off, so they ask here.

/** The duration to use: `n` milliseconds, or 0 when the system asks for reduced motion. */
export function ms(n: number): number {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : n;
}
