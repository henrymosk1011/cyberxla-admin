// Leaving a page. A page with unsaved edits sets a guard here; the router
// (App.svelte) asks it before moving on, whatever caused the move: a link, a
// button, or the browser's Back.

export const leave: { guard: null | (() => Promise<boolean>) } = { guard: null };

/**
 * While dirty() is true, ask before the route changes, and before the tab is
 * closed or reloaded. Call once while the page component is being set up.
 */
export function guardUnsaved(dirty: () => boolean, ask: () => Promise<boolean>) {
  $effect(() => {
    if (!dirty()) return;
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onUnload);
    leave.guard = ask;
    return () => {
      window.removeEventListener("beforeunload", onUnload);
      if (leave.guard === ask) leave.guard = null;
    };
  });
}

/** Set by the router when the page changes. */
export const arrival = { pending: false };

/**
 * For a page's main heading (use:pageHeading). After a move to another page,
 * focus lands on the heading, so keyboard and screen reader users start at the
 * top of the new page instead of nowhere.
 */
export function pageHeading(el: HTMLElement) {
  el.tabIndex = -1;
  if (arrival.pending) {
    arrival.pending = false;
    el.focus({ preventScroll: true });
  }
}
