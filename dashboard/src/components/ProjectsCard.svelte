<script lang="ts">
  // A lead's or client's projects, and a quick way to start a new one.
  import db from "$db";
  import { shortDate, STATUS_LABEL } from "../lib/format.ts";
  import { totalsBy, valueLabel } from "../lib/lines.ts";
  import type { Project, ProjectService } from "../lib/types.ts";

  let { projects, lines, owner, noun }: {
    projects: Project[];
    lines: ProjectService[];
    owner: { lead_id: string | null; client_id: string | null };
    /** "client" or "lead" */
    noun: string;
  } = $props();

  let name = $state("");
  let busy = $state(false);
  let error = $state("");

  const totals = $derived(totalsBy(lines, (l) => l.project_id));
  const rows = $derived([...projects].sort((a, b) => order(a) - order(b) || b.updated_at.localeCompare(a.updated_at)));
  // Open work first, finished and cancelled last.
  const order = (p: Project) => (p.status === "done" ? 1 : p.status === "cancelled" ? 2 : 0);

  async function create(e: SubmitEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    busy = true;
    error = "";
    try {
      const id = await db.createProject({ ...owner, name: name.trim(), status: "potential", due_on: null, notes: null });
      location.hash = `#/projects/${id}`;
    } catch (err) {
      error = err instanceof Error ? err.message : "Couldn't create the project.";
      busy = false;
    }
  }
</script>

<section class="card">
  <div class="card-head"><div><h2>Projects</h2><p class="sub">Work you could do or are doing for this {noun}, with its services, notes and credentials.</p></div></div>
  {#if rows.length}
    <ul class="plist">
      {#each rows as p (p.id)}
        <li class:closed={p.status === "done" || p.status === "cancelled"}>
          <a href="#/projects/{p.id}">
            <span class="pname">{p.name}</span>
            <span class="pstatus ps-{p.status}"><i aria-hidden="true"></i>{STATUS_LABEL[p.status]}</span>
            <span class="pval num">{valueLabel(totals.get(p.id))}</span>
            <span class="pdue muted">{p.due_on ? `Due ${shortDate(p.due_on + "T12:00:00")}` : ""}</span>
          </a>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="muted none">No projects yet.</p>
  {/if}
  <form class="newp" onsubmit={create}>
    <input class="input" placeholder="New project, e.g. Office network refresh" maxlength="120" aria-label="New project name" bind:value={name} />
    <button class="btn sm" disabled={busy || !name.trim()}>{busy ? "Adding…" : "Add project"}</button>
  </form>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</section>

<style>
  .plist { list-style: none; margin: -4px 0 12px; }
  .plist li { border-top: 1px solid var(--line); animation: rise 0.3s var(--ease) both; }
  .plist li:first-child { border-top: 0; }
  .plist a { display: grid; grid-template-columns: minmax(0, 1fr) auto auto 92px; gap: 12px; align-items: center; padding: 10px 6px; border-radius: 8px; text-decoration: none; transition: background 0.12s; }
  .plist a:hover { background: var(--surface-2); }
  .plist li.closed a { opacity: 0.6; }
  .pname { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pval { font-weight: 600; text-align: right; }
  .pdue { font-size: 12px; text-align: right; }
  .pstatus { display: inline-flex; align-items: center; gap: 7px; font-size: 13px; color: var(--text-2); white-space: nowrap; }
  .pstatus i { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
  .ps-potential i { background: var(--st-new); } .ps-proposed i { background: var(--st-proposal); } .ps-in_progress i { background: var(--st-contacted); }
  .ps-on_hold i { background: var(--warning); } .ps-done i { background: var(--good); } .ps-cancelled i { background: var(--st-lost); }
  .none { font-size: 14px; margin-bottom: 12px; }
  .newp { display: flex; gap: 8px; }
  .newp .input { flex: 1; min-width: 0; height: 36px; }
  .newp .btn { height: 36px; }
  .error { margin-top: 8px; }
  @media (max-width: 640px) {
    .plist a { grid-template-columns: minmax(0, 1fr) auto; gap: 4px 12px; }
    .pval { text-align: left; font-size: 13px; }
  }
</style>
