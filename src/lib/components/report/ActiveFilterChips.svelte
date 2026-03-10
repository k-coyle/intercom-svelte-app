<script lang="ts">
	import XIcon from '@lucide/svelte/icons/x';
	import { Button } from '$lib/components/ui/button';

	type FilterChip = {
		key: string;
		label: string;
		onRemove: () => void;
	};

	export let chips: FilterChip[] = [];
</script>

{#if chips.length > 0}
	<div class="flex flex-wrap gap-1.5">
		{#each chips as chip (chip.key)}
			<Button variant="outline" size="sm" class="h-7 gap-1 rounded-full text-xs" onclick={chip.onRemove}>
				<span>{chip.label}</span>
				<XIcon class="size-3" />
			</Button>
		{/each}
	</div>
{/if}
