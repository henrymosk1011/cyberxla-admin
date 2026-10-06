<script lang="ts">
  // One reusable "are you sure?" dialog. Call ask() and await the answer.
  let dlg: HTMLDialogElement;
  let title = $state("");
  let body = $state("");
  let action = $state("Confirm");
  let danger = $state(false);
  let resolve: ((ok: boolean) => void) | null = null;

  export function ask(opts: { title: string; body: string; action: string; danger?: boolean }): Promise<boolean> {
    title = opts.title; body = opts.body; action = opts.action; danger = !!opts.danger;
    dlg.showModal();
    return new Promise((r) => (resolve = r));
  }
  function done(ok: boolean) {
    resolve?.(ok);
    resolve = null;
    dlg.close();
  }
</script>

<dialog bind:this={dlg} onclose={() => done(false)} aria-labelledby="confirm-title">
  <h2 id="confirm-title">{title}</h2>
  <p>{body}</p>
  <div class="row">
    <button class="btn ghost" onclick={() => done(false)}>Cancel</button>
    <button class="btn" class:danger class:primary={!danger} onclick={() => done(true)}>{action}</button>
  </div>
</dialog>

<style>
  dialog { margin: auto; width: min(420px, calc(100% - 32px)); border: 1px solid var(--line-2); border-radius: 16px; background: var(--surface-2); color: var(--text); padding: 24px; box-shadow: 0 24px 60px rgba(0, 0, 0, 0.6); }
  dialog::backdrop { background: rgba(0, 0, 0, 0.6); }
  h2 { font-size: 20px; letter-spacing: -0.02em; }
  p { margin-top: 8px; color: var(--text-2); font-size: 14px; overflow-wrap: anywhere; }
  .row { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
  /* The dialog is reused; don't animate the color swap between Archive and Delete. */
  .row .btn { transition: none; }
  .danger { background: var(--critical); border-color: var(--critical); color: #fff; }
  .danger:hover { background: #ef7f7f; }
</style>
