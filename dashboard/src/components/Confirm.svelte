<script lang="ts">
  // One reusable "are you sure?" dialog. Call ask() and await the answer.
  // Each dialog on a page gets its own id, so it is announced by its own title.
  const uid = $props.id();
  let dlg = $state<HTMLDialogElement | null>(null);
  let title = $state("");
  let body = $state("");
  let action = $state("Confirm");
  let danger = $state(false);
  let resolve: ((ok: boolean) => void) | null = null;

  export function ask(opts: { title: string; body: string; action: string; danger?: boolean }): Promise<boolean> {
    title = opts.title; body = opts.body; action = opts.action; danger = !!opts.danger;
    dlg?.showModal();
    return new Promise((r) => (resolve = r));
  }
  function done(ok: boolean) {
    resolve?.(ok);
    resolve = null;
    // The page may already be gone (the answer was "Leave").
    dlg?.close();
  }
</script>

<dialog bind:this={dlg} onclose={() => done(false)} aria-labelledby="{uid}-title" aria-describedby="{uid}-body">
  <h2 id="{uid}-title">{title}</h2>
  <p id="{uid}-body">{body}</p>
  <div class="row">
    <button class="btn ghost" onclick={() => done(false)}>Cancel</button>
    <button class="btn" class:danger class:primary={!danger} onclick={() => done(true)}>{action}</button>
  </div>
</dialog>

<style>
  dialog { margin: auto; width: min(420px, calc(100% - 32px)); border: 1px solid var(--line-2); border-radius: var(--radius); background: var(--surface-2); color: var(--text); padding: 24px; box-shadow: var(--shadow-lg); }
  dialog::backdrop { background: rgba(0, 0, 0, 0.6); }
  h2 { font-size: var(--fs-lg); letter-spacing: -0.02em; }
  p { margin-top: 8px; color: var(--text-2); font-size: var(--fs-md); overflow-wrap: anywhere; }
  .row { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
  /* The dialog is reused; don't animate the color swap between Archive and Delete. */
  .row .btn { transition: none; }
  /* White on this red passes 4.5:1; the lighter text red (--critical) did not. */
  .danger { background: var(--danger); border-color: var(--danger); color: #fff; }
  .danger:hover { background: var(--danger-hover); }
</style>
