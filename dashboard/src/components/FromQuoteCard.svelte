<script lang="ts">
  // On a project made from a quote: what the client accepted, for how much,
  // whether the payment due at acceptance came in, and links back to the quote.
  import db from "$db";
  import Icon from "./Icon.svelte";
  import QuotePill from "./QuotePill.svelte";
  import { quoteNo, quoteValue, selectionText, valueText, viewAsClient } from "../lib/quotes.ts";
  import { dateTime } from "../lib/format.ts";
  import { usd } from "../../../supabase/functions/_shared/proposal.ts";
  import type { Payment, ProposalAcceptance, ProposalRow } from "../lib/types.ts";

  let { quote }: { quote: ProposalRow } = $props();

  let acc = $state<ProposalAcceptance | null>(null);
  let pays = $state<Payment[]>([]);

  $effect(() => {
    const id = quote.id;
    void quote.updated_at;
    let gone = false;
    Promise.all([db.proposalAcceptances(id), db.payments()])
      .then(([a, p]) => {
        if (gone) return;
        acc = a.find((x) => x.version === quote.accepted_version) ?? a[0] ?? null;
        pays = p.filter((x) => x.proposal_id === id && x.kind !== "test");
      })
      .catch(() => { /* the card still shows what the quote row knows */ });
    return () => { gone = true; };
  });

  const cents = (n: number) => Math.round(n * 100);
  const value = $derived(acc ? { once: cents(acc.once_total), monthly: cents(acc.monthly_total) } : quoteValue(quote));
  const paid = $derived(pays.filter((m) => m.status === "paid").reduce((s, m) => s + cents(m.amount), 0));
  const due = $derived(acc ? cents(acc.due_now) : 0);
  const payment = $derived(
    !acc ? "Not accepted yet"
      : due <= 0 ? (paid ? `${usd(paid)} paid` : "Nothing due at acceptance")
      : paid >= due ? `Paid, ${usd(paid)}`
      : paid > 0 ? `${usd(paid)} paid of ${usd(due)} due`
      : `${usd(due)} due, not paid yet`,
  );
</script>

<section class="card">
  <div class="card-head"><div><h2>From quote</h2><p class="sub">This project was made from {quoteNo(quote)}.</p></div></div>
  <dl class="factlist">
    <div><dt>Quote</dt><dd><a href="#/quotes/{quote.id}">{quoteNo(quote)}, {quote.title}</a> <QuotePill status={quote.status} /></dd></div>
    {#if acc}
      <div><dt>Accepted</dt><dd>{dateTime(acc.accepted_at)} by {acc.signer_name}</dd></div>
      <div><dt>Selection</dt><dd>{selectionText(acc.doc, acc.tier, acc.addons)}</dd></div>
    {/if}
    <div><dt>Total</dt><dd class="num">{valueText(value)}</dd></div>
    <div><dt>Payment</dt><dd class:unset={!paid}>{payment}</dd></div>
  </dl>
  <div class="links">
    <a class="btn sm" href="#/quotes/{quote.id}">Open quote <Icon name="arrow-right" size={14} /></a>
    {#if quote.version > 0}<a class="btn sm ghost" href={viewAsClient(quote.token)} target="_blank" rel="noopener noreferrer">Client's page<span class="sr-only"> (opens in a new tab)</span></a>{/if}
  </div>
</section>

<style>
  dd :global(.pill) { margin-left: 6px; vertical-align: middle; }
  .links { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
</style>
