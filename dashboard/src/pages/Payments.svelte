<script lang="ts">
  import db from "$db";
  import LoadState from "../components/LoadState.svelte";
  import PageHeader from "../components/PageHeader.svelte";
  import QuotesNav from "../components/QuotesNav.svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import { dateTime } from "../lib/format.ts";
  import { messageOf, toast } from "../lib/toast.svelte.ts";
  import { usd } from "../../../supabase/functions/_shared/proposal.ts";
  import type { Payment, ProposalRow } from "../lib/types.ts";

  let { proposals }: { proposals: ProposalRow[] } = $props();

  type Status = { email: boolean; stripe: "off" | "test" | "live"; stripe_key: boolean; stripe_webhook: boolean; webhook_url: string };
  let status = $state<Status | null>(null);
  let list = $state<Payment[] | undefined>(undefined);
  let error = $state("");
  let busy = $state(false);

  async function load() {
    try {
      const [st, pay] = await Promise.all([db.quoteAction({ action: "status" }), db.payments()]);
      status = st as unknown as Status; list = pay; error = "";
    } catch (e) { error = messageOf(e, "Check your connection."); }
  }
  load();
  const fromStripe = new URLSearchParams(location.hash.split("?")[1] ?? "").get("test");

  async function testPayment() {
    busy = true;
    try {
      const out = await db.quoteAction({ action: "test_payment" });
      window.open(String(out.url), "_blank", "noopener");
      toast.info("Stripe Checkout opened", status?.stripe === "live" ? "Live mode: this charges a real card $1. Refund it in Stripe afterwards." : "Use the test card 4242 4242 4242 4242, any future date, any CVC.");
    } catch (e) { toast.error(messageOf(e, "Couldn't start the test payment.")); } finally { busy = false; }
  }
  const label = $derived(!status ? "" : status.stripe === "off" ? "Stripe not connected" : status.stripe === "test" ? "Connected (test mode)" : "Connected (live)");
  const quote = (id: string | null) => proposals.find((p) => p.id === id);
</script>

<PageHeader title="Quotes" sub="Card payments for deposits and full payments, through Stripe Checkout." />
<QuotesNav current="payments" />

{#if !status && !list}
  <LoadState {error} what="payments" onretry={load} />
{:else}
  <div class="cols">
    <div class="main">
      {#if fromStripe === "paid"}<p class="callout" role="status">Back from Stripe. The payment shows here once Stripe tells us (usually a few seconds). Reload if it isn't listed yet.</p>{/if}
      <section class="card flush">
        <div class="card-head pad"><h2>Payments</h2></div>
        {#if list && list.length}
          <table class="table cards">
            <thead><tr><th>Quote</th><th>Kind</th><th class="r">Amount</th><th>Status</th><th class="hide-sm">When</th></tr></thead>
            <tbody>
              {#each list as m (m.id)}
                {@const q = quote(m.proposal_id)}
                <tr>
                  <td class="c-main">{#if q}<a href="#/quotes/{q.id}">Q{q.number}</a> <span class="muted">{q.title}</span>{:else}<span class="muted">{m.kind === "test" ? "Test payment" : "No quote"}</span>{/if}</td>
                  <td>{m.kind === "full" ? "Full" : m.kind === "deposit" ? "Deposit" : m.kind === "test" ? "Test" : "Balance"}{m.livemode ? "" : " (test mode)"}</td>
                  <td class="r num c-strong">{usd(Math.round(m.amount * 100))}</td>
                  <td>{m.status === "paid" ? "Paid" : m.status === "pending" ? "Started" : m.status[0]!.toUpperCase() + m.status.slice(1)}</td>
                  <td class="hide-sm muted">{dateTime(m.paid_at ?? m.created_at)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {:else}
          <EmptyState title="No payments yet" text="Payments from accepted quotes show here once Stripe is connected." />
        {/if}
      </section>
    </div>
    <aside class="side">
      <section class="card">
        <div class="card-head"><h2>Stripe</h2></div>
        <p class="state" class:on={status?.stripe !== "off"}><i aria-hidden="true"></i>{label}</p>
        {#if status?.stripe === "off"}
          <p class="small">Payments are off, so quote pages say "We'll send you an invoice" and no pay buttons show. Nothing else changes.</p>
          <p class="small">To connect: add the secrets <code>STRIPE_SECRET_KEY</code> and <code>STRIPE_WEBHOOK_SECRET</code> in Supabase, Edge Functions, Secrets. The steps are in the admin repo's README, under Connect Stripe.</p>
          <ul class="small checks">
            <li>Secret key: {status.stripe_key ? "set" : "not set"}</li>
            <li>Webhook secret: {status.stripe_webhook ? "set" : "not set"}</li>
          </ul>
        {:else}
          <p class="small">Clients can pay deposits and full payments by card right after accepting.</p>
          <button class="btn" disabled={busy} onclick={testPayment}>{busy ? "Opening Stripe…" : "Send test payment"}</button>
          <p class="muted small">Opens a $1 Stripe Checkout. When it's paid, it shows in the list.</p>
        {/if}
        {#if status}
          <p class="small">Webhook URL for Stripe: <code class="url">{status.webhook_url}</code></p>
          <p class="small">Quote emails: {status.email ? "set up" : "not set up (RESEND_API_KEY is missing)"}.</p>
        {/if}
      </section>
    </aside>
  </div>
{/if}

<style>
  .card { display: flex; flex-direction: column; gap: 12px; }
  .card-head { margin-bottom: 0; }
  .pad { padding: 12px 12px 0; }
  .state { display: inline-flex; align-items: center; gap: 8px; font-weight: 600; }
  .state i { width: 10px; height: 10px; border-radius: 50%; background: var(--st-lost); }
  .state.on i { background: var(--good); }
  .small { font-size: var(--fs-sm); color: var(--text-2); }
  .checks { padding-left: 18px; }
  code { font-family: var(--mono); font-size: var(--fs-xs); }
  .url { overflow-wrap: anywhere; }
  a { color: var(--lime); text-decoration: none; }
</style>
