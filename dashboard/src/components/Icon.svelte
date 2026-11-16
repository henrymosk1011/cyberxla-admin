<script lang="ts" module>
  // The dashboard's small icon set: plain line drawings on a 24 unit grid,
  // drawn in the current text color. They are decoration; the words next to
  // them (or the button's label) carry the meaning.
  const PATHS = {
    close: "M6 6l12 12M18 6 6 18",
    plus: "M12 5v14M5 12h14",
    check: "M5 12.5l4.5 4.5L19 7.5",
    undo: "M4 5v5h5M4.6 10A8 8 0 1 1 6 16.5",
    "arrow-right": "M5 12h14M13 6l6 6-6 6",
    "arrow-left": "M19 12H5M11 6l-6 6 6 6",
    "arrow-up": "M12 19V5M6 11l6-6 6 6",
    "arrow-down": "M12 5v14M6 13l6 6 6-6",
    sort: "M8 9l4-4 4 4M8 15l4 4 4-4",
    menu: "M4 7h16M4 12h16M4 17h16",
    up: "M6 15l6-6 6 6",
    down: "M6 9l6 6 6-6",
    grip: "M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01",
  } as const;
  export type IconName = keyof typeof PATHS;
</script>

<script lang="ts">
  let { name, size = 16 }: { name: IconName; /** Width and height in pixels. */ size?: number } = $props();
</script>

<svg class="icon" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" stroke-width={name === "grip" ? 3 : 2} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={PATHS[name]} /></svg>

<style>
  .icon { display: inline-block; flex: none; vertical-align: -0.15em; }
</style>
