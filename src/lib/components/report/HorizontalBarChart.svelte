<script lang="ts">
	import Maximize2Icon from '@lucide/svelte/icons/maximize-2';
	import * as Dialog from '$lib/components/ui/dialog';

	export let title = '';
	export let expandedTitle = '';
	export let items: Array<{ label: string; value: number }> = [];
	export let xAxisLabel = 'Count';
	export let yAxisLabel = 'Category';
	export let emptyText = 'No data available for the selected filters.';
	export let activeFilters: string[] = [];
	export let expandable = true;

	const PALETTE = [
		'var(--color-chart-1, #e76f51)',
		'var(--color-chart-2, #2a9d8f)',
		'var(--color-chart-3, #457b9d)',
		'var(--color-chart-4, #e9c46a)',
		'var(--color-chart-5, #f4a261)',
		'#8ecae6',
		'#6d597a',
		'#43aa8b',
		'#f94144',
		'#577590'
	];

	function colorAt(index: number): string {
		return PALETTE[index % PALETTE.length];
	}

	let expandedOpen = false;

	function openExpanded() {
		if (!expandable || sorted.length === 0) return;
		expandedOpen = true;
	}

	$: sorted = [...items].sort((a, b) => b.value - a.value);
	$: maxValue = Math.max(0, ...sorted.map((item) => item.value));
	$: resolvedExpandedTitle = expandedTitle || title || 'Chart';
	$: legendItems = sorted.map((item, index) => ({ ...item, color: colorAt(index) }));
</script>

<div class="space-y-3">
	<div class="flex items-center justify-between gap-2">
		{#if title}
			<p class="text-sm font-medium">{title}</p>
		{:else}
			<span></span>
		{/if}
		{#if sorted.length > 0 && expandable}
			<button
				type="button"
				class="inline-flex items-center gap-1 rounded-md border bg-background px-2 py-1 text-xs hover:bg-accent"
				onclick={openExpanded}
				aria-label={`Expand ${resolvedExpandedTitle}`}
			>
				<Maximize2Icon class="size-3.5" />
				Expand
			</button>
		{/if}
	</div>

	{#if sorted.length === 0}
		<div class="flex h-[220px] items-center justify-center rounded-md bg-muted/30 text-sm text-muted-foreground">
			{emptyText}
		</div>
	{:else}
		<button
			type="button"
			class="block w-full cursor-zoom-in text-left"
			onclick={openExpanded}
			disabled={!expandable}
		>
			<div class="space-y-2 rounded-md bg-background p-2">
				{#each sorted as item, index}
					<div class="space-y-1">
						<div class="flex items-center justify-between gap-2 text-xs">
							<p class="truncate font-medium">{item.label}</p>
							<p class="shrink-0 text-muted-foreground">{item.value}</p>
						</div>
						<div class="h-2 rounded bg-muted">
							<div
								class="h-2 rounded"
								style={`width: ${maxValue === 0 ? 0 : (item.value / maxValue) * 100}%; background-color: ${colorAt(index)};`}
							></div>
						</div>
					</div>
				{/each}
			</div>
		</button>
		<div class="flex flex-wrap gap-2 text-xs">
			{#each legendItems as item}
				<span class="inline-flex items-center gap-1 rounded-md border px-2 py-0.5">
					<span class="inline-block size-2 rounded-full" style={`background-color: ${item.color};`}></span>
					{item.label}
				</span>
			{/each}
		</div>
	{/if}
</div>

{#if expandable && sorted.length > 0}
	<Dialog.Root bind:open={expandedOpen}>
		<Dialog.Content class="h-[90vh] max-h-[90vh] w-[95vw] max-w-[95vw] overflow-hidden p-4 sm:max-w-[95vw]">
			<Dialog.Header>
				<Dialog.Title>{resolvedExpandedTitle}</Dialog.Title>
			</Dialog.Header>
			<div class="flex h-[calc(90vh-5rem)] items-start justify-center overflow-auto bg-background p-4">
				<div class="w-full max-w-5xl space-y-3">
					{#if activeFilters.length > 0}
						<div class="flex flex-wrap gap-2">
							{#each activeFilters as filterLabel}
								<span class="inline-flex items-center rounded-md border px-2 py-0.5 text-xs">{filterLabel}</span>
							{/each}
						</div>
					{/if}
					{#each sorted as item, index}
						<div class="space-y-1">
							<div class="flex items-center justify-between gap-2 text-sm">
								<p class="truncate font-medium">{item.label}</p>
								<p class="shrink-0 text-muted-foreground">{item.value}</p>
							</div>
							<div class="h-3 rounded bg-muted">
								<div
									class="h-3 rounded"
									style={`width: ${maxValue === 0 ? 0 : (item.value / maxValue) * 100}%; background-color: ${colorAt(index)};`}
								></div>
							</div>
						</div>
					{/each}
					<div class="flex items-center justify-between text-xs text-muted-foreground">
						<span>{yAxisLabel}</span>
						<span>{xAxisLabel}</span>
					</div>
					<div class="flex flex-wrap gap-2 text-xs">
						{#each legendItems as item}
							<span class="inline-flex items-center gap-1 rounded-md border px-2 py-0.5">
								<span class="inline-block size-2 rounded-full" style={`background-color: ${item.color};`}></span>
								{item.label}
							</span>
						{/each}
					</div>
				</div>
			</div>
		</Dialog.Content>
	</Dialog.Root>
{/if}
