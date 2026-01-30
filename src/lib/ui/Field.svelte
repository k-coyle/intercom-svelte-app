<script lang="ts">
  export let id: string;
  export let label: string | null = null;
  export let type: string = 'text';
  export let value: string | number = '';
  export let placeholder: string = '';
  export let disabled = false;
  export let required = false;
  export let helper: string | null = null;
  export let error: string | null = null;
  export let name: string | null = null;

  // Pass through extra attributes (e.g., min, max, step)
  export let attrs: Record<string, string | number | boolean | undefined> = {};
</script>

<div class="filter-group">
  {#if label}
    <label for={id}>{label}{required ? ' *' : ''}</label>
  {/if}

  <input
    id={id}
    name={name ?? id}
    {type}
    bind:value
    {placeholder}
    {disabled}
    aria-invalid={error ? 'true' : 'false'}
    {...attrs}
  />

  {#if error}
    <div class="error">{error}</div>
  {:else if helper}
    <div class="muted">{helper}</div>
  {/if}
</div>
