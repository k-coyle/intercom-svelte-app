<script lang="ts">
	import type { ServiceCodeSessionRow } from '$lib/client/overview-report';

	export let rows: ServiceCodeSessionRow[] = [];
	export let maxBars: number = 6;

	$: displayed = rows.slice(0, Math.max(1, maxBars));
	$: maxCount = displayed.reduce((best, row) => Math.max(best, row.count), 0);
	$: total = displayed.reduce((sum, row) => sum + row.count, 0);

	function barColor(index: number): string {
		const colorIndex = (index % 5) + 1;
		return `var(--color-chart-${colorIndex})`;
	}
</script>

{#if displayed.length === 0}
	<div class="flex h-[240px] items-center justify-center rounded-md bg-muted/30 text-sm text-muted-foreground">
		No MTD session rows available.
	</div>
{:else}
	<div class="space-y-3">
		<p class="text-xs text-muted-foreground">
			All session channels grouped by Service Code (MTD). Total shown: {total}
		</p>
		<div class="space-y-3">
			{#each displayed as row, index}
				<div class="space-y-1">
					<div class="flex items-center justify-between gap-3 text-xs">
						<p class="truncate font-medium">{row.serviceCode}</p>
						<p class="shrink-0 text-muted-foreground">{row.count} ({row.sharePct.toFixed(1)}%)</p>
					</div>
					<div class="h-2 rounded bg-muted">
						<div
							class="h-2 rounded"
							style={`width: ${maxCount === 0 ? 0 : (row.count / maxCount) * 100}%; background-color: ${barColor(index)};`}
						></div>
					</div>
				</div>
			{/each}
		</div>
	</div>
{/if}
