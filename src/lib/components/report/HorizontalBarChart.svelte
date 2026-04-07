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
	export let defaultVisibleCount = 5;

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

	function setLabelSelected(label: string, selected: boolean): void {
		if (selected) {
			selectedLabels = sorted
				.map((item) => item.label)
				.filter((entry) => entry === label || selectedLabels.includes(entry));
			return;
		}

		const next = selectedLabels.filter((entry) => entry !== label);
		if (next.length === 0) return;
		selectedLabels = next;
	}

	function selectTopCategories(): void {
		selectedLabels = sorted.slice(0, defaultVisibleCount).map((item) => item.label);
	}

	function selectAllCategories(): void {
		selectedLabels = sorted.map((item) => item.label);
	}

	let expandedOpen = false;
	let selectedLabels: string[] = [];
	let labelsSignature = '';

	function openExpanded() {
		if (!expandable || sorted.length === 0) return;
		expandedOpen = true;
	}

	$: sorted = [...items].sort((a, b) => {
		if (b.value !== a.value) return b.value - a.value;
		return a.label.localeCompare(b.label);
	});
	$: visibleInlineItems = sorted.slice(0, defaultVisibleCount);
	$: hasHiddenItems = sorted.length > visibleInlineItems.length;
	$: nextLabelsSignature = sorted.map((item) => item.label).join('\u0000');
	$: if (nextLabelsSignature !== labelsSignature) {
		const available = new Set(sorted.map((item) => item.label));
		const retained = selectedLabels.filter((label) => available.has(label));
		selectedLabels =
			retained.length > 0
				? sorted.map((item) => item.label).filter((label) => retained.includes(label))
				: visibleInlineItems.map((item) => item.label);
		labelsSignature = nextLabelsSignature;
	}
	$: selectedLabelSet = new Set(selectedLabels);
	$: visibleExpandedItems = sorted.filter((item) => selectedLabelSet.has(item.label));
	$: inlineMaxValue = Math.max(0, ...visibleInlineItems.map((item) => item.value));
	$: expandedMaxValue = Math.max(0, ...visibleExpandedItems.map((item) => item.value));
	$: resolvedExpandedTitle = expandedTitle || title || 'Chart';
	$: colorByLabel = new Map(sorted.map((item, index) => [item.label, colorAt(index)]));
	$: inlineLegendItems = visibleInlineItems.map((item) => ({
		...item,
		color: colorByLabel.get(item.label) ?? colorAt(0)
	}));
	$: expandedLegendItems = visibleExpandedItems.map((item) => ({
		...item,
		color: colorByLabel.get(item.label) ?? colorAt(0)
	}));
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
			<div class="space-y-2 bg-background p-2">
				{#each visibleInlineItems as item}
					<div class="space-y-1">
						<div class="flex items-center justify-between gap-2 text-xs">
							<p class="truncate font-medium">{item.label}</p>
							<p class="shrink-0 text-muted-foreground">{item.value}</p>
						</div>
						<div class="h-2 rounded bg-muted">
							<div
								class="h-2 rounded"
								style={`width: ${inlineMaxValue === 0 ? 0 : (item.value / inlineMaxValue) * 100}%; background-color: ${colorByLabel.get(item.label) ?? colorAt(0)};`}
							></div>
						</div>
					</div>
				{/each}
			</div>
		</button>
		{#if hasHiddenItems}
			<p class="text-xs text-muted-foreground">
				Showing top {visibleInlineItems.length} of {sorted.length} categories. Expand to choose more.
			</p>
		{/if}
		<div class="flex flex-wrap gap-2 text-xs">
			{#each inlineLegendItems as item}
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
					<div class="rounded-md border bg-muted/20 p-3">
						<div class="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
							<span>
								Showing {visibleExpandedItems.length} of {sorted.length} categories.
							</span>
							{#if hasHiddenItems}
								<div class="flex items-center gap-2">
									<button
										type="button"
										class="rounded-md border bg-background px-2 py-1 text-foreground hover:bg-accent"
										onclick={selectTopCategories}
									>
										Top {defaultVisibleCount}
									</button>
									<button
										type="button"
										class="rounded-md border bg-background px-2 py-1 text-foreground hover:bg-accent"
										onclick={selectAllCategories}
									>
										All Categories
									</button>
								</div>
							{/if}
						</div>
						{#if hasHiddenItems}
							<div class="mt-3 grid max-h-40 gap-2 overflow-auto sm:grid-cols-2 lg:grid-cols-3">
								{#each sorted as item}
									<label class="flex items-center gap-2 rounded-md border bg-background px-2 py-1 text-xs">
										<input
											type="checkbox"
											checked={selectedLabels.includes(item.label)}
											onchange={(event) =>
												setLabelSelected(
													item.label,
													(event.currentTarget as HTMLInputElement).checked
												)}
										/>
										<span
											class="inline-block size-2 rounded-full"
											style={`background-color: ${colorByLabel.get(item.label) ?? colorAt(0)};`}
										></span>
										<span class="truncate">{item.label}</span>
									</label>
								{/each}
							</div>
						{/if}
					</div>
					{#if visibleExpandedItems.length === 0}
						<div class="flex h-[220px] items-center justify-center rounded-md bg-muted/30 text-sm text-muted-foreground">
							Select at least one category to display the chart.
						</div>
					{:else}
						{#each visibleExpandedItems as item}
							<div class="space-y-1">
								<div class="flex items-center justify-between gap-2 text-sm">
									<p class="truncate font-medium">{item.label}</p>
									<p class="shrink-0 text-muted-foreground">{item.value}</p>
								</div>
								<div class="h-3 rounded bg-muted">
									<div
										class="h-3 rounded"
										style={`width: ${expandedMaxValue === 0 ? 0 : (item.value / expandedMaxValue) * 100}%; background-color: ${colorByLabel.get(item.label) ?? colorAt(0)};`}
									></div>
								</div>
							</div>
						{/each}
					{/if}
					<div class="flex items-center justify-between text-xs text-muted-foreground">
						<span>{yAxisLabel}</span>
						<span>{xAxisLabel}</span>
					</div>
					<div class="flex flex-wrap gap-2 text-xs">
						{#each expandedLegendItems as item}
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
