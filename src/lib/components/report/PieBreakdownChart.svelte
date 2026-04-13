<script lang="ts">
	import Maximize2Icon from '@lucide/svelte/icons/maximize-2';
	import * as Dialog from '$lib/components/ui/dialog';
	import { colorForCategory, sortEntriesByValueThenLabel } from '$lib/components/report/chartPalette';

	type ChartItem = { label: string; value: number };
	type Slice = {
		label: string;
		value: number;
		color: string;
		pct: number;
	};
	type PositionedSlice = Slice & {
		labelX: number;
		labelY: number;
		markerX: number;
		markerY: number;
		anchor: 'start' | 'middle' | 'end';
	};

	export let title = '';
	export let expandedTitle = '';
	export let items: ChartItem[] = [];
	export let emptyText = 'No data available for the selected filters.';
	export let activeFilters: string[] = [];
	export let expandable = true;
	export let defaultVisibleCount = 5;

	const INLINE_CHART_SIZE = 280;
	const INLINE_DONUT_SIZE = 160;
	const INLINE_LABEL_RADIUS = 114;
	const INLINE_MARKER_RADIUS = 86;
	const EXPANDED_CHART_SIZE = 420;
	const EXPANDED_DONUT_SIZE = 288;
	const EXPANDED_LABEL_RADIUS = 174;
	const EXPANDED_MARKER_RADIUS = 150;

	let expandedOpen = false;
	let selectedLabels: string[] = [];
	let labelsSignature = '';

	function openExpanded() {
		if (!expandable || selectableLabels.length === 0) return;
		expandedOpen = true;
	}

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

	function gradientForSlices(slices: Slice[], total: number): string {
		if (slices.length === 0) return 'conic-gradient(#e2e8f0 0turn 1turn)';
		let cursor = 0;
		const segments: string[] = [];
		for (const slice of slices) {
			const fraction = total === 0 ? 0 : slice.value / total;
			const next = cursor + fraction;
			segments.push(`${slice.color} ${cursor}turn ${next}turn`);
			cursor = next;
		}
		if (cursor < 1) {
			segments.push(`transparent ${cursor}turn 1turn`);
		}
		return `conic-gradient(${segments.join(', ')})`;
	}

	function buildSlice(label: string, value: number, total: number): Slice {
		return {
			label,
			value,
			color: colorForCategory(label),
			pct: total === 0 ? 0 : (value / total) * 100
		};
	}

	function positionSlices(
		slices: Slice[],
		total: number,
		chartSize: number,
		labelRadius: number,
		markerRadius: number
	): PositionedSlice[] {
		let cursor = 0;
		return slices.map((slice) => {
			const fraction = total === 0 ? 0 : slice.value / total;
			const start = cursor;
			const end = cursor + fraction;
			cursor = end;
			const angle = ((start + end) / 2) * Math.PI * 2 - Math.PI / 2;
			const cos = Math.cos(angle);
			const sin = Math.sin(angle);
			const anchor =
				Math.abs(cos) < 0.18 ? 'middle' : cos > 0 ? ('start' as const) : ('end' as const);
			return {
				...slice,
				labelX: chartSize / 2 + cos * labelRadius,
				labelY: chartSize / 2 + sin * labelRadius,
				markerX: chartSize / 2 + cos * markerRadius,
				markerY: chartSize / 2 + sin * markerRadius,
				anchor
			};
		});
	}

	function labelStyle(slice: PositionedSlice): string {
		const transform =
			slice.anchor === 'start'
				? 'translate(0, -50%)'
				: slice.anchor === 'end'
					? 'translate(-100%, -50%)'
					: 'translate(-50%, -50%)';
		return `left: ${slice.labelX}px; top: ${slice.labelY}px; transform: ${transform};`;
	}

	function labelClass(anchor: PositionedSlice['anchor']): string {
		if (anchor === 'start') return 'text-left';
		if (anchor === 'end') return 'text-right';
		return 'text-center';
	}

	function markerStyle(slice: PositionedSlice): string {
		return `left: ${slice.markerX}px; top: ${slice.markerY}px; transform: translate(-50%, -50%); background-color: ${slice.color};`;
	}

	$: sortedItems = sortEntriesByValueThenLabel(items).filter((item) => item.value > 0);
	$: selectableLabels = sortedItems.map((item) => item.label);
	$: defaultInlineLabels = selectableLabels.slice(0, defaultVisibleCount);
	$: hasHiddenItems = selectableLabels.length > defaultInlineLabels.length;
	$: nextLabelsSignature = selectableLabels.join('\u0000');
	$: if (nextLabelsSignature !== labelsSignature) {
		const available = new Set(selectableLabels);
		const retained = selectedLabels.filter((label) => available.has(label));
		selectedLabels =
			retained.length > 0
				? selectableLabels.filter((label) => retained.includes(label))
				: defaultInlineLabels;
		labelsSignature = nextLabelsSignature;
	}
	$: totalValue = sortedItems.reduce((sum, item) => sum + item.value, 0);
	$: selectedLabelSet = new Set(selectedLabels);
	$: inlineBaseSlices = defaultInlineLabels
		.map((label) => {
			const item = sortedItems.find((entry) => entry.label === label);
			return item ? buildSlice(item.label, item.value, totalValue) : null;
		})
		.filter((slice): slice is Slice => Boolean(slice));
	$: hiddenInlineValue = totalValue - inlineBaseSlices.reduce((sum, slice) => sum + slice.value, 0);
	$: visibleInlineSlices =
		hiddenInlineValue > 0
			? [...inlineBaseSlices, buildSlice('Other', hiddenInlineValue, totalValue)]
			: inlineBaseSlices;
	$: visibleExpandedEntries = sortedItems.filter((item) => selectedLabelSet.has(item.label));
	$: expandedTotalValue = visibleExpandedEntries.reduce((sum, item) => sum + item.value, 0);
	$: visibleExpandedSlices = visibleExpandedEntries.map((item) =>
		buildSlice(item.label, item.value, expandedTotalValue)
	);
	$: inlineGradient = gradientForSlices(visibleInlineSlices, totalValue);
	$: expandedGradient = gradientForSlices(visibleExpandedSlices, expandedTotalValue);
	$: inlinePositionedSlices = positionSlices(
		visibleInlineSlices,
		totalValue,
		INLINE_CHART_SIZE,
		INLINE_LABEL_RADIUS,
		INLINE_MARKER_RADIUS
	);
	$: expandedPositionedSlices = positionSlices(
		visibleExpandedSlices,
		expandedTotalValue,
		EXPANDED_CHART_SIZE,
		EXPANDED_LABEL_RADIUS,
		EXPANDED_MARKER_RADIUS
	);
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
		<button
			type="button"
			class="block w-full cursor-zoom-in text-left"
			onclick={openExpanded}
			disabled={!expandable}
		>
			<div class="flex min-h-[260px] items-center justify-center bg-background p-4">
				<div class="relative mx-auto" style={`width: ${INLINE_CHART_SIZE}px; height: ${INLINE_CHART_SIZE}px;`}>
					<div
						class="absolute left-1/2 top-1/2 rounded-full"
						style={`width: ${INLINE_DONUT_SIZE}px; height: ${INLINE_DONUT_SIZE}px; transform: translate(-50%, -50%); background: ${inlineGradient};`}
					>
						<div class="absolute inset-[22%] flex items-center justify-center rounded-full bg-background text-center">
							<div>
								<p class="text-2xl font-semibold">{totalValue}</p>
								<p class="text-xs text-muted-foreground">Total</p>
							</div>
						</div>
					</div>
					{#each inlinePositionedSlices as slice}
						<div class="pointer-events-none absolute size-2 rounded-full border border-background" style={markerStyle(slice)}></div>
						<div
							class={`pointer-events-none absolute max-w-[106px] rounded-md bg-background/95 px-1.5 py-1 text-[11px] leading-tight shadow-sm ${labelClass(slice.anchor)}`}
							style={labelStyle(slice)}
						>
							<div class="font-medium">{slice.label}</div>
							<div class="text-muted-foreground">{slice.value} | {slice.pct.toFixed(1)}%</div>
						</div>
					{/each}
				</div>
			</div>
		</button>

		{#if hasHiddenItems}
			<p class="text-xs text-muted-foreground">
				Showing top {defaultInlineLabels.length} of {selectableLabels.length} categories. Hidden categories are grouped into "Other". Expand to choose more.
			</p>
		{/if}
	{/if}
</div>

{#if expandable && selectableLabels.length > 0}
	<Dialog.Root bind:open={expandedOpen}>
		<Dialog.Content class="h-[90vh] max-h-[90vh] w-[95vw] max-w-[95vw] overflow-hidden p-4 sm:max-w-[95vw]">
			<Dialog.Header>
				<Dialog.Title>{resolvedExpandedTitle}</Dialog.Title>
			</Dialog.Header>
			<div class="h-[calc(90vh-5rem)] overflow-auto bg-background p-4">
				<div class="mx-auto flex h-full w-full max-w-5xl flex-col gap-3">
					{#if activeFilters.length > 0}
						<div class="flex flex-wrap gap-2">
							{#each activeFilters as filterLabel}
								<span class="inline-flex items-center rounded-md border px-2 py-0.5 text-xs">{filterLabel}</span>
							{/each}
						</div>
					{/if}
					<div class="rounded-md border bg-muted/20 p-3">
						<div class="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
							<span>Showing {visibleExpandedSlices.length} of {selectableLabels.length} categories.</span>
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
											onchange={(event) => setLabelSelected(label, (event.currentTarget as HTMLInputElement).checked)}
										/>
										<span class="inline-block size-2 rounded-full" style={`background-color: ${colorForCategory(label)};`}></span>
										<span class="truncate">{label}</span>
									</label>
								{/each}
							</div>
						{/if}
					</div>
					{#if visibleExpandedSlices.length === 0}
						<div class="flex h-[220px] items-center justify-center rounded-md bg-muted/30 text-sm text-muted-foreground">
							Select at least one category to display the chart.
						</div>
					{:else}
						<div class="flex flex-1 items-center justify-center">
							<div class="relative" style={`width: ${EXPANDED_CHART_SIZE}px; height: ${EXPANDED_CHART_SIZE}px;`}>
								<div
									class="absolute left-1/2 top-1/2 rounded-full"
									style={`width: ${EXPANDED_DONUT_SIZE}px; height: ${EXPANDED_DONUT_SIZE}px; transform: translate(-50%, -50%); background: ${expandedGradient};`}
								>
									<div class="absolute inset-[24%] flex items-center justify-center rounded-full bg-background text-center">
										<div>
											<p class="text-4xl font-semibold">{expandedTotalValue}</p>
											<p class="text-sm text-muted-foreground">Selected Total</p>
										</div>
									</div>
								</div>
								{#each expandedPositionedSlices as slice}
									<div class="pointer-events-none absolute size-2.5 rounded-full border border-background" style={markerStyle(slice)}></div>
									<div
										class={`pointer-events-none absolute max-w-[140px] rounded-md bg-background/95 px-2 py-1.5 text-xs leading-tight shadow-sm ${labelClass(slice.anchor)}`}
										style={labelStyle(slice)}
									>
										<div class="font-medium">{slice.label}</div>
										<div class="text-muted-foreground">{slice.value} | {slice.pct.toFixed(1)}%</div>
									</div>
								{/each}
							</div>
						</div>
					{/if}
				</div>
			</div>
		</Dialog.Content>
	</Dialog.Root>
{/if}
