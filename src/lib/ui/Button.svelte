<script lang="ts">
  export let variant: 'primary' | 'secondary' = 'primary';
  export let type: 'button' | 'submit' | 'reset' = 'button';
  export let disabled = false;
</script>

<button
  {type}
  class={variant === 'primary' ? 'primary' : 'secondary'}
  {disabled}
>
  <slot />
</button>
