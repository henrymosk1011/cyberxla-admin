<script lang="ts">
  import db from "$db";
  import type { AuthState, Enrollment } from "../lib/types.ts";

  let { auth, onauth }: { auth: AuthState; onauth: (s: AuthState) => void } = $props();

  let email = $state("");
  let password = $state("");
  let code = $state("");
  let busy = $state(false);
  let error = $state("");
  let enrollment = $state<Enrollment | null>(null);
  let showSecret = $state(false);

  async function run(fn: () => Promise<AuthState>) {
    busy = true;
    error = "";
    try {
      const next = await fn();
      code = "";
      onauth(next);
    } catch (e) {
      error = e instanceof Error ? e.message : "Something went wrong.";
    } finally {
      busy = false;
    }
  }

  $effect(() => {
    if (auth.step === "enroll" && !enrollment) {
      db.enrollTotp().then((e) => (enrollment = e), (e) => (error = e.message));
    }
  });

  const factorId = $derived(mfaFactor(auth) ?? enrollment?.factorId ?? "");
  function mfaFactor(a: AuthState) {
    return a.step === "mfa" ? a.factorId : null;
  }
  const cleanCode = (v: string) => v.replace(/\D/g, "").slice(0, 6);
</script>

<main class="wrap">
  <div class="panel">
    <div class="brand"><span class="mark" aria-hidden="true">×</span> cyberXLA <span class="muted">Admin</span></div>

    {#if auth.step === "signed-out"}
      <h1>Sign in</h1>
      <form onsubmit={(e) => { e.preventDefault(); run(() => db.signIn(email.trim(), password)); }}>
        <div class="field">
          <label for="email">Email</label>
          <input id="email" class="input" type="email" autocomplete="username" required bind:value={email} />
        </div>
        <div class="field">
          <label for="pw">Password</label>
          <input id="pw" class="input" type="password" autocomplete="current-password" required bind:value={password} />
        </div>
        {#if error}<p class="error" role="alert">{error}</p>{/if}
        <button class="btn primary" disabled={busy}>{busy ? "Signing in…" : "Continue"}</button>
      </form>

    {:else if auth.step === "enroll"}
      <h1>Set up two-factor</h1>
      <p class="lead">Scan this with your authenticator app (1Password, Authy, Google Authenticator), then enter the 6-digit code it shows. You'll need it every time you sign in.</p>
      {#if enrollment}
        <div class="qr"><img src={enrollment.qr} alt="QR code for your authenticator app" width="180" height="180" /></div>
        <button type="button" class="btn ghost sm" onclick={() => (showSecret = !showSecret)}>{showSecret ? "Hide" : "Can't scan? Show"} setup key</button>
        {#if showSecret}<code class="secret mono">{enrollment.secret}</code>{/if}
      {:else}
        <p class="muted">Preparing…</p>
      {/if}
      {@render codeForm("Turn on two-factor")}

    {:else if auth.step === "mfa"}
      <h1>Verify it's you</h1>
      <p class="lead">Enter the 6-digit code from your authenticator app.</p>
      {@render codeForm("Verify")}

    {:else if auth.step === "denied"}
      <h1>No access</h1>
      <p class="lead">{auth.email} isn't an admin on this dashboard.</p>
      <button class="btn" onclick={() => db.signOut()}>Sign out</button>
    {/if}
  </div>
  <p class="foot muted">Private system. Access is logged.</p>
</main>

{#snippet codeForm(label: string)}
  <form onsubmit={(e) => { e.preventDefault(); run(() => db.verifyTotp(factorId, code)); }}>
    <div class="field">
      <label for="code">6-digit code</label>
      <input
        id="code" class="input code mono" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required
        value={code} oninput={(e) => (code = cleanCode(e.currentTarget.value))}
      />
    </div>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <button class="btn primary" disabled={busy || code.length !== 6 || !factorId}>{busy ? "Checking…" : label}</button>
    <button type="button" class="btn ghost sm" onclick={() => db.signOut()}>Use a different account</button>
  </form>
{/snippet}

<style>
  .wrap { min-height: 100dvh; display: grid; place-items: center; align-content: center; gap: 20px; padding: 24px 16px; background: radial-gradient(1200px 600px at 50% -10%, rgba(214,255,63,0.07), transparent 60%), var(--plane); }
  .panel { width: min(400px, 100%); background: var(--surface); border: 1px solid var(--line); border-radius: 20px; padding: 32px; display: flex; flex-direction: column; gap: 18px; }
  .brand { font-weight: 700; letter-spacing: -0.02em; display: flex; align-items: center; gap: 8px; }
  .mark { display: inline-grid; place-items: center; width: 26px; height: 26px; border-radius: 7px; background: var(--ink); color: var(--lime); font-size: 18px; font-weight: 800; border: 1px solid var(--line-2); }
  h1 { font-size: 26px; letter-spacing: -0.03em; }
  .lead { color: var(--text-2); font-size: 14px; }
  form { display: flex; flex-direction: column; gap: 14px; }
  .qr { align-self: center; background: #fff; border-radius: 12px; padding: 10px; line-height: 0; }
  .secret { font-size: 13px; background: var(--ink); border: 1px solid var(--line); border-radius: 8px; padding: 10px; text-align: center; letter-spacing: 0.1em; overflow-wrap: anywhere; }
  .code { font-size: 22px; letter-spacing: 0.4em; text-align: center; height: 52px; }
  .foot { font-size: 12px; }
</style>
