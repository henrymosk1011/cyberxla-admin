<script lang="ts">
  import db from "$db";
  import Confirm from "../components/Confirm.svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import LoadState from "../components/LoadState.svelte";
  import Menu from "../components/Menu.svelte";
  import Modal from "../components/Modal.svelte";
  import Field from "../components/Field.svelte";
  import PageHeader from "../components/PageHeader.svelte";
  import QuotesNav from "../components/QuotesNav.svelte";
  import { shortDate } from "../lib/format.ts";
  import { messageOf, toast } from "../lib/toast.svelte.ts";
  import { totals, usd } from "../../../supabase/functions/_shared/proposal.ts";
  import type { ProposalTemplate } from "../lib/types.ts";

  let list = $state<ProposalTemplate[] | undefined>(undefined);
  let error = $state("");
  let confirm: Confirm;
  let renaming = $state<ProposalTemplate | null>(null);
  let name = $state("");
  let title = $state("");

  async function load() {
    try { list = await db.templates(); error = ""; } catch (e) { error = messageOf(e, "Check your connection."); }
  }
  load();

  async function remove(t: ProposalTemplate) {
    if (!(await confirm.ask({ title: `Delete the template "${t.name}"?`, body: "Quotes already made from it don't change.", action: "Delete", danger: true }))) return;
    try { await db.deleteTemplate(t.id); toast.success("Template deleted."); load(); } catch (e) { toast.error(messageOf(e, "Couldn't delete it.")); }
  }
  async function rename(e: SubmitEvent) {
    e.preventDefault();
    if (!renaming || !name.trim() || !title.trim()) return;
    try {
      await db.saveTemplate({ name: name.trim(), title: title.trim(), content: renaming.content, internal: renaming.internal }, renaming.id);
      renaming = null; toast.success("Template saved."); load();
    } catch (err) { toast.error(messageOf(err, "Couldn't save it.")); }
  }
  const range = (t: ProposalTemplate) => {
    const prices = t.content.tiers.map((x) => totals(t.content, x.key, []).once_total);
    return prices.length > 1 ? `${usd(Math.min(...prices))} to ${usd(Math.max(...prices))}` : usd(prices[0] ?? 0);
  };
</script>

<PageHeader title="Quotes" sub="Start new quotes from a template. To change one, start a quote from it, edit it, then Save as template with the same name." />
<QuotesNav current="templates" />

{#if list === undefined}
  <LoadState {error} what="templates" onretry={load} />
{:else if !list.length}
  <section class="card"><EmptyState title="No templates yet" text="Open any quote and use Save as template in its More menu." /></section>
{:else}
  <section class="card flush">
    <table class="table cards">
      <thead><tr><th>Template</th><th class="hide-sm">Tiers</th><th class="r">Price</th><th class="hide-sm">Updated</th><th><span class="sr-only">Actions</span></th></tr></thead>
      <tbody>
        {#each list as t (t.id)}
          <tr>
            <td class="c-main"><span class="who"><strong>{t.name}</strong><span class="muted">{t.title}</span></span></td>
            <td class="hide-sm">{t.content.tiers.map((x) => x.name).join(", ")}</td>
            <td class="r num c-strong">{range(t)}</td>
            <td class="hide-sm muted">{shortDate(t.updated_at)}</td>
            <td class="r"><Menu label="Actions for {t.name}" items={[
              { label: "Rename", onselect: () => { renaming = t; name = t.name; title = t.title; } },
              { label: "Delete", danger: true, onselect: () => remove(t) },
            ]} /></td>
          </tr>
        {/each}
      </tbody>
    </table>
  </section>
{/if}

<Modal open={!!renaming} title="Rename template" onclose={() => (renaming = null)}>
  <form class="form" onsubmit={rename}>
    <Field id="tp-name" label="Template name" required>{#snippet children(a)}<input {...a} class="input" maxlength="80" bind:value={name} />{/snippet}</Field>
    <Field id="tp-title" label="Quote title it starts with" required>{#snippet children(a)}<input {...a} class="input" maxlength="120" bind:value={title} />{/snippet}</Field>
    <div class="row"><button type="button" class="btn ghost" onclick={() => (renaming = null)}>Cancel</button><button class="btn primary" disabled={!name.trim() || !title.trim()}>Save</button></div>
  </form>
</Modal>

<Confirm bind:this={confirm} />

<style>
  .form { display: flex; flex-direction: column; gap: 14px; }
  .form :global(.input) { width: 100%; }
  .row { display: flex; justify-content: flex-end; gap: 8px; }
</style>
