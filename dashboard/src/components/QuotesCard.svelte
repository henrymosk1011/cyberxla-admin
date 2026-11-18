<script lang="ts">
  // A lead's or client's outgoing quotes, newest first, and a quick way to start one.
  import Icon from "./Icon.svelte";
  import QuotePill from "./QuotePill.svelte";
  import { quoteNo, quoteValue, valueText } from "../lib/quotes.ts";
  import { shortDate } from "../lib/format.ts";
  import type { ProposalRow } from "../lib/types.ts";

  let { proposals, owner, noun }: {
    proposals: ProposalRow[];
    /** "lead:<id>" or "client:<id>", what the New quote dialog starts with. */
    owner: string;
    /** "client" or "lead" */
    noun: string;
  } = $props();

  const rows = $derived(proposals.filter((p) => !p.archived_at).sort((a, b) => b.number - a.number));
  const when = (p: ProposalRow) =>
    p.accepted_at ? `Accepted ${shortDate(p.accepted_at)}`
      : p.last_sent_at ? `Sent ${shortDate(p.last_sent_at)}`
      : `Started ${shortDate(p.created_at)}`;
</script>

<section class="card">
  <div class="card-head">
    <div><h2>Quotes</h2><p class="sub">Quotes you've made for this {noun}, with what they're worth and where they stand.</p></div>
  </div>
  {#if rows.length}
    <ul class="qlist">
      {#each rows as p (p.id)}
        <li>
          <a href="#/quotes/{p.id}">
            <span class="qname"><strong>{quoteNo(p)}</strong> {p.title}</span>
            <QuotePill status={p.status} linkOnly={p.link_only} />
            <span class="qval num">{valueText(quoteValue(p))}</span>
            <span class="qwhen muted">{when(p)}</span>
          </a>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="muted none">No quotes yet.</p>
  {/if}
  <a class="btn sm" href="#/quotes?new={encodeURIComponent(owner)}"><Icon name="plus" size={14} /> New quote</a>
</section>

<style>
  .qlist { list-style: none; margin: -4px 0 12px; }
  .qlist li { border-top: 1px solid var(--line); }
  .qlist li:first-child { border-top: 0; }
  .qlist a { display: grid; grid-template-columns: minmax(0, 1fr) auto auto 120px; gap: 12px; align-items: center; padding: 10px 6px; border-radius: var(--radius-sm); text-decoration: none; transition: background 0.12s; }
  .qlist a:hover { background: var(--surface-2); }
  .qname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .qname strong { font-weight: 650; margin-right: 4px; }
  .qval { font-weight: 600; text-align: right; white-space: nowrap; }
  .qwhen { font-size: var(--fs-xs); text-align: right; }
  .none { font-size: var(--fs-md); margin-bottom: 12px; }
  @media (max-width: 640px) {
    .qlist a { grid-template-columns: minmax(0, 1fr) auto; gap: 4px 12px; }
    .qval { text-align: left; font-size: var(--fs-sm); }
  }
</style>
