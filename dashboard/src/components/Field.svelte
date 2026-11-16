<script lang="ts" module>
  /** What the field hands its input: spread it onto the input, select or textarea. */
  export type FieldAttrs = { id: string; "aria-describedby": string | undefined; "aria-invalid": "true" | undefined; "aria-required": "true" | undefined };
</script>

<script lang="ts">
  // One form field: its label, a star when it is required, a hint, and what
  // is wrong with it right under it (linked to the input for screen readers).
  import type { Snippet } from "svelte";

  let { id, label, required = false, hint = "", error = "", wide = false, children }: {
    id: string;
    label: string;
    required?: boolean;
    hint?: string;
    /** What needs fixing; empty when the field is fine. */
    error?: string;
    /** Spans both columns of a two column form. */
    wide?: boolean;
    children: Snippet<[FieldAttrs]>;
  } = $props();

  const describedby = $derived([error ? `${id}-err` : "", hint ? `${id}-hint` : ""].filter(Boolean).join(" ") || undefined);
</script>

<div class="field" class:invalid={!!error} class:wide>
  <label for={id}>{label}{#if required}<span class="req" aria-hidden="true"> *</span>{/if}</label>
  {@render children({ id, "aria-describedby": describedby, "aria-invalid": error ? "true" : undefined, "aria-required": required ? "true" : undefined })}
  {#if hint}<span id="{id}-hint" class="hint">{hint}</span>{/if}
  {#if error}<span id="{id}-err" class="err">{error}</span>{/if}
</div>

<style>
  .field { min-width: 0; }
  .wide { grid-column: 1 / -1; }
  .req { color: var(--lime); font-weight: 700; }
  .hint { font-size: var(--fs-xs); color: var(--muted); }
  .err { font-size: var(--fs-sm); color: var(--critical); }
  .invalid :global(.input) { border-color: var(--critical); }
</style>
