<script lang="ts">
	export let sessions: Array<{ channel: string; time: number | string }> = [];
	export let channelOrder: string[] = [];
	export let unitLabelSingular = 'session';
	export let unitLabelPlural = 'sessions';
	export let showChannelFilters = true;
	export let noDataLabel = 'No sessions found for the selected filters.';

	const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
	const SECONDS_PER_DAY = 24 * 60 * 60;
	const MAX_WEEKS_RENDER = 156;

	type CellMix = { channel: string; count: number };
	type WeekCell = {
		key: string;
		count: number;
		mix: CellMix[];
	};
	type WeekRow = {
		startLabel: string;
		endLabel: string;
		total: number;
		cells: WeekCell[];
	};
	type HoveredCell = {
		dateKey: string;
		count: number;
		weekLabel: string;
		weekTotal: number;
		mix: CellMix[];
	};

	let selectedChannels: string[] = [];
	let selectedChannelsInitialized = false;
	let hoveredCell: HoveredCell | null = null;

	function coerceUnixSeconds(raw: unknown): number | null {
		if (raw == null) return null;

		const numeric = Number(raw);
		if (Number.isFinite(numeric)) {
			let unix = numeric;
			if (unix > 1_000_000_000_000) unix = unix / 1000;
			if (unix > 0) return Math.floor(unix);
		}

		if (typeof raw === 'string') {
			const parsedMs = Date.parse(raw);
			if (Number.isFinite(parsedMs) && parsedMs > 0) return Math.floor(parsedMs / 1000);
		}

		return null;
	}

	function pad2(value: number): string {
		return String(value).padStart(2, '0');
	}

	function toDayKey(unixSeconds: number): string {
		const d = new Date(unixSeconds * 1000);
		return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
	}

	function fromDayKey(dayKey: string): Date {
		const [y, m, d] = dayKey.split('-').map(Number);
		return new Date(y, (m ?? 1) - 1, d ?? 1);
	}

	function toLabel(date: Date): string {
		return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(date);
	}

	function toMonthLabel(dayKey: string): string {
		const date = fromDayKey(dayKey);
		return new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric' }).format(date);
	}

	function toVerboseDate(dayKey: string): string {
		const date = fromDayKey(dayKey);
		return new Intl.DateTimeFormat('en-US', {
			weekday: 'short',
			month: 'short',
			day: 'numeric',
			year: 'numeric'
		}).format(date);
	}

	function startOfWeek(date: Date): Date {
		const d = new Date(date);
		d.setHours(0, 0, 0, 0);
		d.setDate(d.getDate() - d.getDay());
		return d;
	}

	function addDays(date: Date, days: number): Date {
		const d = new Date(date);
		d.setDate(d.getDate() + days);
		return d;
	}

	function deriveAvailableChannels(
		items: Array<{ channel: string; time: number | string }>,
		preferredOrder: string[]
	): string[] {
		const seen = new Set<string>();
		for (const item of items) {
			const channel = String(item.channel ?? '').trim();
			if (!channel) continue;
			seen.add(channel);
		}

		const preferred = preferredOrder.filter((channel) => seen.has(channel));
		const extras = [...seen].filter((channel) => !preferred.includes(channel)).sort((a, b) => a.localeCompare(b));
		return [...preferred, ...extras];
	}

	function sortByAvailableOrder(values: string[], available: string[]): string[] {
		return [...values].sort((a, b) => available.indexOf(a) - available.indexOf(b));
	}

	function buildRows(
		items: Array<{ channel: string; time: number | string }>,
		enabledChannels: string[]
	): {
		rows: WeekRow[];
		truncated: boolean;
		validTimestamps: number;
		totalIncluded: number;
	} {
		if (items.length === 0 || enabledChannels.length === 0) {
			return { rows: [], truncated: false, validTimestamps: 0, totalIncluded: 0 };
		}

		const enabled = new Set(enabledChannels);
		const countsByDay = new Map<string, number>();
		const mixByDay = new Map<string, Map<string, number>>();
		let minUnix = Number.POSITIVE_INFINITY;
		let maxUnix = Number.NEGATIVE_INFINITY;
		let validTimestamps = 0;
		let totalIncluded = 0;

		for (const item of items) {
			const channel = String(item.channel ?? '').trim();
			if (!enabled.has(channel)) continue;

			const unix = coerceUnixSeconds(item.time);
			if (unix == null) continue;

			validTimestamps += 1;
			totalIncluded += 1;
			minUnix = Math.min(minUnix, unix);
			maxUnix = Math.max(maxUnix, unix);

			const key = toDayKey(unix);
			countsByDay.set(key, (countsByDay.get(key) ?? 0) + 1);
			if (!mixByDay.has(key)) mixByDay.set(key, new Map<string, number>());
			const dayMix = mixByDay.get(key)!;
			dayMix.set(channel, (dayMix.get(channel) ?? 0) + 1);
		}

		if (!Number.isFinite(minUnix) || !Number.isFinite(maxUnix)) {
			return { rows: [], truncated: false, validTimestamps, totalIncluded };
		}

		let firstWeekStart = startOfWeek(fromDayKey(toDayKey(minUnix)));
		const lastWeekStart = startOfWeek(fromDayKey(toDayKey(maxUnix)));
		const rows: WeekRow[] = [];
		let truncated = false;

		const totalWeeks =
			Math.floor((lastWeekStart.getTime() - firstWeekStart.getTime()) / (7 * SECONDS_PER_DAY * 1000)) + 1;
		if (totalWeeks > MAX_WEEKS_RENDER) {
			firstWeekStart = addDays(lastWeekStart, -(MAX_WEEKS_RENDER - 1) * 7);
			truncated = true;
		}

		for (
			let weekStart = new Date(lastWeekStart);
			weekStart >= firstWeekStart;
			weekStart = addDays(weekStart, -7)
		) {
			const cells: WeekCell[] = [];
			let total = 0;

			for (let dayOffset = 0; dayOffset < 7; dayOffset += 1) {
				const day = addDays(weekStart, dayOffset);
				const key = `${day.getFullYear()}-${pad2(day.getMonth() + 1)}-${pad2(day.getDate())}`;
				const count = countsByDay.get(key) ?? 0;
				total += count;
				const mix = [...(mixByDay.get(key)?.entries() ?? [])]
					.map(([channel, channelCount]) => ({ channel, count: channelCount }))
					.sort((a, b) => b.count - a.count);

				cells.push({ key, count, mix });
			}

			rows.push({
				startLabel: toLabel(weekStart),
				endLabel: toLabel(addDays(weekStart, 6)),
				total,
				cells
			});
		}

		return { rows, truncated, validTimestamps, totalIncluded };
	}

	function buildMonthLabels(rowsInput: WeekRow[]): string[] {
		const seen = new Set<string>();
		const labels: string[] = [];
		for (const row of rowsInput) {
			const monthKeys = [row.cells[0]?.key?.slice(0, 7), row.cells[6]?.key?.slice(0, 7)].filter(Boolean);
			for (const monthKey of monthKeys) {
				if (seen.has(monthKey)) continue;
				seen.add(monthKey);
				labels.push(toMonthLabel(`${monthKey}-01`));
			}
		}
		return labels;
	}

	function selectAllChannels(): void {
		selectedChannels = [...availableChannels];
	}

	function toggleChannel(channel: string): void {
		if (selectedChannels.includes(channel)) {
			if (selectedChannels.length === 1) return;
			selectedChannels = selectedChannels.filter((value) => value !== channel);
			return;
		}
		selectedChannels = sortByAvailableOrder([...selectedChannels, channel], availableChannels);
	}

	function updateHovered(row: WeekRow, cell: WeekCell): void {
		hoveredCell = {
			dateKey: cell.key,
			count: cell.count,
			weekLabel: `${row.startLabel} - ${row.endLabel}`,
			weekTotal: row.total,
			mix: cell.mix
		};
	}

	function intensity(value: number): number {
		if (value <= 0 || maxCount <= 0) return 0.08;
		return 0.18 + (value / maxCount) * 0.82;
	}

	function cellBackground(value: number): string {
		if (value <= 0) return 'rgba(148, 163, 184, 0.14)';
		return `rgba(34, 197, 94, ${intensity(value)})`;
	}

	function formatUnitCount(value: number): string {
		return `${value} ${value === 1 ? unitLabelSingular : unitLabelPlural}`;
	}

	$: availableChannels = deriveAvailableChannels(sessions, channelOrder);
	$: if (availableChannels.length === 0) {
		selectedChannels = [];
		selectedChannelsInitialized = false;
	}
	$: if (!selectedChannelsInitialized && availableChannels.length > 0) {
		selectedChannels = [...availableChannels];
		selectedChannelsInitialized = true;
	}
	$: if (selectedChannelsInitialized && availableChannels.length > 0) {
		const filtered = selectedChannels.filter((channel) => availableChannels.includes(channel));
		if (filtered.length === 0) selectedChannels = [...availableChannels];
		else if (filtered.length !== selectedChannels.length) selectedChannels = filtered;
	}

	$: built = buildRows(sessions, selectedChannels);
	$: rows = built.rows;
	$: truncated = built.truncated;
	$: validTimestamps = built.validTimestamps;
	$: totalIncluded = built.totalIncluded;
	$: invalidTimestamps = Math.max(0, sessions.length - validTimestamps);
	$: maxCount = Math.max(0, ...rows.flatMap((row) => row.cells.map((cell) => cell.count)));
	$: monthLabels = buildMonthLabels(rows);
	$: oldestUnix =
		rows.length > 0 ? Math.floor(fromDayKey(rows[rows.length - 1].cells[0].key).getTime() / 1000) : null;
	$: newestUnix = rows.length > 0 ? Math.floor(fromDayKey(rows[0].cells[6].key).getTime() / 1000) : null;
	$: rangeLabel =
		oldestUnix != null && newestUnix != null
			? `${toLabel(new Date(oldestUnix * 1000))} - ${toLabel(new Date(newestUnix * 1000))}`
			: null;

	$: {
		if (rows.length === 0) hoveredCell = null;
		else if (!hoveredCell) {
			const firstRow = rows[0];
			const firstCell = firstRow.cells.find((cell) => cell.count > 0) ?? firstRow.cells[0];
			updateHovered(firstRow, firstCell);
		} else {
			const found = rows.some((row) => row.cells.some((cell) => cell.key === hoveredCell?.dateKey));
			if (!found) {
				const firstRow = rows[0];
				updateHovered(firstRow, firstRow.cells[0]);
			}
		}
	}
</script>

{#if rows.length === 0}
	<div class="flex h-[220px] items-center justify-center rounded-md bg-muted/30 text-sm text-muted-foreground">
		<div class="space-y-1 text-center">
			<p>{noDataLabel}</p>
			<p class="text-xs">Rows loaded: {sessions.length} | Invalid timestamps: {invalidTimestamps}</p>
		</div>
	</div>
{:else}
	<div class="space-y-3">
		<div class="flex flex-wrap items-center justify-between gap-2">
			<p class="text-xs text-muted-foreground">
				Rows = weeks, columns = day of week, color intensity = {unitLabelSingular} count per day.
			</p>
			<p class="text-xs text-muted-foreground">
				{rows.length} weeks | {formatUnitCount(totalIncluded)}{#if rangeLabel} | {rangeLabel}{/if}
			</p>
		</div>

		<div class="flex flex-wrap gap-1.5">
			{#each monthLabels as month}
				<span class="rounded-md border bg-muted/20 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
					{month}
				</span>
			{/each}
		</div>

		{#if showChannelFilters && availableChannels.length > 1}
			<div class="flex flex-wrap items-center gap-2 rounded-md border bg-muted/10 px-3 py-2">
				<p class="text-xs font-medium text-muted-foreground">Channels</p>
				<button
					type="button"
					class="rounded-md border px-2 py-0.5 text-xs"
					class:bg-primary={selectedChannels.length === availableChannels.length}
					class:text-primary-foreground={selectedChannels.length === availableChannels.length}
					onclick={selectAllChannels}
				>
					All
				</button>
				{#each availableChannels as channel}
					<button
						type="button"
						class="rounded-md border px-2 py-0.5 text-xs"
						class:bg-primary={selectedChannels.includes(channel)}
						class:text-primary-foreground={selectedChannels.includes(channel)}
						onclick={() => toggleChannel(channel)}
					>
						{channel}
					</button>
				{/each}
			</div>
		{/if}

		{#if hoveredCell}
			<div class="rounded-md border bg-background px-3 py-2 text-xs">
				<p class="font-medium">{toVerboseDate(hoveredCell.dateKey)}</p>
				<p class="text-muted-foreground">
					Day total: {formatUnitCount(hoveredCell.count)} | Week ({hoveredCell.weekLabel}): {formatUnitCount(hoveredCell.weekTotal)}
				</p>
				{#if hoveredCell.mix.length > 0}
					<p class="text-muted-foreground">
						Channel mix:
						{hoveredCell.mix.map((entry) => `${entry.channel} ${entry.count}`).join(', ')}
					</p>
				{:else}
					<p class="text-muted-foreground">Channel mix: none</p>
				{/if}
			</div>
		{/if}

		{#if truncated}
			<p class="text-xs text-muted-foreground">
				Display capped to the most recent {MAX_WEEKS_RENDER} weeks.
			</p>
		{/if}

		<div class="rounded-md border bg-muted/10">
			<div class="grid grid-cols-[130px_1fr] items-center gap-2 border-b px-3 py-2">
				<p class="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">Week</p>
				<div class="grid grid-cols-7 gap-1">
					{#each DAY_NAMES as dayName}
						<p class="text-center text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
							{dayName}
						</p>
					{/each}
				</div>
			</div>

			<div class="max-h-[420px] overflow-y-auto px-3 py-2">
				<div class="space-y-1.5">
					{#each rows as row}
						<div class="grid grid-cols-[130px_1fr] items-center gap-2">
							<div class="space-y-0.5">
								<p class="text-xs font-medium">{row.startLabel} - {row.endLabel}</p>
								<p class="text-[11px] text-muted-foreground">{formatUnitCount(row.total)}</p>
							</div>
							<div class="grid grid-cols-7 gap-1">
								{#each row.cells as cell}
									<button
										type="button"
										class="h-6 rounded border border-border/50"
										style={`background-color: ${cellBackground(cell.count)};`}
										title={`${cell.key}: ${formatUnitCount(cell.count)}`}
										onmouseenter={() => updateHovered(row, cell)}
										onfocus={() => updateHovered(row, cell)}
										onclick={() => updateHovered(row, cell)}
									></button>
								{/each}
							</div>
						</div>
					{/each}
				</div>
			</div>
		</div>

		<div class="flex items-center gap-2 text-xs text-muted-foreground">
			<span>Low</span>
			<div class="h-2 w-10 rounded border border-border/40" style="background-color: rgba(148, 163, 184, 0.14);"></div>
			<div class="h-2 w-10 rounded border border-border/40" style="background-color: rgba(34, 197, 94, 0.45);"></div>
			<div class="h-2 w-10 rounded border border-border/40" style="background-color: rgba(34, 197, 94, 0.9);"></div>
			<span>High</span>
		</div>
	</div>
{/if}
