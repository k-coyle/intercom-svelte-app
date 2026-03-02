<script lang="ts">
	import KpiSparkCard from './KpiSparkCard.svelte';
	import type { KpiItem } from './engagementReportConfig';

	export let items: KpiItem[] = [];
	export let showDelta = false;
</script>

<div class={`grid gap-4 sm:grid-cols-2 ${items.length >= 4 ? 'lg:grid-cols-4' : 'lg:grid-cols-3'}`}>
	{#each items as item}
		<KpiSparkCard
			label={item.label}
			value={item.value}
			deltaLabel={item.deltaLabel}
			deltaPct={item.deltaPct}
			trend={item.trend}
			{showDelta}
		/>
	{/each}
</div>
