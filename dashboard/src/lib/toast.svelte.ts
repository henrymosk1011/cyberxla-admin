// Messages that pop up in the corner, so the result of an action is on screen
// wherever you are on the page. Success and info go away on their own; an
// error stays until it is dismissed.
import type { ToastMsg } from "./types.ts";

export const toasts = $state<{ list: ToastMsg[] }>({ list: [] });

const MAX = 4;
let nextId = 0;

function push(t: Omit<ToastMsg, "id">, ms: number | null) {
  // The same message twice in a row is one toast, not a stack.
  const same = toasts.list.find((x) => x.tone === t.tone && x.title === t.title && x.body === t.body);
  if (same) return;
  const item = { ...t, id: ++nextId };
  toasts.list = [...toasts.list, item].slice(-MAX);
  if (ms !== null) setTimeout(() => dismiss(item.id), ms);
}

export function dismiss(id: number) {
  toasts.list = toasts.list.filter((t) => t.id !== id);
}

/** Long enough to read: about 4 seconds plus time per character, up to 12. */
const readTime = (text: string) => Math.min(12000, 4000 + text.length * 45);

export const toast = {
  success: (body: string) => push({ tone: "success", body }, readTime(body)),
  error: (body: string) => push({ tone: "error", body }, null),
  info: (title: string, body: string, link?: { href: string; label: string }) => push({ tone: "info", title, body, href: link?.href, link: link?.label }, 12000),
};

/** The message of a thrown error, or a fallback. */
export const messageOf = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);
