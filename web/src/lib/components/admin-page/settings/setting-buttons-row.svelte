<script lang="ts">
  import Button from '$lib/components/elements/buttons/button.svelte';
  import { createEventDispatcher } from 'svelte';

  const dispatch = createEventDispatcher();

  export let showResetToDefault = true;
</script>

<div class="mt-8 flex justify-between gap-2">
  <div class="left">
    {#if showResetToDefault}
      <button
        on:click={() => dispatch('reset-to-default')}
        class="bg-none text-sm font-medium text-immich-primary hover:text-immich-primary/75 dark:text-immich-dark-primary hover:dark:text-immich-dark-primary/75"
      >
        Reset to default
      </button>
    {/if}
  </div>

  <div class="right">
    <Button size="sm" color="gray" on:click={() => dispatch('reset')}>Reset</Button>
    <Button size="sm" on:click={() => dispatch('save')}>Save</Button>
  </div>
</div>
