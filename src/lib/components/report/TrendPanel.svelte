<script lang="ts">
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import { Button } from '$lib/components/ui/button';

	export let title: string = 'Trend';
	export let timeframe: string = 'Last 30 days';
</script>

<div class="space-y-3">
	<div class="flex items-center justify-between gap-2">
		<p class="text-sm font-medium">{title}</p>
		<Button variant="outline" size="sm" class="gap-1 text-xs">
			<span>{timeframe}</span>
			<ChevronDownIcon class="size-3.5" />
		</Button>
	</div>
	<div
		class="flex h-[240px] items-center justify-center rounded-md bg-muted/30 text-sm text-muted-foreground"
	>
		Chart placeholder
	</div>
</div>
