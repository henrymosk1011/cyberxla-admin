<script lang="ts">
  // Saved logins for one project. Everything except the label is encrypted in
  // this browser (lib/crypto.ts) before it's saved, with a key that only the
  // vault passphrase unlocks, so the database only ever holds ciphertext.
  import db from "$db";
  import Confirm from "./Confirm.svelte";
  import { changePassphrase, createVault, credentialAad, generatePassword, MIN_PASSPHRASE, openSecret, openVault, sealSecret, type CredentialSecret } from "../lib/crypto.ts";
  import { lock, unlock, vault, vaultKey } from "../lib/vault.svelte.ts";
  import type { Credential, VaultConfig } from "../lib/types.ts";

  let { projectId, onchange }: { projectId: string; onchange: () => void } = $props();

  type Draft = CredentialSecret & { id: string; label: string; isNew: boolean };

  let config = $state<VaultConfig | null | undefined>(undefined);
  let creds = $state<Credential[]>([]);
  let opened = $state<Record<string, CredentialSecret | "error">>({});
  let revealed = $state<Record<string, boolean>>({});
  let draft = $state<Draft | null>(null);
  let showPw = $state(false);
  let changing = $state(false);
  let pass = $state("");
  let pass2 = $state("");
  let current = $state("");
  let busy = $state(false);
  let error = $state("");
  let notice = $state("");
  let copied = $state("");
  let confirm: Confirm;
  let clipTimer: ReturnType<typeof setTimeout> | undefined;
  let seq = 0;

  async function load() {
    try {
      [config, creds] = await Promise.all([db.vault(), db.credentials(projectId)]);
    } catch (e) {
      error = e instanceof Error ? e.message : "Couldn't load credentials.";
    }
  }
  $effect(() => {
    void projectId;
    load();
  });

  // Decrypt on unlock and whenever the list changes; forget all plaintext on lock.
  $effect(() => {
    if (!vault.unlocked) {
      opened = {}; revealed = {}; draft = null; changing = false;
      pass = pass2 = current = "";
      return;
    }
    decryptAll(creds);
  });
  async function decryptAll(list: Credential[]) {
    const run = ++seq, key = vaultKey(), out: Record<string, CredentialSecret | "error"> = {};
    for (const c of list) {
      try {
        out[c.id] = await openSecret(key, c.secret, credentialAad(c.id, c.project_id));
      } catch {
        out[c.id] = "error";
      }
    }
    if (run === seq && vault.unlocked) opened = out;
  }

  async function work(fn: () => Promise<void>) {
    busy = true;
    error = "";
    try {
      await fn();
    } catch (e) {
      error = e instanceof Error ? e.message : "Something went wrong.";
    } finally {
      busy = false;
    }
  }
  function flash(msg: string) {
    notice = msg;
    setTimeout(() => { if (notice === msg) notice = ""; }, 2500);
  }
  function newPassphraseProblem(): string {
    if (pass.length < MIN_PASSPHRASE) return `Use at least ${MIN_PASSPHRASE} characters. A few unrelated words works well.`;
    if (pass !== pass2) return "The two passphrases don't match.";
    return "";
  }

  async function setup(e: SubmitEvent) {
    e.preventDefault();
    const problem = newPassphraseProblem();
    if (problem) { error = problem; return; }
    await work(async () => {
      const v = await createVault(pass);
      await db.createVault(v.config);
      config = v.config;
      unlock(v.key);
      pass = pass2 = "";
      flash("Vault created");
    });
  }

  async function open(e: SubmitEvent) {
    e.preventDefault();
    await work(async () => {
      // Read it fresh: the passphrase may have been changed in another tab.
      const fresh = await db.vault();
      config = fresh;
      if (!fresh) throw new Error("The vault was reset. Set a new passphrase to continue.");
      unlock(await openVault(fresh, pass));
      pass = "";
    });
  }

  async function change(e: SubmitEvent) {
    e.preventDefault();
    const problem = newPassphraseProblem();
    if (problem) { error = problem; return; }
    await work(async () => {
      const fresh = await db.vault();
      if (!fresh) throw new Error("The vault was reset. Reload the page.");
      const next = await changePassphrase(fresh, current, pass);
      await db.updateVault(next);
      config = next;
      changing = false;
      current = pass = pass2 = "";
      flash("Passphrase changed");
    });
  }

  async function reset() {
    error = "";
    let n = 0;
    try {
      n = await db.credentialCount();
    } catch {
      // The prompt still works without the number.
    }
    if (!(await confirm.ask({
      title: "Reset the vault?",
      body: `This permanently deletes ${n === 1 ? "the 1 saved credential" : n ? `all ${n} saved credentials` : "every saved credential"} on every project. Without the passphrase nobody can decrypt them, so there's no other way back in. You'll set a new passphrase next.`,
      action: "Delete credentials and reset",
      danger: true,
    }))) return;
    await work(async () => {
      await db.resetVault();
      lock();
      await load();
      onchange();
    });
  }

  const startNew = () => {
    draft = { id: crypto.randomUUID(), isNew: true, label: "", username: "", password: "", url: "", notes: "" };
    showPw = false;
  };
  function edit(c: Credential) {
    const s = opened[c.id];
    if (!s || s === "error") return;
    draft = { id: c.id, isNew: false, label: c.label, ...s };
    showPw = false;
  }
  async function save(e: SubmitEvent) {
    e.preventDefault();
    const d = draft;
    if (!d || !d.label.trim()) return;
    await work(async () => {
      const secret = await sealSecret(vaultKey(), { username: d.username.trim(), password: d.password, url: d.url.trim(), notes: d.notes }, credentialAad(d.id, projectId));
      const sort = d.isNew ? (creds.length ? Math.max(...creds.map((c) => c.sort)) + 10 : 0) : (creds.find((c) => c.id === d.id)?.sort ?? 0);
      await db.saveCredential({ id: d.id, project_id: projectId, label: d.label.trim(), secret, sort }, d.isNew);
      draft = null;
      await load();
      onchange();
    });
  }
  async function remove(c: Credential) {
    if (!(await confirm.ask({ title: `Delete ${c.label}?`, body: "The saved username, password, URL and notes will be permanently deleted.", action: "Delete", danger: true }))) return;
    await work(async () => {
      await db.deleteCredential(c.id);
      await load();
      onchange();
    });
  }

  async function copy(text: string, tag: string, sensitive = false) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      error = "Couldn't copy. Select the text and copy it instead.";
      return;
    }
    copied = tag;
    setTimeout(() => { if (copied === tag) copied = ""; }, 1500);
    if (sensitive) {
      // Don't leave a password sitting on the clipboard.
      clearTimeout(clipTimer);
      clipTimer = setTimeout(() => navigator.clipboard.writeText("").catch(() => {}), 30_000);
    }
  }
  const isWebUrl = (u: string) => /^https?:\/\/\S+$/i.test(u);
</script>

<section class="card">
  <div class="card-head">
    <div>
      <h2 class="title">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2" /><path d={vault.unlocked ? "M8 11V7a4 4 0 0 1 7.75-1.4" : "M8 11V7a4 4 0 0 1 8 0v4"} /></svg>
        Credentials
      </h2>
      <p class="sub">Encrypted in your browser before they're saved. Only your vault passphrase opens them.</p>
    </div>
    {#if config && vault.unlocked}<button class="btn ghost sm" onclick={lock}>Lock</button>{/if}
  </div>

  {#if config === undefined}
    <p class="muted">Loading…</p>
  {:else if config === null}
    <form class="vform" onsubmit={setup}>
      <p class="lead">Set a vault passphrase to start saving credentials. It's never sent or stored anywhere, so <strong>if you forget it, saved credentials can't be recovered</strong>. Keep it in your password manager.</p>
      <div class="field"><label for="vp-new">Vault passphrase</label><input id="vp-new" class="input" type="password" autocomplete="new-password" bind:value={pass} /></div>
      <div class="field"><label for="vp-again">Type it again</label><input id="vp-again" class="input" type="password" autocomplete="new-password" bind:value={pass2} /></div>
      <div class="row"><button class="btn primary sm" disabled={busy || !pass}>{busy ? "Setting up…" : "Create vault"}</button></div>
    </form>
  {:else if !vault.unlocked}
    {#if creds.length}
      <ul class="locked">
        {#each creds as c (c.id)}<li><span aria-hidden="true">••••</span>{c.label}</li>{/each}
      </ul>
    {/if}
    <form class="unlock" onsubmit={open}>
      <input class="input" type="password" placeholder="Vault passphrase" aria-label="Vault passphrase" autocomplete="current-password" bind:value={pass} />
      <button class="btn primary sm" disabled={busy || !pass}>{busy ? "Unlocking…" : creds.length ? "Unlock to view" : "Unlock to add"}</button>
    </form>
    <button class="link" onclick={reset}>Forgot the passphrase?</button>
  {:else}
    {#if creds.length}
      <ul class="list">
        {#each creds as c (c.id)}
          {@const s = opened[c.id]}
          <li>
            <div class="ch">
              <strong class="label">{c.label}</strong>
              <div class="acts">
                {#if s && s !== "error"}
                  {#if s.password || s.notes}<button class="btn ghost sm" aria-pressed={!!revealed[c.id]} onclick={() => (revealed[c.id] = !revealed[c.id])}>{revealed[c.id] ? "Hide" : "Show"}</button>{/if}
                  <button class="btn ghost sm" onclick={() => edit(c)}>Edit</button>
                {/if}
                <button class="x" aria-label="Delete {c.label}" title="Delete" onclick={() => remove(c)}>×</button>
              </div>
            </div>
            {#if s === "error"}
              <p class="error small">Can't decrypt this one. It was saved under a different vault key, or it's been altered.</p>
            {:else if s}
              <dl>
                {#if s.username}
                  <dt>Username</dt>
                  <dd><span class="mono val">{s.username}</span><button class="copy" onclick={() => copy(s.username, `${c.id}:u`)}>{copied === `${c.id}:u` ? "Copied" : "Copy"}</button></dd>
                {/if}
                {#if s.password}
                  <dt>Password</dt>
                  <dd><span class="mono val">{revealed[c.id] ? s.password : "••••••••••••"}</span><button class="copy" onclick={() => copy(s.password, `${c.id}:p`, true)}>{copied === `${c.id}:p` ? "Copied" : "Copy"}</button></dd>
                {/if}
                {#if s.url}
                  <dt>URL</dt>
                  <dd>{#if isWebUrl(s.url)}<a class="val" href={s.url} target="_blank" rel="noopener noreferrer">{s.url}</a>{:else}<span class="val">{s.url}</span>{/if}</dd>
                {/if}
                {#if s.notes}
                  <dt>Notes</dt>
                  <dd>{#if revealed[c.id]}<p class="val pre">{s.notes}</p>{:else}<span class="muted">Hidden. Use Show to see them.</span>{/if}</dd>
                {/if}
              </dl>
            {:else}
              <p class="muted small">Decrypting…</p>
            {/if}
          </li>
        {/each}
      </ul>
    {:else if !draft}
      <p class="muted none">No credentials on this project yet.</p>
    {/if}

    {#if draft}
      <form class="cform" onsubmit={save}>
        <div class="grid2">
          <div class="field"><label for="c-label">Label</label><input id="c-label" class="input" maxlength="120" placeholder="e.g. Microsoft 365 global admin" autocomplete="off" bind:value={draft.label} /></div>
          <div class="field"><label for="c-user">Username</label><input id="c-user" class="input mono" maxlength="254" autocomplete="off" autocapitalize="off" spellcheck="false" bind:value={draft.username} /></div>
          <div class="field span2">
            <label for="c-pass">Password</label>
            <div class="pw">
              <input id="c-pass" class="input mono" type={showPw ? "text" : "password"} maxlength="1000" autocomplete="new-password" autocapitalize="off" spellcheck="false" bind:value={draft.password} />
              <button type="button" class="btn ghost sm" onclick={() => (showPw = !showPw)}>{showPw ? "Hide" : "Show"}</button>
              <button type="button" class="btn ghost sm" onclick={() => { if (draft) draft.password = generatePassword(); showPw = true; }}>Generate</button>
            </div>
          </div>
          <div class="field span2"><label for="c-url">URL</label><input id="c-url" class="input" maxlength="2000" placeholder="https://" autocomplete="off" spellcheck="false" bind:value={draft.url} /></div>
          <div class="field span2"><label for="c-notes">Notes</label><textarea id="c-notes" class="input" rows="3" maxlength="10000" placeholder="MFA recovery codes, security questions, license keys…" spellcheck="false" bind:value={draft.notes}></textarea></div>
        </div>
        <div class="row">
          <button type="button" class="btn ghost sm" onclick={() => (draft = null)}>Cancel</button>
          <button class="btn primary sm" disabled={busy || !draft.label.trim()}>{busy ? "Encrypting…" : "Save credential"}</button>
        </div>
      </form>
    {:else if changing}
      <form class="vform" onsubmit={change}>
        <div class="field"><label for="vp-cur">Current passphrase</label><input id="vp-cur" class="input" type="password" autocomplete="current-password" bind:value={current} /></div>
        <div class="field"><label for="vp-next">New passphrase</label><input id="vp-next" class="input" type="password" autocomplete="new-password" bind:value={pass} /></div>
        <div class="field"><label for="vp-next2">Type it again</label><input id="vp-next2" class="input" type="password" autocomplete="new-password" bind:value={pass2} /></div>
        <p class="muted small">Applies to every project. Saved credentials stay as they are; only the key that opens them is re-locked.</p>
        <div class="row">
          <button type="button" class="btn ghost sm" onclick={() => { changing = false; current = pass = pass2 = ""; error = ""; }}>Cancel</button>
          <button class="btn primary sm" disabled={busy || !current || !pass}>{busy ? "Changing…" : "Change passphrase"}</button>
        </div>
      </form>
    {:else}
      <div class="row start">
        <button class="btn sm" onclick={startNew}>+ Add credential</button>
        <button class="link" onclick={() => { changing = true; current = pass = pass2 = ""; error = ""; }}>Change vault passphrase</button>
      </div>
    {/if}
  {/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if notice}<p class="ok" role="status">✓ {notice}</p>{/if}
</section>

<Confirm bind:this={confirm} />

<style>
  .title { display: flex; align-items: center; gap: 8px; }
  .title svg { color: var(--lime); }
  .lead { font-size: 14px; color: var(--text-2); }
  .vform, .cform { display: flex; flex-direction: column; gap: 12px; }
  .vform .input, .cform .input { width: 100%; min-width: 0; height: 38px; }
  .cform textarea.input { height: auto; min-height: 76px; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .grid2 .field { min-width: 0; }
  .span2 { grid-column: 1 / -1; }
  .pw { display: flex; gap: 4px; align-items: center; }
  .pw .input { flex: 1; }
  .row { display: flex; justify-content: flex-end; align-items: center; gap: 8px; }
  .row.start { justify-content: space-between; margin-top: 4px; }
  .unlock { display: flex; gap: 8px; }
  .unlock .input { flex: 1; min-width: 0; height: 36px; }
  .unlock .btn { height: 36px; }
  .link { border: 0; background: none; color: var(--muted); font-size: 13px; text-decoration: underline; text-underline-offset: 3px; padding: 4px 0; margin-top: 8px; }
  .row .link { margin-top: 0; }
  .link:hover { color: var(--text); }
  .locked { list-style: none; display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
  .locked li { display: inline-flex; align-items: center; gap: 8px; padding: 5px 10px; border: 1px solid var(--line-2); border-radius: 999px; font-size: 13px; color: var(--text-2); }
  .locked span { color: var(--muted); letter-spacing: -0.1em; font-size: 11px; }
  .list { list-style: none; margin-bottom: 12px; }
  .list > li { padding: 12px 0; border-top: 1px solid var(--line); animation: rise 0.3s var(--ease) both; }
  .list > li:first-child { border-top: 0; padding-top: 0; }
  .ch { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .label { font-weight: 600; overflow-wrap: anywhere; }
  .acts { display: flex; align-items: center; gap: 2px; flex: none; }
  dl { display: grid; grid-template-columns: 84px minmax(0, 1fr); gap: 6px 12px; margin-top: 8px; font-size: 14px; }
  dt { color: var(--muted); font-size: 13px; padding-top: 1px; }
  dd { display: flex; align-items: flex-start; gap: 10px; min-width: 0; }
  .val { overflow-wrap: anywhere; min-width: 0; }
  a.val { color: var(--lime); text-decoration: none; }
  a.val:hover { text-decoration: underline; }
  .pre { white-space: pre-wrap; }
  .copy { flex: none; border: 1px solid var(--line-2); background: var(--surface-2); color: var(--text-2); font-size: 11px; font-weight: 600; border-radius: 999px; padding: 1px 9px; transition: background 0.15s, color 0.15s; }
  .copy:hover { background: var(--surface-3); color: var(--text); }
  .x { border: 0; background: none; color: var(--muted); font-size: 18px; line-height: 1; border-radius: 6px; padding: 2px 6px; transition: color 0.15s, background 0.15s; }
  .x:hover { color: var(--critical); background: var(--surface-2); }
  .none { font-size: 14px; margin-bottom: 12px; }
  .small { font-size: 12px; }
  .error { margin-top: 10px; }
  .error.small { margin-top: 6px; }
  .ok { margin-top: 10px; font-size: 13px; color: var(--good-text); animation: rise 0.3s var(--ease) both; }
  @media (max-width: 640px) {
    .grid2 { grid-template-columns: 1fr; }
    dl { grid-template-columns: 1fr; gap: 2px; }
    dd { margin-bottom: 6px; }
    .row.start { flex-wrap: wrap; }
  }
</style>
