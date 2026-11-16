<script lang="ts">
  // The timeline card on a lead, client, project or report: what happened,
  // newest first. Where entries can be removed from the timeline (they are
  // only hidden; the record stays), a button shows the removed ones again.
  import Icon from "./Icon.svelte";
  import { dateTime } from "../lib/format.ts";
  import type { AuditEntry } from "../lib/types.ts";

  let { activity, describe, ontoggle, title = "Activity", empty = "No activity yet.", note }: {
    activity: AuditEntry[];
    /** The entry in words; null leaves it off the timeline. */
    describe: (a: AuditEntry) => string | null;
    /** Remove an entry from the timeline, or put it back. Without it, entries can't be removed. */
    ontoggle?: (a: AuditEntry) => void;
    title?: string;
    empty?: string;
    /** Extra words after an entry's time. */
    note?: (a: AuditEntry) => string;
  } = $props();

  let showHidden = $state(false);
  const entries = $derived(activity.map((a) => ({ a, text: describe(a) })).filter((e) => e.text !== null));
  const visible = $derived(entries.filter((e) => showHidden || !e.a.hidden));
  const hiddenCount = $derived(entries.filter((e) => e.a.hidden).length);
</script>

<section class="card">
  <div class="card-head">
    <h2>{title}</h2>
    {#if hiddenCount}<button class="btn ghost sm" onclick={() => (showHidden = !showHidden)}>{showHidden ? "Hide" : "Show"} removed ({hiddenCount})</button>{/if}
  </div>
  <ol class="timeline">
    {#each visible as e (e.a.id)}
      <li class:removed={e.a.hidden}>
        <span class="dot" aria-hidden="true"></span>
        <div><p>{e.text}</p><span class="when">{dateTime(e.a.at)}{e.a.hidden ? " · removed" : ""}{note ? note(e.a) : ""}</span></div>
        {#if ontoggle}
          <button class="iconbtn" title={e.a.hidden ? "Put back on the timeline" : "Remove from timeline"} aria-label={e.a.hidden ? "Restore this entry" : "Remove this entry from the timeline"} onclick={() => ontoggle(e.a)}><Icon name={e.a.hidden ? "undo" : "close"} /></button>
        {/if}
      </li>
    {:else}
      <li class="none">{empty}</li>
    {/each}
  </ol>
</section>

<style>
  .timeline { list-style: none; display: flex; flex-direction: column; gap: 14px; }
  li { display: flex; gap: 12px; font-size: var(--fs-sm); align-items: flex-start; }
  li > div { flex: 1; min-width: 0; }
  .dot { width: 8px; height: 8px; margin-top: 6px; border-radius: 50%; background: var(--axis); flex: none; }
  li:first-child .dot { background: var(--lime); }
  .when { font-size: var(--fs-xs); color: var(--muted); }
  .none { color: var(--muted); }
  .removed p { color: var(--muted); }
  /* The remove button shows on hover or keyboard focus, and always on touch screens and removed entries. */
  .iconbtn { margin: -4px -4px 0 0; opacity: 0; }
  li:hover .iconbtn, .iconbtn:focus-visible, .removed .iconbtn { opacity: 1; }
  @media (hover: none) { .iconbtn { opacity: 1; } }
</style>
