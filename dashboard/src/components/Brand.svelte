<script lang="ts">
  let { admin = false, size = 20 }: { admin?: boolean; size?: number } = $props();
</script>

<span class="brand" style:font-size="{size}px"><span>cyber</span><span class="x">x</span><span>LA</span>{#if admin}<span class="admin">Admin</span>{/if}</span>

<style>
  .brand { display: inline-flex; align-items: baseline; font-weight: 800; letter-spacing: -0.02em; color: var(--bone); white-space: nowrap; line-height: 1; }
  .x { color: var(--lime); }
  .admin { margin-left: 0.4em; font-weight: 600; font-size: 0.7em; letter-spacing: 0; color: var(--muted); }
</style>
