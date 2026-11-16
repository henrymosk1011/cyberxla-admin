<script lang="ts">
  // The three Reports pages, as one row of tabs under the page title.
  let { current }: { current: "reports" | "template" | "settings" } = $props();

  const tabs = [
    { id: "reports", href: "#/reports", label: "Reports" },
    { id: "template", href: "#/reports/template", label: "Template" },
    { id: "settings", href: "#/reports/settings", label: "Settings" },
  ] as const;
</script>

<nav class="subnav" aria-label="Reports pages">
  {#each tabs as t (t.id)}
    <a href={t.href} aria-current={current === t.id ? "page" : undefined}>{t.label}</a>
  {/each}
</nav>

<style>
  .subnav { display: flex; gap: 4px; margin: -4px 0 20px; border-bottom: 1px solid var(--line); }
  a { padding: 10px 14px; margin-bottom: -1px; border-bottom: 2px solid transparent; border-radius: 8px 8px 0 0; font-size: 14px; font-weight: 600; color: var(--text-2); text-decoration: none; transition: color 0.15s, background 0.15s; }
  a:hover { color: var(--text); background: var(--surface); }
  a[aria-current="page"] { color: var(--text); border-bottom-color: var(--lime); }
</style>
