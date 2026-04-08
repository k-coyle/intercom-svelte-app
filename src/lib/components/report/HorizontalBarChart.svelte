<script lang="ts">
	import Maximize2Icon from '@lucide/svelte/icons/maximize-2';
	import * as Dialog from '$lib/components/ui/dialog';
	import {
		colorForCategory,
		colorWithAlpha,
		sortEntriesByValueThenLabel
	} from '$lib/components/report/chartPalette';

	type ChartItem = { label: string; value: number };
	type DisplayRow = {
		label: string;
		color: string;
		currentValue: number;
		comparisonValue: number;
	};

	export let title = '';
	export let expandedTitle = '';
	export let items: ChartItem[] = [];
	export let comparisonItems: ChartItem[] = [];
	export let showComparison = false;
	export let currentPeriodLabel = 'Current Period';
	export let comparisonPeriodLabel = 'Comparison Period';
	export let currentRangeLabel = '';
	export let comparisonRangeLabel = '';
	export let xAxisLabel = 'Count';
	export let yAxisLabel = 'Category';
	export let emptyText = 'No data available for the selected filters.';
	export let activeFilters: string[] = [];
	export let expandable = true;
	export let defaultVisibleCount = 5;

	const PERIOD_SWATCH_CURRENT = '#334155';
	const PERIOD_SWATCH_COMPARISON = 'rgba(51, 65, 85, 0.45)';

	function setLabelSelected(label: string, selected: boolean): void {
		if (selected) {
			selectedLabels = selectableLabels.filter(
				(entry) => entry === label || selectedLabels.includes(entry)
			);
			return;
		}

		const next = selectedLabels.filter((entry) => entry !== label);
		if (next.length === 0) return;
		selectedLabels = next;
	}

	function selectTopCategories(): void {
		selectedLabels = defaultInlineLabels;
	}

	function selectAllCategories(): void {
		selectedLabels = selectableLabels;
	}

	function rowForLabel(label: string): DisplayRow {
		return {
			label,
			color: colorForCategory(label),
			currentValue: currentMap.get(label) ?? 0,
			comparisonValue: comparisonMap.get(label) ?? 0
		};
	}

	function maxRowValue(rows: DisplayRow[]): number {
		return Math.max(
			0,
			...rows.flatMap((row) =>
				showComparisonData
					? [row.currentValue, row.comparisonValue]
					: [row.currentValue]
			)
		);
	}

	let expandedOpen = false;
	let selectedLabels: string[] = [];
	let labelsSignature = '';

	function openExpanded() {
		if (!expandable || selectableLabels.length === 0) return;
		expandedOpen = true;
	}

	$: sortedCurrent = sortEntriesByValueThenLabel(items);
	$: sortedComparison = sortEntriesByValueThenLabel(comparisonItems);
	$: showComparisonData = showComparison && sortedComparison.length > 0;
	$: currentMap = new Map(sortedCurrent.map((item) => [item.label, item.value]));
	$: comparisonMap = new Map(sortedComparison.map((item) => [item.label, item.value]));
	$: currentLabels = sortedCurrent.map((item) => item.label);
	$: comparisonOnlyLabels = showComparisonData
		? sortedComparison.map((item) => item.label).filter((label) => !currentMap.has(label))
		: [];
	$: selectableLabels = [...currentLabels, ...comparisonOnlyLabels];
	$: defaultInlineLabels =
		currentLabels.length > 0
			? currentLabels.slice(0, defaultVisibleCount)
			: selectableLabels.slice(0, defaultVisibleCount);
	$: hasHiddenItems = selectableLabels.length > defaultInlineLabels.length;
	$: nextLabelsSignature = selectableLabels.join('\u0000');
	$: if (nextLabelsSignature !== labelsSignature) {
		const available = new Set(selectableLabels);
		const retained = selectedLabels.filter((label) => available.has(label));
		selectedLabels = retained.length > 0 ? selectableLabels.filter((label) => retained.includes(label)) : defaultInlineLabels;
		labelsSignature = nextLabelsSignature;
	}
	$: selectedLabelSet = new Set(selectedLabels);
	$: visibleInlineRows = defaultInlineLabels.map(rowForLabel);
	$: visibleExpandedRows = selectableLabels.filter((label) => selectedLabelSet.has(label)).map(rowForLabel);
	$: inlineMaxValue = maxRowValue(visibleInlineRows);
	$: expandedMaxValue = maxRowValue(visibleExpandedRows);
	$: resolvedExpandedTitle = expandedTitle || title || 'Chart';
</script>

<div class="space-y-3">
	<div class="flex items-center justify-between gap-2">
		{#if title}
			<p class="text-sm font-medium">{title}</p>
		{:else}
			<span></span>
		{/if}
		{#if selectableLabels.length > 0 && expandable}
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

	{#if selectableLabels.length === 0}
		<div class="flex h-[220px] items-center justify-center rounded-md bg-muted/30 text-sm text-muted-foreground">
			{emptyText}
		</div>
	{:else}
		{#if showComparisonData}
			<div class="rounded-md border bg-muted/20 p-3 text-xs">
				<div class="flex flex-wrap gap-4">
					<span class="inline-flex items-center gap-2">
						<span class="inline-block h-2.5 w-4 rounded-sm" style={`background-color: ${PERIOD_SWATCH_CURRENT};`}></span>
						{currentPeriodLabel}
					</span>
					<span class="inline-flex items-center gap-2">
						<span class="inline-block h-2.5 w-4 rounded-sm" style={`background-color: ${PERIOD_SWATCH_COMPARISON};`}></span>
						{comparisonPeriodLabel}
					</span>
				</div>
				<div class="mt-2 grid gap-1 text-muted-foreground sm:grid-cols-2">
					<span>{currentPeriodLabel}: {currentRangeLabel}</span>
					<span>{comparisonPeriodLabel}: {comparisonRangeLabel}</span>
				</div>
			</div>
		{/if}

		<button
			type="button"
			class="block w-full cursor-zoom-in text-left"
			onclick={openExpanded}
			disabled={!expandable}
		>
			<div class="space-y-3 bg-background p-2">
				{#each visibleInlineRows as row}
					<div class="space-y-1.5">
						<div class="flex items-center justify-between gap-2 text-xs">
							<p class="truncate font-medium">{row.label}</p>
						</div>
						<div class="space-y-1.5">
							<div class="flex items-center gap-2 text-[11px]">
								{#if showComparisonData}
									<span class="w-20 shrink-0 text-muted-foreground">{currentPeriodLabel}</span>
								{/if}
								<div class="h-2 flex-1 rounded bg-muted">
									<div
										class="h-2 rounded"
										style={`width: ${inlineMaxValue === 0 ? 0 : (row.currentValue / inlineMaxValue) * 100}%; background-color: ${row.color};`}
									></div>
								</div>
								<p class="w-12 shrink-0 text-right text-muted-foreground">{row.currentValue}</p>
							</div>
							{#if showComparisonData}
								<div class="flex items-center gap-2 text-[11px]">
									<span class="w-20 shrink-0 text-muted-foreground">{comparisonPeriodLabel}</span>
									<div class="h-2 flex-1 rounded bg-muted">
										<div
											class="h-2 rounded border"
											style={`width: ${inlineMaxValue === 0 ? 0 : (row.comparisonValue / inlineMaxValue) * 100}%; background-color: ${colorWithAlpha(row.color, 0.45)}; border-color: ${colorWithAlpha(row.color, 0.75)};`}
										></div>
									</div>
									<p class="w-12 shrink-0 text-right text-muted-foreground">{row.comparisonValue}</p>
								</div>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		</button>

		{#if hasHiddenItems}
			<p class="text-xs text-muted-foreground">
				Showing top {visibleInlineRows.length} of {selectableLabels.length} categories. Expand to choose more.
			</p>
		{/if}

		<div class="flex flex-wrap gap-2 text-xs">
			{#each visibleInlineRows as row}
				<span class="inline-flex items-center gap-1 rounded-md border px-2 py-0.5">
					<span class="inline-block size-2 rounded-full" style={`background-color: ${row.color};`}></span>
					{row.label}
				</span>
			{/each}
		</div>
	{/if}
</div>

{#if expandable && selectableLabels.length > 0}
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
					{#if showComparisonData}
						<div class="rounded-md border bg-muted/20 p-3 text-xs">
							<div class="flex flex-wrap gap-4">
								<span class="inline-flex items-center gap-2">
									<span class="inline-block h-2.5 w-4 rounded-sm" style={`background-color: ${PERIOD_SWATCH_CURRENT};`}></span>
									{currentPeriodLabel}
								</span>
								<span class="inline-flex items-center gap-2">
									<span class="inline-block h-2.5 w-4 rounded-sm" style={`background-color: ${PERIOD_SWATCH_COMPARISON};`}></span>
									{comparisonPeriodLabel}
								</span>
							</div>
							<div class="mt-2 grid gap-1 text-muted-foreground sm:grid-cols-2">
								<span>{currentPeriodLabel}: {currentRangeLabel}</span>
								<span>{comparisonPeriodLabel}: {comparisonRangeLabel}</span>
							</div>
						</div>
					{/if}
					<div class="rounded-md border bg-muted/20 p-3">
						<div class="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
							<span>Showing {visibleExpandedRows.length} of {selectableLabels.length} categories.</span>
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
								{#each selectableLabels as label}
									<label class="flex items-center gap-2 rounded-md border bg-background px-2 py-1 text-xs">
										<input
											type="checkbox"
											checked={selectedLabels.includes(label)}
											onchange={(event) =>
												setLabelSelected(label, (event.currentTarget as HTMLInputElement).checked)}
										/>
										<span
											class="inline-block size-2 rounded-full"
											style={`background-color: ${colorForCategory(label)};`}
										></span>
										<span class="truncate">{label}</span>
									</label>
								{/each}
							</div>
						{/if}
					</div>
					{#if visibleExpandedRows.length === 0}
						<div class="flex h-[220px] items-center justify-center rounded-md bg-muted/30 text-sm text-muted-foreground">
							Select at least one category to display the chart.
						</div>
					{:else}
						<div class="space-y-3">
							{#each visibleExpandedRows as row}
								<div class="space-y-2">
									<div class="flex items-center justify-between gap-2 text-sm">
										<p class="truncate font-medium">{row.label}</p>
									</div>
									<div class="space-y-2">
										<div class="flex items-center gap-3 text-xs">
											{#if showComparisonData}
												<span class="w-24 shrink-0 text-muted-foreground">{currentPeriodLabel}</span>
											{/if}
											<div class="h-3 flex-1 rounded bg-muted">
												<div
													class="h-3 rounded"
													style={`width: ${expandedMaxValue === 0 ? 0 : (row.currentValue / expandedMaxValue) * 100}%; background-color: ${row.color};`}
												></div>
											</div>
											<p class="w-14 shrink-0 text-right text-muted-foreground">{row.currentValue}</p>
										</div>
										{#if showComparisonData}
											<div class="flex items-center gap-3 text-xs">
												<span class="w-24 shrink-0 text-muted-foreground">{comparisonPeriodLabel}</span>
												<div class="h-3 flex-1 rounded bg-muted">
													<div
														class="h-3 rounded border"
														style={`width: ${expandedMaxValue === 0 ? 0 : (row.comparisonValue / expandedMaxValue) * 100}%; background-color: ${colorWithAlpha(row.color, 0.45)}; border-color: ${colorWithAlpha(row.color, 0.75)};`}
													></div>
												</div>
												<p class="w-14 shrink-0 text-right text-muted-foreground">{row.comparisonValue}</p>
											</div>
										{/if}
									</div>
								</div>
							{/each}
						</div>
					{/if}
					<div class="flex items-center justify-between text-xs text-muted-foreground">
						<span>{yAxisLabel}</span>
						<span>{xAxisLabel}</span>
					</div>
					<div class="flex flex-wrap gap-2 text-xs">
						{#each visibleExpandedRows as row}
							<span class="inline-flex items-center gap-1 rounded-md border px-2 py-0.5">
								<span class="inline-block size-2 rounded-full" style={`background-color: ${row.color};`}></span>
								{row.label}
							</span>
						{/each}
					</div>
				</div>
			</div>
		</Dialog.Content>
	</Dialog.Root>
{/if}
