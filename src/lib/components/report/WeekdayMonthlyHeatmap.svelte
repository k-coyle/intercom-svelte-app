<script lang="ts">
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import Maximize2Icon from '@lucide/svelte/icons/maximize-2';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';

	type SessionRow = {
		startingUnix: number;
		status: string;
	};

	type Cell = {
		day: number | null;
		count: number;
		dateKey: string | null;
	};

	const WEEKDAY_ORDER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
	const WEEKDAY_INDEX: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4 };
	const WEEKDAY_BY_UTC_DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
	const REPORT_TIMEZONE = 'America/New_York';

	export let sessions: SessionRow[] = [];
	export let statusOptions: string[] = [];
	export let activeFilters: string[] = [];
	export let rangeStartDate = '';
	export let rangeEndDate = '';
	export let expandedTitle = 'Monthly Calendar Heatmap (Mon-Fri)';
	export let expandable = true;

	let selectedStatuses: string[] = [];
	let monthIndex = 0;
	let expandedOpen = false;

	function monthKeyFromUnix(unix: number): string {
		return new Intl.DateTimeFormat('en-CA', {
			timeZone: REPORT_TIMEZONE,
			year: 'numeric',
			month: '2-digit'
		}).format(new Date(unix * 1000));
	}

	function dayParts(unix: number): { year: number; month: number; day: number; weekday: string } {
		const parts = new Intl.DateTimeFormat('en-US', {
			timeZone: REPORT_TIMEZONE,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			weekday: 'short'
		}).formatToParts(new Date(unix * 1000));
		const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
		return {
			year: Number(get('year') || 0),
			month: Number(get('month') || 0),
			day: Number(get('day') || 0),
			weekday: String(get('weekday'))
		};
	}

	function monthLabel(monthKey: string): string {
		const [yearText, monthText] = monthKey.split('-');
		const year = Number(yearText);
		const month = Number(monthText);
		if (!Number.isFinite(year) || !Number.isFinite(month)) return monthKey;
		const date = new Date(Date.UTC(year, month - 1, 1));
		return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(date);
	}

	function weekdayForCivilDate(year: number, month: number, day: number): string {
		const utcDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
		return WEEKDAY_BY_UTC_DAY[utcDay] ?? 'Sun';
	}

	function firstWeekdayOffsetMon(monthKey: string): number {
		const [yearText, monthText] = monthKey.split('-');
		const year = Number(yearText);
		const month = Number(monthText);
		const weekday = weekdayForCivilDate(year, month, 1);
		const map: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
		return map[weekday] ?? 0;
	}

	function monthKeyFromDateInput(raw: string): string | null {
		const text = String(raw ?? '').trim();
		if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
		return text.slice(0, 7);
	}

	function monthRange(startMonthKey: string, endMonthKey: string): string[] {
		if (startMonthKey > endMonthKey) return [];
		const output: string[] = [];
		const [startYearText, startMonthText] = startMonthKey.split('-');
		const [endYearText, endMonthText] = endMonthKey.split('-');
		let year = Number(startYearText);
		let month = Number(startMonthText);
		const endYear = Number(endYearText);
		const endMonth = Number(endMonthText);
		if (
			!Number.isFinite(year) ||
			!Number.isFinite(month) ||
			!Number.isFinite(endYear) ||
			!Number.isFinite(endMonth)
		) {
			return [];
		}
		while (year < endYear || (year === endYear && month <= endMonth)) {
			output.push(`${year}-${String(month).padStart(2, '0')}`);
			month += 1;
			if (month > 12) {
				month = 1;
				year += 1;
			}
		}
		return output;
	}

	function buildMonthGrid(monthKey: string, data: SessionRow[]): { rows: Cell[][]; rowTotals: number[]; maxCount: number } {
		const rows: Cell[][] = Array.from({ length: 6 }, () =>
			Array.from({ length: 5 }, () => ({ day: null, count: 0, dateKey: null }))
		);
		const rowTotals = Array.from({ length: 6 }, () => 0);
		const offset = firstWeekdayOffsetMon(monthKey);
		const countsByDate = new Map<string, number>();

		for (const row of data) {
			const parts = dayParts(row.startingUnix);
			const key = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
			countsByDate.set(key, (countsByDate.get(key) ?? 0) + 1);
		}

		let maxCount = 0;
		for (const [dateKey, count] of countsByDate.entries()) {
			const [yearText, monthText, dayText] = dateKey.split('-');
			const day = Number(dayText);
			const month = Number(monthText);
			const year = Number(yearText);
			if (`${year}-${String(month).padStart(2, '0')}` !== monthKey) continue;

			const weekday = weekdayForCivilDate(year, month, day);
			if (!(weekday in WEEKDAY_INDEX)) continue;
			const week = Math.floor((day - 1 + offset) / 7);
			const col = WEEKDAY_INDEX[weekday];
			if (week < 0 || week >= rows.length || col < 0 || col >= 5) continue;

			rows[week][col] = { day, count, dateKey };
			rowTotals[week] += count;
			if (count > maxCount) maxCount = count;
		}

		return { rows, rowTotals, maxCount };
	}

	function toggleStatus(status: string) {
		if (selectedStatuses.includes(status)) {
			if (selectedStatuses.length === 1) return;
			selectedStatuses = selectedStatuses.filter((value) => value !== status);
			return;
		}
		selectedStatuses = [...selectedStatuses, status];
	}

	function allStatuses() {
		selectedStatuses = [...statusOptions];
	}

	function intensity(value: number, maxCount: number): number {
		if (value <= 0 || maxCount <= 0) return 0.1;
		return 0.2 + (value / maxCount) * 0.8;
	}

	function cellColor(value: number, maxCount: number): string {
		if (value <= 0) return 'rgba(148, 163, 184, 0.15)';
		return `rgba(34, 197, 94, ${intensity(value, maxCount)})`;
	}

	function openExpanded() {
		if (!expandable || months.length === 0) return;
		expandedOpen = true;
	}

	$: uniqueStatuses = statusOptions.length > 0 ? statusOptions : [...new Set(sessions.map((row) => row.status))];
	$: if (uniqueStatuses.length === 0) {
		selectedStatuses = [];
	} else if (selectedStatuses.length === 0) {
		selectedStatuses = [...uniqueStatuses];
	} else {
		const next = selectedStatuses.filter((status) => uniqueStatuses.includes(status));
		selectedStatuses = next.length > 0 ? next : [...uniqueStatuses];
	}

	$: filteredSessions = sessions.filter((row) => selectedStatuses.includes(row.status));
	$: sessionMonths = [...new Set(filteredSessions.map((row) => monthKeyFromUnix(row.startingUnix)))].sort((a, b) =>
		a.localeCompare(b)
	);
	$: startMonthKey = monthKeyFromDateInput(rangeStartDate);
	$: endMonthKey = monthKeyFromDateInput(rangeEndDate);
	$: months =
		startMonthKey && endMonthKey && startMonthKey <= endMonthKey
			? monthRange(startMonthKey, endMonthKey)
			: sessionMonths;
	$: if (months.length === 0) monthIndex = 0;
	$: if (monthIndex >= months.length) monthIndex = Math.max(0, months.length - 1);
	$: currentMonthKey = months[monthIndex] ?? null;
	$: grid = currentMonthKey ? buildMonthGrid(currentMonthKey, filteredSessions) : { rows: [], rowTotals: [], maxCount: 0 };
	$: monthTotal = grid.rowTotals.reduce((sum, value) => sum + value, 0);
</script>

{#if months.length === 0}
	<div class="flex h-[240px] items-center justify-center rounded-md bg-muted/30 text-sm text-muted-foreground">
		No sessions found for the selected filters.
	</div>
{:else}
	<div class="space-y-3">
		{#if expandable}
			<div class="flex items-center justify-end">
				<Button
					size="sm"
					variant="outline"
					class="inline-flex items-center gap-1"
					onclick={openExpanded}
				>
					<Maximize2Icon class="size-3.5" />
					Expand
				</Button>
			</div>
		{/if}
		<div class="flex flex-wrap items-center justify-between gap-2">
			<div class="flex items-center gap-2">
				<Button size="icon" variant="ghost" disabled={monthIndex === 0} onclick={() => (monthIndex = Math.max(0, monthIndex - 1))}>
					<ChevronLeftIcon class="size-4" />
				</Button>
				<p class="text-sm font-medium">{monthLabel(currentMonthKey as string)}</p>
				<Button
					size="icon"
					variant="ghost"
					disabled={monthIndex >= months.length - 1}
					onclick={() => (monthIndex = Math.min(months.length - 1, monthIndex + 1))}
				>
					<ChevronRightIcon class="size-4" />
				</Button>
			</div>
			<p class="text-xs text-muted-foreground">{monthTotal} sessions in month</p>
		</div>

		<div class="flex flex-wrap items-center gap-2 rounded-md border bg-muted/10 px-3 py-2">
			<p class="text-xs font-medium text-muted-foreground">Status</p>
			<button
				type="button"
				class="rounded-md border px-2 py-0.5 text-xs"
				class:bg-primary={selectedStatuses.length === uniqueStatuses.length}
				class:text-primary-foreground={selectedStatuses.length === uniqueStatuses.length}
				onclick={allStatuses}
			>
				All
			</button>
			{#each uniqueStatuses as status}
				<button
					type="button"
					class="rounded-md border px-2 py-0.5 text-xs"
					class:bg-primary={selectedStatuses.includes(status)}
					class:text-primary-foreground={selectedStatuses.includes(status)}
					onclick={() => toggleStatus(status)}
				>
					{status}
				</button>
			{/each}
		</div>

		<div class="bg-muted/10">
			<div class="grid grid-cols-[80px_repeat(5,minmax(0,1fr))_80px] items-center gap-1 px-2 py-2">
				<p class="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Week</p>
				{#each WEEKDAY_ORDER as day}
					<p class="text-center text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{day}</p>
				{/each}
				<p class="text-right text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Total</p>
			</div>
			<div class="space-y-1 px-2 py-2">
				{#each grid.rows as row, rowIndex}
					<div class="grid grid-cols-[80px_repeat(5,minmax(0,1fr))_80px] items-center gap-1">
						<p class="text-xs text-muted-foreground">Week {rowIndex + 1}</p>
						{#each row as cell}
							<div
								class="h-8 rounded border border-border/60 text-center text-[10px] leading-8"
								style={`background-color: ${cellColor(cell.count, grid.maxCount)};`}
								title={cell.dateKey ? `${cell.dateKey}: ${cell.count}` : 'No weekday date'}
							>
								{#if cell.day != null}
									{cell.day} ({cell.count})
								{/if}
							</div>
						{/each}
						<p class="text-right text-xs font-medium">{grid.rowTotals[rowIndex]}</p>
					</div>
				{/each}
			</div>
		</div>
	</div>
{/if}

{#if expandable && months.length > 0}
	<Dialog.Root bind:open={expandedOpen}>
		<Dialog.Content class="h-[90vh] max-h-[90vh] w-[95vw] max-w-[95vw] overflow-hidden p-4 sm:max-w-[95vw]">
			<Dialog.Header>
				<Dialog.Title>{expandedTitle}</Dialog.Title>
			</Dialog.Header>
			<div class="h-[calc(90vh-5rem)] overflow-auto bg-background p-3">
				<div class="mx-auto w-full max-w-6xl space-y-3">
					<div class="flex flex-wrap items-center justify-between gap-2">
						<div class="flex items-center gap-2">
							<Button size="icon" variant="ghost" disabled={monthIndex === 0} onclick={() => (monthIndex = Math.max(0, monthIndex - 1))}>
								<ChevronLeftIcon class="size-4" />
							</Button>
							<p class="text-sm font-medium">{monthLabel(currentMonthKey as string)}</p>
							<Button
								size="icon"
								variant="ghost"
								disabled={monthIndex >= months.length - 1}
								onclick={() => (monthIndex = Math.min(months.length - 1, monthIndex + 1))}
							>
								<ChevronRightIcon class="size-4" />
							</Button>
						</div>
						<p class="text-xs text-muted-foreground">{monthTotal} sessions in month</p>
					</div>
					{#if activeFilters.length > 0}
						<div class="flex flex-wrap gap-2">
							{#each activeFilters as filterLabel}
								<span class="inline-flex items-center rounded-md border px-2 py-0.5 text-xs">{filterLabel}</span>
							{/each}
						</div>
					{/if}

					<div class="flex flex-wrap items-center gap-2 rounded-md border bg-muted/10 px-3 py-2">
						<p class="text-xs font-medium text-muted-foreground">Status</p>
						<button
							type="button"
							class="rounded-md border px-2 py-0.5 text-xs"
							class:bg-primary={selectedStatuses.length === uniqueStatuses.length}
							class:text-primary-foreground={selectedStatuses.length === uniqueStatuses.length}
							onclick={allStatuses}
						>
							All
						</button>
						{#each uniqueStatuses as status}
							<button
								type="button"
								class="rounded-md border px-2 py-0.5 text-xs"
								class:bg-primary={selectedStatuses.includes(status)}
								class:text-primary-foreground={selectedStatuses.includes(status)}
								onclick={() => toggleStatus(status)}
							>
								{status}
							</button>
						{/each}
					</div>
					<div class="flex items-center gap-2 text-xs text-muted-foreground">
						<span>Intensity</span>
						<div class="h-2 w-16 rounded" style="background-color: rgba(148, 163, 184, 0.15);"></div>
						<span>Low</span>
						<div class="h-2 w-16 rounded" style="background-color: rgba(34, 197, 94, 0.95);"></div>
						<span>High</span>
					</div>

					<div class="bg-muted/10">
						<div class="grid grid-cols-[80px_repeat(5,minmax(0,1fr))_80px] items-center gap-1 px-2 py-2">
							<p class="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Week</p>
							{#each WEEKDAY_ORDER as day}
								<p class="text-center text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{day}</p>
							{/each}
							<p class="text-right text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Total</p>
						</div>
						<div class="space-y-1 px-2 py-2">
							{#each grid.rows as row, rowIndex}
								<div class="grid grid-cols-[80px_repeat(5,minmax(0,1fr))_80px] items-center gap-1">
									<p class="text-xs text-muted-foreground">Week {rowIndex + 1}</p>
									{#each row as cell}
										<div
											class="h-8 rounded border border-border/60 text-center text-[10px] leading-8"
											style={`background-color: ${cellColor(cell.count, grid.maxCount)};`}
											title={cell.dateKey ? `${cell.dateKey}: ${cell.count}` : 'No weekday date'}
										>
											{#if cell.day != null}
												{cell.day} ({cell.count})
											{/if}
										</div>
									{/each}
									<p class="text-right text-xs font-medium">{grid.rowTotals[rowIndex]}</p>
								</div>
							{/each}
						</div>
					</div>
				</div>
			</div>
		</Dialog.Content>
	</Dialog.Root>
{/if}
