<script lang="ts">
  // An email's HTML, shown as it will look, inside the dashboard's strict
  // Content-Security-Policy (no inline styles): the email's inline styles are
  // moved to data attributes while parsing and applied through CSSOM in a
  // shadow root, so nothing in the dashboard can restyle it, and it can't
  // restyle the dashboard.
  let { html, label }: { html: string; label: string } = $props();
  let host = $state<HTMLDivElement | null>(null);

  $effect(() => {
    if (!host) return;
    const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("script, style, link, meta, title").forEach((n) => n.remove());
    doc.querySelectorAll<HTMLElement>("[style]").forEach((el) => { el.dataset.css = el.getAttribute("style") ?? ""; el.removeAttribute("style"); });
    const wrap = document.createElement("div");
    const bodyCss = doc.body.dataset.css ?? "";
    for (const child of [...doc.body.childNodes]) wrap.appendChild(document.importNode(child, true));
    root.replaceChildren(wrap);
    wrap.style.cssText = bodyCss;
    wrap.querySelectorAll<HTMLElement>("[data-css]").forEach((el) => { el.style.cssText = el.dataset.css ?? ""; delete el.dataset.css; });
    wrap.querySelectorAll("a").forEach((a) => { a.target = "_blank"; a.rel = "noopener noreferrer"; });
  });
</script>

<!-- It scrolls, so it takes keyboard focus (WCAG 2.1.1): the arrow keys scroll it. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div class="email" role="region" aria-label={label} tabindex="0" bind:this={host}></div>

<style>
  .email { height: 420px; overflow: auto; border: 1px solid var(--line-2); border-radius: var(--radius-md); background: #e3e7e6; color: #111315; }
</style>
