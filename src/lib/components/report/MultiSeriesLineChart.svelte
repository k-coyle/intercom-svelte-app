<script lang="ts">
	import Maximize2Icon from '@lucide/svelte/icons/maximize-2';
	import * as Dialog from '$lib/components/ui/dialog';

	export let title = '';
	export let expandedTitle = '';
	export let dates: string[] = [];
	export let series: Array<{ name: string; values: Array<number | null> }> = [];
	export let xAxisLabel = 'Date';
	export let yAxisLabel = 'Count';
	export let emptyText = 'No data available for the selected filters.';
	export let activeFilters: string[] = [];
	export let expandable = true;
	export let defaultVisibleCount = 5;

	type Dims = {
		svgWidth: number;
		svgHeight: number;
		paddingLeft: number;
		paddingRight: number;
		paddingTop: number;
		paddingBottom: number;
	};

	type RankedSeries = {
		name: string;
		values: Array<number | null>;
		total: number;
	};

	const INLINE_DIMS: Dims = {
		svgWidth: 720,
		svgHeight: 260,
		paddingLeft: 40,
		paddingRight: 12,
		paddingTop: 10,
		paddingBottom: 52
	};

	const EXPANDED_DIMS: Dims = {
		svgWidth: 1400,
		svgHeight: 540,
		paddingLeft: 52,
		paddingRight: 20,
		paddingTop: 48,
		paddingBottom: 112
	};

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

	let expandedOpen = false;
	let selectedSeriesNames: string[] = [];
	let seriesSignature = '';

	function colorAt(index: number): string {
		return PALETTE[index % PALETTE.length];
	}

	function plotWidth(dims: Dims): number {
		return dims.svgWidth - dims.paddingLeft - dims.paddingRight;
	}

	function plotHeight(dims: Dims): number {
		return dims.svgHeight - dims.paddingTop - dims.paddingBottom;
	}

	function normalizedValue(value: unknown): number | null {
		if (value == null) return null;
		const n = Number(value);
		if (!Number.isFinite(n) || n < 0) return null;
		return n;
	}

	function xAt(index: number, points: number, dims: Dims): number {
		if (points <= 1) return dims.paddingLeft;
		return dims.paddingLeft + (index / (points - 1)) * plotWidth(dims);
	}

	function yAt(value: number, maxValue: number, dims: Dims): number {
		if (maxValue <= 0) return dims.paddingTop + plotHeight(dims);
		return dims.paddingTop + plotHeight(dims) - (value / maxValue) * plotHeight(dims);
	}

	function formatDateLabel(value: string): string {
		const date = new Date(`${value}T00:00:00Z`);
		if (Number.isNaN(date.getTime())) return value;
		return date.toISOString().slice(0, 10);
	}

	function xTickIndices(count: number, maxTicks: number): number[] {
		if (count <= 0) return [];
		if (count <= maxTicks) return Array.from({ length: count }, (_, i) => i);

		const step = Math.max(1, Math.ceil(count / maxTicks));
		const out: number[] = [0];
		for (let i = step; i < count - 1; i += step) out.push(i);
		if (out[out.length - 1] !== count - 1) out.push(count - 1);
		return out;
	}

	function buildYTicks(maxValue: number): number[] {
		return [0, Math.round(maxValue * 0.25), Math.round(maxValue * 0.5), Math.round(maxValue * 0.75), maxValue];
	}

	function totalDefined(values: Array<number | null>): number {
		return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
	}

	function maxDefinedValues(entries: RankedSeries[]): number {
		const numbers = entries.flatMap((entry) => entry.values).filter((value): value is number => value != null);
		return Math.max(0, ...numbers);
	}

	function polylineSegments(values: Array<number | null>, maxValue: number, dims: Dims): string[] {
		const segments: string[] = [];
		let current: string[] = [];
		for (let index = 0; index < values.length; index += 1) {
			const value = values[index];
			if (value == null) {
				if (current.length > 1) segments.push(current.join(' '));
				current = [];
				continue;
			}
			current.push(`${xAt(index, pointCount, dims)},${yAt(value, maxValue, dims)}`);
		}
		if (current.length > 1) segments.push(current.join(' '));
		return segments;
	}

	function setSeriesSelected(name: string, selected: boolean): void {
		if (selected) {
			selectedSeriesNames = rankedSeries
				.map((entry) => entry.name)
				.filter((entryName) => entryName === name || selectedSeriesNames.includes(entryName));
			return;
		}

		const next = selectedSeriesNames.filter((entryName) => entryName !== name);
		if (next.length === 0) return;
		selectedSeriesNames = next;
	}

	function selectTopCategories(): void {
		selectedSeriesNames = rankedSeries.slice(0, defaultVisibleCount).map((entry) => entry.name);
	}

	function selectAllCategories(): void {
		selectedSeriesNames = rankedSeries.map((entry) => entry.name);
	}

	function openExpanded() {
		if (!expandable) return;
		expandedOpen = true;
	}

	$: pointCount = dates.length;
	$: rankedSeries = series
		.map((entry) => {
			const values = dates.map((_, index) => normalizedValue(entry.values[index]));
			return {
				name: entry.name,
				values,
				total: totalDefined(values)
			} satisfies RankedSeries;
		})
		.filter((entry) => entry.values.some((value) => value != null))
		.sort((a, b) => {
			if (b.total !== a.total) return b.total - a.total;
			return a.name.localeCompare(b.name);
		});
	$: visibleInlineSeries = rankedSeries.slice(0, defaultVisibleCount);
	$: hasHiddenSeries = rankedSeries.length > visibleInlineSeries.length;
	$: nextSeriesSignature = rankedSeries.map((entry) => entry.name).join('\u0000');
	$: if (nextSeriesSignature !== seriesSignature) {
		const available = new Set(rankedSeries.map((entry) => entry.name));
		const retained = selectedSeriesNames.filter((name) => available.has(name));
		selectedSeriesNames =
			retained.length > 0
				? rankedSeries.map((entry) => entry.name).filter((name) => retained.includes(name))
				: visibleInlineSeries.map((entry) => entry.name);
		seriesSignature = nextSeriesSignature;
	}
	$: selectedSeriesSet = new Set(selectedSeriesNames);
	$: visibleExpandedSeries = rankedSeries.filter((entry) => selectedSeriesSet.has(entry.name));
	$: inlineMaxValue = maxDefinedValues(visibleInlineSeries);
	$: expandedMaxValue = maxDefinedValues(visibleExpandedSeries);
	$: inlineYTicks = buildYTicks(inlineMaxValue);
	$: expandedYTicks = buildYTicks(expandedMaxValue);
	$: inlineXTicks = xTickIndices(dates.length, 12);
	$: expandedXTicks = xTickIndices(dates.length, 28);
	$: hasData = dates.length > 0 && rankedSeries.length > 0;
	$: resolvedExpandedTitle = expandedTitle || title || 'Chart';
	$: colorBySeries = new Map(rankedSeries.map((entry, index) => [entry.name, colorAt(index)]));
</script>

<div class="space-y-3">
	<div class="flex items-center justify-between gap-2">
		{#if title}
			<p class="text-sm font-medium">{title}</p>
		{:else}
			<span></span>
		{/if}
		{#if hasData && expandable}
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

	{#if !hasData}
		<div class="flex h-[220px] items-center justify-center rounded-md bg-muted/30 text-sm text-muted-foreground">
			{emptyText}
		</div>
	{:else}
		<div class="space-y-2">
			<button
				type="button"
				class="block w-full cursor-zoom-in text-left"
				onclick={openExpanded}
				disabled={!expandable}
			>
				<div class="bg-background p-2">
					<svg
						viewBox={`0 0 ${INLINE_DIMS.svgWidth} ${INLINE_DIMS.svgHeight}`}
						class="h-[260px] w-full"
					>
						<title>{title || 'Line chart'}</title>
						<desc>{`${yAxisLabel} by ${xAxisLabel}`}</desc>
						<line
							x1={INLINE_DIMS.paddingLeft}
							y1={INLINE_DIMS.paddingTop + plotHeight(INLINE_DIMS)}
							x2={INLINE_DIMS.paddingLeft + plotWidth(INLINE_DIMS)}
							y2={INLINE_DIMS.paddingTop + plotHeight(INLINE_DIMS)}
							stroke="hsl(var(--border))"
							stroke-width="1"
						/>
						<line
							x1={INLINE_DIMS.paddingLeft}
							y1={INLINE_DIMS.paddingTop}
							x2={INLINE_DIMS.paddingLeft}
							y2={INLINE_DIMS.paddingTop + plotHeight(INLINE_DIMS)}
							stroke="hsl(var(--border))"
							stroke-width="1"
						/>

						{#each inlineYTicks as tick}
							<line
								x1={INLINE_DIMS.paddingLeft}
								y1={yAt(tick, inlineMaxValue, INLINE_DIMS)}
								x2={INLINE_DIMS.paddingLeft + plotWidth(INLINE_DIMS)}
								y2={yAt(tick, inlineMaxValue, INLINE_DIMS)}
								stroke="hsl(var(--border))"
								stroke-width="0.6"
								stroke-dasharray="3 3"
							/>
							<text
								x={INLINE_DIMS.paddingLeft - 6}
								y={yAt(tick, inlineMaxValue, INLINE_DIMS) + 4}
								text-anchor="end"
								font-size="10"
								fill="hsl(var(--muted-foreground))"
							>
								{tick}
							</text>
						{/each}

						{#each visibleInlineSeries as entry}
							{#each polylineSegments(entry.values, inlineMaxValue, INLINE_DIMS) as points}
								<polyline
									fill="none"
									stroke={colorBySeries.get(entry.name) ?? colorAt(0)}
									stroke-width="2"
									points={points}
								/>
							{/each}
							{#each entry.values as value, valueIndex}
								{#if value != null}
									<circle
										cx={xAt(valueIndex, pointCount, INLINE_DIMS)}
										cy={yAt(value, inlineMaxValue, INLINE_DIMS)}
										r="3"
										fill={colorBySeries.get(entry.name) ?? colorAt(0)}
									/>
									<text
										x={xAt(valueIndex, pointCount, INLINE_DIMS)}
										y={yAt(value, inlineMaxValue, INLINE_DIMS) - 7}
										font-size="9"
										text-anchor="middle"
										fill={colorBySeries.get(entry.name) ?? colorAt(0)}
									>
										{value}
									</text>
								{/if}
							{/each}
						{/each}

						{#each inlineXTicks as idx}
							<text
								x={xAt(idx, pointCount, INLINE_DIMS)}
								y={INLINE_DIMS.paddingTop + plotHeight(INLINE_DIMS) + 26}
								text-anchor="end"
								font-size="10"
								fill="hsl(var(--muted-foreground))"
								transform={`rotate(-40 ${xAt(idx, pointCount, INLINE_DIMS)} ${INLINE_DIMS.paddingTop + plotHeight(INLINE_DIMS) + 26})`}
							>
								{formatDateLabel(dates[idx])}
							</text>
						{/each}
					</svg>
				</div>
			</button>

			{#if hasHiddenSeries}
				<p class="text-xs text-muted-foreground">
					Showing top {visibleInlineSeries.length} of {rankedSeries.length} categories. Expand to choose more.
				</p>
			{/if}

			<div class="flex flex-wrap gap-2 text-xs">
				{#each visibleInlineSeries as entry}
					<span class="inline-flex items-center gap-1 rounded-md border px-2 py-0.5">
						<span
							class="inline-block size-2 rounded-full"
							style={`background-color: ${colorBySeries.get(entry.name) ?? colorAt(0)};`}
						></span>
						{entry.name}
					</span>
				{/each}
			</div>
		</div>
	{/if}
</div>

{#if expandable && hasData}
	<Dialog.Root bind:open={expandedOpen}>
		<Dialog.Content class="h-[90vh] max-h-[90vh] w-[95vw] max-w-[95vw] overflow-hidden p-4 sm:max-w-[95vw]">
			<Dialog.Header>
				<Dialog.Title>{resolvedExpandedTitle}</Dialog.Title>
			</Dialog.Header>
			<div class="h-[calc(90vh-5rem)] overflow-auto bg-background p-3">
				<div class="mx-auto flex h-full w-full max-w-[1400px] flex-col gap-3">
					{#if activeFilters.length > 0}
						<div class="flex flex-wrap gap-2">
							{#each activeFilters as filterLabel}
								<span class="inline-flex items-center rounded-md border px-2 py-0.5 text-xs">{filterLabel}</span>
							{/each}
						</div>
					{/if}
					<div class="rounded-md border bg-muted/20 p-3">
						<div class="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
							<span>Showing {visibleExpandedSeries.length} of {rankedSeries.length} categories.</span>
							{#if hasHiddenSeries}
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
						{#if hasHiddenSeries}
							<div class="mt-3 grid max-h-40 gap-2 overflow-auto sm:grid-cols-2 lg:grid-cols-3">
								{#each rankedSeries as entry}
									<label class="flex items-center gap-2 rounded-md border bg-background px-2 py-1 text-xs">
										<input
											type="checkbox"
											checked={selectedSeriesNames.includes(entry.name)}
											onchange={(event) =>
												setSeriesSelected(
													entry.name,
													(event.currentTarget as HTMLInputElement).checked
												)}
										/>
										<span
											class="inline-block size-2 rounded-full"
											style={`background-color: ${colorBySeries.get(entry.name) ?? colorAt(0)};`}
										></span>
										<span class="truncate">{entry.name}</span>
									</label>
								{/each}
							</div>
						{/if}
					</div>
					{#if visibleExpandedSeries.length === 0}
						<div class="flex h-[220px] items-center justify-center rounded-md bg-muted/30 text-sm text-muted-foreground">
							Select at least one category to display the chart.
						</div>
					{:else}
						<div class="flex flex-1 items-center justify-center">
							<svg
								viewBox={`0 0 ${EXPANDED_DIMS.svgWidth} ${EXPANDED_DIMS.svgHeight}`}
								class="h-[74vh] w-full max-w-[1400px]"
							>
								<title>{title || 'Line chart'}</title>
								<desc>{`${yAxisLabel} by ${xAxisLabel}`}</desc>
								<line
									x1={EXPANDED_DIMS.paddingLeft}
									y1={EXPANDED_DIMS.paddingTop + plotHeight(EXPANDED_DIMS)}
									x2={EXPANDED_DIMS.paddingLeft + plotWidth(EXPANDED_DIMS)}
									y2={EXPANDED_DIMS.paddingTop + plotHeight(EXPANDED_DIMS)}
									stroke="hsl(var(--border))"
									stroke-width="1"
								/>
								<line
									x1={EXPANDED_DIMS.paddingLeft}
									y1={EXPANDED_DIMS.paddingTop}
									x2={EXPANDED_DIMS.paddingLeft}
									y2={EXPANDED_DIMS.paddingTop + plotHeight(EXPANDED_DIMS)}
									stroke="hsl(var(--border))"
									stroke-width="1"
								/>

								{#each expandedYTicks as tick}
									<line
										x1={EXPANDED_DIMS.paddingLeft}
										y1={yAt(tick, expandedMaxValue, EXPANDED_DIMS)}
										x2={EXPANDED_DIMS.paddingLeft + plotWidth(EXPANDED_DIMS)}
										y2={yAt(tick, expandedMaxValue, EXPANDED_DIMS)}
										stroke="hsl(var(--border))"
										stroke-width="0.7"
										stroke-dasharray="4 3"
									/>
									<text
										x={EXPANDED_DIMS.paddingLeft - 8}
										y={yAt(tick, expandedMaxValue, EXPANDED_DIMS) + 5}
										text-anchor="end"
										font-size="12"
										fill="hsl(var(--muted-foreground))"
									>
										{tick}
									</text>
								{/each}

								{#each visibleExpandedSeries as entry}
									{#each polylineSegments(entry.values, expandedMaxValue, EXPANDED_DIMS) as points}
										<polyline
											fill="none"
											stroke={colorBySeries.get(entry.name) ?? colorAt(0)}
											stroke-width="2.5"
											points={points}
										/>
									{/each}
									{#each entry.values as value, valueIndex}
										{#if value != null}
											<circle
												cx={xAt(valueIndex, pointCount, EXPANDED_DIMS)}
												cy={yAt(value, expandedMaxValue, EXPANDED_DIMS)}
												r="3.6"
												fill={colorBySeries.get(entry.name) ?? colorAt(0)}
											/>
											<text
												x={xAt(valueIndex, pointCount, EXPANDED_DIMS)}
												y={yAt(value, expandedMaxValue, EXPANDED_DIMS) - 9}
												font-size="10.5"
												text-anchor="middle"
												fill={colorBySeries.get(entry.name) ?? colorAt(0)}
											>
												{value}
											</text>
										{/if}
									{/each}
								{/each}

								{#each expandedXTicks as idx}
									<text
										x={xAt(idx, pointCount, EXPANDED_DIMS)}
										y={EXPANDED_DIMS.paddingTop + plotHeight(EXPANDED_DIMS) + 36}
										text-anchor="end"
										font-size="11.5"
										fill="hsl(var(--muted-foreground))"
										transform={`rotate(-40 ${xAt(idx, pointCount, EXPANDED_DIMS)} ${EXPANDED_DIMS.paddingTop + plotHeight(EXPANDED_DIMS) + 36})`}
									>
										{formatDateLabel(dates[idx])}
									</text>
								{/each}
								<text
									x={EXPANDED_DIMS.paddingLeft + plotWidth(EXPANDED_DIMS) / 2}
									y={EXPANDED_DIMS.svgHeight - 10}
									text-anchor="middle"
									font-size="13"
									fill="hsl(var(--muted-foreground))"
								>
									{xAxisLabel}
								</text>
								<text
									x={18}
									y={EXPANDED_DIMS.paddingTop + plotHeight(EXPANDED_DIMS) / 2}
									font-size="13"
									fill="hsl(var(--muted-foreground))"
									transform={`rotate(-90 18 ${EXPANDED_DIMS.paddingTop + plotHeight(EXPANDED_DIMS) / 2})`}
									text-anchor="middle"
								>
									{yAxisLabel}
								</text>
							</svg>
						</div>
					{/if}
					<div class="flex flex-wrap gap-2 text-xs">
						{#each visibleExpandedSeries as entry}
							<span class="inline-flex items-center gap-1 rounded-md border px-2 py-0.5">
								<span
									class="inline-block size-2 rounded-full"
									style={`background-color: ${colorBySeries.get(entry.name) ?? colorAt(0)};`}
								></span>
								{entry.name}
							</span>
						{/each}
					</div>
				</div>
			</div>
		</Dialog.Content>
	</Dialog.Root>
{/if}
