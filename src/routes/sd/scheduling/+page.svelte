<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import LoadStatus from '$lib/components/report/LoadStatus.svelte';
	import MultiSelectDropdown from '$lib/components/report/MultiSelectDropdown.svelte';
	import ActiveFilterChips from '$lib/components/report/ActiveFilterChips.svelte';
	import KpiCard from '$lib/components/report/KpiCard.svelte';
	import WeekdayMonthlyHeatmap from '$lib/components/report/WeekdayMonthlyHeatmap.svelte';
	import TablePanel from '$lib/components/report/TablePanel.svelte';
	import * as Card from '$lib/components/ui/card';
	import { Input } from '$lib/components/ui/input';
	import { Button } from '$lib/components/ui/button';
	import {
		cleanupSdSchedulingJob,
		fetchAllSdSchedulingRows,
		fetchSdSchedulingView,
		runSdSchedulingJobUntilComplete,
		type SdSchedulingDateBasis
	} from '$lib/client/sd-scheduling-job';
	import {
		type ComparisonRangeMode,
		exportRowsAsCsv,
		isoDateDaysAgo,
		previousPeriodRange,
		todayIsoDate,
		uniqueListValues,
		uniqueSorted
	} from '$lib/client/sd-report-utils';
	import type { TableColumn } from '$lib/components/report/engagementReportConfig';

	type SchedulingRow = {
		sessionId: string;
		createdTime: string | null;
		createdUnix: number | null;
		createdDate: string | null;
		startingTime: string;
		startingUnix: number;
		startingDate: string;
		statusRaw: string;
		status: 'scheduled' | 'completed' | 'no_show' | 'rescheduled' | 'canceled';
		memberEmail: string | null;
		memberId: string | null;
		memberName: string | null;
		employer: string | null;
		programs: string[];
		coachEmail: string | null;
		coachId: string | null;
		coachName: string | null;
		owner: string | null;
	};

	type SchedulingSummary = {
		generatedAt: string;
		dateBasis: SdSchedulingDateBasis;
		startDate: string;
		endDate: string;
		totalRows: number;
		dateBounds: {
			minCreatedDate: string | null;
			maxCreatedDate: string | null;
			minStartingDate: string | null;
			maxStartingDate: string | null;
		};
		availableDateBounds?: {
			minCreatedDate: string | null;
			maxCreatedDate: string | null;
			minStartingDate: string | null;
			maxStartingDate: string | null;
		};
		statusCounts: Record<string, number>;
	};

	type FilterChip = {
		key: string;
		label: string;
		onRemove: () => void;
	};

	export let data: {
		sandboxModeOffline?: boolean;
	};

	const TABLE_COLUMNS: TableColumn[] = [
		{ key: 'createdDate', header: 'Created Date' },
		{ key: 'sessionDate', header: 'Session Date' },
		{ key: 'status', header: 'Status' },
		{ key: 'member', header: 'Member' },
		{ key: 'employer', header: 'Employer' },
		{ key: 'programs', header: 'Programs' },
		{ key: 'coach', header: 'Coach' }
	];
	const DATE_BASIS_OPTIONS: Array<{ value: SdSchedulingDateBasis; label: string }> = [
		{ value: 'session', label: 'Session Date' },
		{ value: 'created', label: 'Created Date' }
	];
	const RUN_BUTTON_CLASS = 'bg-red-700 text-white hover:bg-red-600 border-red-700';
	const EXPORT_BUTTON_CLASS = 'border-green-700 text-green-700 hover:bg-green-50';

	const DEFAULT_STATUS_OPTIONS = ['scheduled', 'completed', 'no_show', 'rescheduled', 'canceled'];

	let rangeStart = '';
	let rangeEnd = '';
	let selectedDateBasis: SdSchedulingDateBasis = 'session';
	let sandboxDateMin = '';
	let comparisonEnabled = false;
	let comparisonMode: ComparisonRangeMode = 'previous';
	let comparisonStart = '';
	let comparisonEnd = '';
	let lastAutoPreviousStart = '';
	let lastAutoPreviousEnd = '';

	let selectedPrograms: string[] = [];
	let selectedEmployers: string[] = [];
	let selectedCoaches: string[] = [];
	let selectedStatuses: string[] = [];

	let summary: SchedulingSummary | null = null;
	let loadedRows: SchedulingRow[] = [];
	let comparisonSummary: SchedulingSummary | null = null;
	let comparisonLoadedRows: SchedulingRow[] = [];
	let loading = false;
	let error: string | null = null;
	let progressText: string | null = null;
	let activeJobId = '';
	let activeComparisonJobId = '';
	let controller: AbortController | null = null;

	let programOptions: string[] = [];
	let employerOptions: string[] = [];
	let coachOptions: string[] = [];
	let statusOptions: string[] = [];

	function includesPrograms(row: SchedulingRow): boolean {
		if (selectedPrograms.length === 0) return true;
		const rowPrograms = new Set((row.programs ?? []).map((value) => value.trim()));
		return selectedPrograms.some((value) => rowPrograms.has(value));
	}

	function includesEmployers(row: SchedulingRow): boolean {
		if (selectedEmployers.length === 0) return true;
		if (!row.employer) return false;
		return selectedEmployers.includes(row.employer);
	}

	function includesCoaches(row: SchedulingRow): boolean {
		if (selectedCoaches.length === 0) return true;
		if (!row.coachName) return false;
		return selectedCoaches.includes(row.coachName);
	}

	function includesStatuses(row: SchedulingRow): boolean {
		if (selectedStatuses.length === 0) return true;
		return selectedStatuses.includes(row.status);
	}

	function filteredRows(): SchedulingRow[] {
		return loadedRows.filter(
			(row) =>
				includesPrograms(row) &&
				includesEmployers(row) &&
				includesCoaches(row) &&
				includesStatuses(row)
		);
	}

	function refreshFilterOptions() {
		programOptions = uniqueListValues(loadedRows);
		employerOptions = uniqueSorted(loadedRows.map((row) => row.employer));
		coachOptions = uniqueSorted(loadedRows.map((row) => row.coachName));
		statusOptions =
			uniqueSorted(loadedRows.map((row) => row.status)).length > 0
				? uniqueSorted(loadedRows.map((row) => row.status))
				: DEFAULT_STATUS_OPTIONS;

		selectedPrograms = selectedPrograms.filter((value) => programOptions.includes(value));
		selectedEmployers = selectedEmployers.filter((value) => employerOptions.includes(value));
		selectedCoaches = selectedCoaches.filter((value) => coachOptions.includes(value));
		selectedStatuses = selectedStatuses.filter((value) => statusOptions.includes(value));
	}

	function resetFilters() {
		comparisonEnabled = false;
		comparisonMode = 'previous';
		comparisonStart = '';
		comparisonEnd = '';
		lastAutoPreviousStart = '';
		lastAutoPreviousEnd = '';
		selectedDateBasis = 'session';
		selectedPrograms = [];
		selectedEmployers = [];
		selectedCoaches = [];
		selectedStatuses = [];
	}

	function clearDateRange() {
		rangeStart = '';
		rangeEnd = '';
	}

	function derivedPreviousRange():
		| {
				startDate: string;
				endDate: string;
		  }
		| null {
		if (!rangeStart || !rangeEnd) return null;
		return previousPeriodRange(rangeStart, rangeEnd);
	}

	function syncComparisonInputsForPreviousMode(forceApply = false): void {
		if (!comparisonEnabled || comparisonMode !== 'previous') return;
		const previous = derivedPreviousRange();
		if (!previous) return;

		if (forceApply) {
			comparisonStart = previous.startDate;
			comparisonEnd = previous.endDate;
			lastAutoPreviousStart = previous.startDate;
			lastAutoPreviousEnd = previous.endDate;
			return;
		}

		const fieldsEmpty = !comparisonStart && !comparisonEnd;
		const currentlyAutoApplied =
			comparisonStart === lastAutoPreviousStart && comparisonEnd === lastAutoPreviousEnd;
		if (fieldsEmpty || currentlyAutoApplied) {
			comparisonStart = previous.startDate;
			comparisonEnd = previous.endDate;
			lastAutoPreviousStart = previous.startDate;
			lastAutoPreviousEnd = previous.endDate;
			return;
		}

		if (comparisonStart !== previous.startDate || comparisonEnd !== previous.endDate) {
			comparisonMode = 'custom';
		}
	}

	function dateBasisLabel(value: SdSchedulingDateBasis): string {
		return value === 'created' ? 'Created Date' : 'Session Date';
	}

	function setSandboxBounds(source: SchedulingSummary | null): void {
		if (!data?.sandboxModeOffline || !source) return;
		const bounds = source.availableDateBounds ?? source.dateBounds;
		if (selectedDateBasis === 'created') {
			sandboxDateMin = bounds?.minCreatedDate ?? '';
			return;
		}
		sandboxDateMin = bounds?.minStartingDate ?? '';
	}

	function buildFilterChips(): FilterChip[] {
		const output: FilterChip[] = [];
		if (comparisonEnabled) {
			if (comparisonMode === 'custom') {
				output.push({
					key: 'comparison-custom',
					label: `Comparison: ${comparisonStart || '...'} to ${comparisonEnd || '...'}`,
					onRemove: () => {
						comparisonEnabled = false;
						comparisonStart = '';
						comparisonEnd = '';
					}
				});
			} else {
				output.push({
					key: 'comparison-previous',
					label: 'Comparison: Previous Period',
					onRemove: () => {
						comparisonEnabled = false;
					}
				});
			}
		}
		if (selectedDateBasis !== 'session') {
			output.push({
				key: 'date-basis',
				label: `Date Basis: ${dateBasisLabel(selectedDateBasis)}`,
				onRemove: () => (selectedDateBasis = 'session')
			});
		}
		if (rangeStart || rangeEnd) {
			output.push({
				key: 'date-range',
				label: `${dateBasisLabel(selectedDateBasis)}: ${rangeStart || '...'} to ${rangeEnd || '...'}`,
				onRemove: clearDateRange
			});
		}
		for (const value of selectedPrograms) {
			output.push({
				key: `program-${value}`,
				label: `Program: ${value}`,
				onRemove: () => (selectedPrograms = selectedPrograms.filter((entry) => entry !== value))
			});
		}
		for (const value of selectedEmployers) {
			output.push({
				key: `employer-${value}`,
				label: `Employer: ${value}`,
				onRemove: () => (selectedEmployers = selectedEmployers.filter((entry) => entry !== value))
			});
		}
		for (const value of selectedCoaches) {
			output.push({
				key: `coach-${value}`,
				label: `Coach: ${value}`,
				onRemove: () => (selectedCoaches = selectedCoaches.filter((entry) => entry !== value))
			});
		}
		for (const value of selectedStatuses) {
			output.push({
				key: `status-${value}`,
				label: `Status: ${value}`,
				onRemove: () => (selectedStatuses = selectedStatuses.filter((entry) => entry !== value))
			});
		}
		return output;
	}

	function tableRows(rows: SchedulingRow[]) {
		return rows.map((row) => ({
			createdDate: row.createdDate ?? '-',
			sessionDate: row.startingDate ?? '-',
			status: row.status,
			member: row.memberName ?? row.memberEmail ?? row.memberId ?? '-',
			employer: row.employer ?? '-',
			programs: row.programs?.join(', ') || '-',
			coach: row.coachName ?? row.coachEmail ?? row.coachId ?? '-'
		}));
	}

	function exportCsv(rows: SchedulingRow[]) {
		const mapped = tableRows(rows);
		exportRowsAsCsv({
			filenamePrefix: 'sd_scheduling',
			headers: ['Created Date', 'Session Date', 'Status', 'Member', 'Employer', 'Programs', 'Coach'],
			rows: mapped.map((row) => [
				row.createdDate,
				row.sessionDate,
				row.status,
				row.member,
				row.employer,
				row.programs,
				row.coach
			])
		});
	}

	function resolvedComparisonRange():
		| {
				startDate: string;
				endDate: string;
		  }
		| null {
		if (!comparisonEnabled) return null;
		if (comparisonMode === 'custom') {
			if (!comparisonStart || !comparisonEnd) return null;
			return { startDate: comparisonStart, endDate: comparisonEnd };
		}
		if (!rangeStart || !rangeEnd) return null;
		return previousPeriodRange(rangeStart, rangeEnd);
	}

	async function fetchDatasetForDates(
		startDate: string,
		endDate: string,
		kind: 'primary' | 'comparison'
	): Promise<{ summary: SchedulingSummary; rows: SchedulingRow[] }> {
		if (!controller) throw new Error('Missing abort controller');
		const tag = kind === 'comparison' ? 'comparison' : 'reporting';
		let jobIdForCleanup = '';
		try {
			const { jobId } = await runSdSchedulingJobUntilComplete({
				startDate,
				endDate,
				dateBasis: selectedDateBasis,
				signal: controller.signal,
				onJobCreated: (createdJobId) => {
					jobIdForCleanup = createdJobId;
					if (kind === 'primary') activeJobId = createdJobId;
					else activeComparisonJobId = createdJobId;
				},
				onProgress: (progress) => {
					const p = progress?.progress ?? {};
					progressText = `${tag} | basis ${dateBasisLabel(progress?.dateBasis ?? selectedDateBasis)} | phase ${progress?.phase ?? 'running'} | pages ${p.oncehubPagesFetched ?? 0} | bookings ${p.rawBookings ?? 0} | contacts ${p.contactsLoaded ?? 0}`;
				}
			});
			jobIdForCleanup = jobId;
			const [loadedSummary, rows] = await Promise.all([
				fetchSdSchedulingView<SchedulingSummary>(jobId, 'summary', undefined, undefined, controller.signal),
				fetchAllSdSchedulingRows<SchedulingRow>({
					jobId,
					limit: 1000,
					signal: controller.signal,
					onPage: ({ loaded, total }) => {
						progressText = `${tag} | loading scheduling rows ${loaded}${total != null ? ` / ${total}` : ''}...`;
					}
				})
			]);
			return { summary: loadedSummary, rows };
		} finally {
			if (jobIdForCleanup) {
				void cleanupSdSchedulingJob(jobIdForCleanup);
				if (kind === 'primary' && activeJobId === jobIdForCleanup) activeJobId = '';
				if (kind === 'comparison' && activeComparisonJobId === jobIdForCleanup) {
					activeComparisonJobId = '';
				}
			}
		}
	}

	async function runReport(): Promise<void> {
		if (!controller) return;
		if (!rangeStart || !rangeEnd) {
			error = 'Please select a reporting date range.';
			return;
		}
		if (rangeStart > rangeEnd) {
			error = 'Start date must be before end date.';
			return;
		}
		const comparisonRange = resolvedComparisonRange();
		if (comparisonEnabled && !comparisonRange) {
			error =
				comparisonMode === 'custom'
					? 'Select custom comparison start and end dates.'
					: 'Unable to derive previous comparison range.';
			return;
		}
		if (comparisonRange && comparisonRange.startDate > comparisonRange.endDate) {
			error = 'Comparison start date must be before comparison end date.';
			return;
		}

		loading = true;
		error = null;
		progressText = 'Starting scheduling job...';

		try {
			const primaryPromise = fetchDatasetForDates(rangeStart, rangeEnd, 'primary');
			const comparisonPromise = comparisonRange
				? fetchDatasetForDates(comparisonRange.startDate, comparisonRange.endDate, 'comparison')
				: Promise.resolve(null);
			const [primary, comparison] = await Promise.all([primaryPromise, comparisonPromise]);

			summary = primary.summary;
			loadedRows = primary.rows;
			comparisonSummary = comparison?.summary ?? null;
			comparisonLoadedRows = comparison?.rows ?? [];
			refreshFilterOptions();
			setSandboxBounds(primary.summary);
		} catch (err: any) {
			error = err?.message ?? 'Unable to load scheduling report.';
			summary = null;
			loadedRows = [];
			comparisonSummary = null;
			comparisonLoadedRows = [];
		} finally {
			loading = false;
			progressText = null;
		}
	}

	let rows: SchedulingRow[] = [];
	let comparisonRows: SchedulingRow[] = [];
	let scheduledCount = 0;
	let comparisonScheduledCount = 0;
	let completedCount = 0;
	let comparisonCompletedCount = 0;
	let missedCount = 0;
	let comparisonMissedCount = 0;
	let table: Array<Record<string, string>> = [];
	let heatmapSessions: Array<{ startingUnix: number; status: SchedulingRow['status'] }> = [];
	let chipItems: FilterChip[] = [];
	let modalFilterLabels: string[] = [];

	$: {
		loadedRows;
		comparisonLoadedRows;
		rangeStart;
		rangeEnd;
		comparisonEnabled;
		comparisonMode;
		comparisonStart;
		comparisonEnd;
		selectedDateBasis;
		selectedPrograms;
		selectedEmployers;
		selectedCoaches;
		selectedStatuses;

		rows = filteredRows();
		comparisonRows = comparisonLoadedRows.filter(
			(row) =>
				includesPrograms(row) &&
				includesEmployers(row) &&
				includesCoaches(row) &&
				includesStatuses(row)
		);
		scheduledCount = rows.filter((row) => row.status === 'scheduled').length;
		comparisonScheduledCount = comparisonRows.filter((row) => row.status === 'scheduled').length;
		completedCount = rows.filter((row) => row.status === 'completed').length;
		comparisonCompletedCount = comparisonRows.filter((row) => row.status === 'completed').length;
		missedCount = rows.filter((row) => row.status === 'rescheduled' || row.status === 'no_show').length;
		comparisonMissedCount = comparisonRows.filter(
			(row) => row.status === 'rescheduled' || row.status === 'no_show'
		).length;
		table = tableRows(rows);
		heatmapSessions = rows.map((row) => ({ startingUnix: row.startingUnix, status: row.status }));
		chipItems = buildFilterChips();
		modalFilterLabels = chipItems.map((chip) => chip.label);
	}

	$: syncComparisonInputsForPreviousMode();

	$: if (data?.sandboxModeOffline && summary) {
		selectedDateBasis;
		setSandboxBounds(summary);
	}

	onMount(() => {
		controller = new AbortController();
		if (data?.sandboxModeOffline) {
			rangeStart = isoDateDaysAgo(30);
			rangeEnd = todayIsoDate();
			void runReport();
		}
	});

	onDestroy(() => {
		controller?.abort();
		if (activeJobId) void cleanupSdSchedulingJob(activeJobId, true);
		if (activeComparisonJobId) void cleanupSdSchedulingJob(activeComparisonJobId, true);
	});
</script>

<div class="space-y-4">
	<Card.Root>
		<Card.Header class="pb-3">
			<Card.Title class="text-base">Scheduling Filters</Card.Title>
		</Card.Header>
		<Card.Content class="space-y-4">
			<div class="grid gap-3 md:grid-cols-6">
				<div class="space-y-1">
					<label class="text-xs font-medium text-muted-foreground" for="rangeStart">Reporting Start</label>
					<Input
						id="rangeStart"
						type="date"
						bind:value={rangeStart}
						min={data?.sandboxModeOffline ? sandboxDateMin : undefined}
					/>
				</div>
				<div class="space-y-1">
					<label class="text-xs font-medium text-muted-foreground" for="rangeEnd">Reporting End</label>
					<Input
						id="rangeEnd"
						type="date"
						bind:value={rangeEnd}
						min={data?.sandboxModeOffline ? sandboxDateMin : undefined}
					/>
				</div>
				<div class="space-y-1">
					<label class="text-xs font-medium text-muted-foreground" for="dateBasis">Date Basis</label>
					<select
						id="dateBasis"
						class="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
						bind:value={selectedDateBasis}
						disabled={loading}
					>
						{#each DATE_BASIS_OPTIONS as option}
							<option value={option.value}>{option.label}</option>
						{/each}
					</select>
				</div>
				<div class="space-y-1">
					<p class="text-xs font-medium text-muted-foreground">Program</p>
					<MultiSelectDropdown
						placeholder="All programs"
						options={programOptions.map((value) => ({ value, label: value }))}
						bind:selected={selectedPrograms}
						disabled={loading || loadedRows.length === 0}
					/>
				</div>
				<div class="space-y-1">
					<p class="text-xs font-medium text-muted-foreground">Employer</p>
					<MultiSelectDropdown
						placeholder="All employers"
						options={employerOptions.map((value) => ({ value, label: value }))}
						bind:selected={selectedEmployers}
						disabled={loading || loadedRows.length === 0}
					/>
				</div>
				<div class="space-y-1">
					<p class="text-xs font-medium text-muted-foreground">Coach</p>
					<MultiSelectDropdown
						placeholder="All coaches"
						options={coachOptions.map((value) => ({ value, label: value }))}
						bind:selected={selectedCoaches}
						disabled={loading || loadedRows.length === 0}
					/>
				</div>
			</div>

			<div class="grid gap-3 md:grid-cols-3">
				<div class="space-y-1 md:col-span-2">
					<p class="text-xs font-medium text-muted-foreground">Status</p>
					<MultiSelectDropdown
						placeholder="All statuses"
						options={statusOptions.map((value) => ({ value, label: value }))}
						bind:selected={selectedStatuses}
						disabled={loading || loadedRows.length === 0}
					/>
				</div>
			</div>

			<div class="grid gap-3 md:grid-cols-4">
				<div class="space-y-1">
					<label class="text-xs font-medium text-muted-foreground" for="comparisonEnabled">Comparison</label>
					<label class="inline-flex h-10 w-full items-center gap-2 rounded-md border border-input bg-background px-3 text-sm">
						<input
							id="comparisonEnabled"
							type="checkbox"
							class="size-4"
							bind:checked={comparisonEnabled}
							disabled={loading}
							onchange={() => syncComparisonInputsForPreviousMode(true)}
						/>
						<span>{comparisonEnabled ? 'Enabled' : 'Disabled'}</span>
					</label>
				</div>
				{#if comparisonEnabled}
					<div class="space-y-1">
						<label class="text-xs font-medium text-muted-foreground" for="comparisonMode">Comparison Type</label>
						<select
							id="comparisonMode"
							class="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
							bind:value={comparisonMode}
							disabled={loading}
							onchange={() => syncComparisonInputsForPreviousMode(true)}
						>
							<option value="previous">Previous Period</option>
							<option value="custom">Custom Range</option>
						</select>
					</div>
					<div class="space-y-1">
						<label class="text-xs font-medium text-muted-foreground" for="comparisonStart">Comparison Start</label>
						<Input id="comparisonStart" type="date" bind:value={comparisonStart} disabled={loading} />
					</div>
					<div class="space-y-1">
						<label class="text-xs font-medium text-muted-foreground" for="comparisonEnd">Comparison End</label>
						<Input id="comparisonEnd" type="date" bind:value={comparisonEnd} disabled={loading} />
					</div>
				{/if}
			</div>

			<ActiveFilterChips chips={chipItems} />

			<div class="flex flex-wrap items-center gap-2">
				<Button variant="destructive" class={RUN_BUTTON_CLASS} onclick={runReport} disabled={loading}>
					{loading ? 'Loading...' : 'Run'}
				</Button>
				<Button variant="outline" onclick={resetFilters} disabled={loading}>Reset Filters</Button>
				<Button
					variant="outline"
					class={EXPORT_BUTTON_CLASS}
					onclick={() => exportCsv(rows)}
					disabled={rows.length === 0 || loading}
				>
					Export CSV
				</Button>
			</div>

			<LoadStatus {loading} {error} {progressText} />
		</Card.Content>
	</Card.Root>

	<div class="grid gap-4 md:grid-cols-4">
		<KpiCard
			title="Total Sessions"
			value={rows.length}
			comparisonEnabled={comparisonEnabled}
			comparisonValue={comparisonEnabled ? comparisonRows.length : null}
			comparisonTrend="higher_is_better"
		/>
		<KpiCard
			title="Scheduled Sessions"
			value={scheduledCount}
			comparisonEnabled={comparisonEnabled}
			comparisonValue={comparisonEnabled ? comparisonScheduledCount : null}
			comparisonTrend="neutral"
		/>
		<KpiCard
			title="Completed Sessions"
			value={completedCount}
			comparisonEnabled={comparisonEnabled}
			comparisonValue={comparisonEnabled ? comparisonCompletedCount : null}
			comparisonTrend="higher_is_better"
		/>
		<KpiCard
			title="Missed Sessions (Rescheduled + No-Show)"
			value={missedCount}
			comparisonEnabled={comparisonEnabled}
			comparisonValue={comparisonEnabled ? comparisonMissedCount : null}
			comparisonTrend="lower_is_better"
		/>
	</div>

	<Card.Root>
		<Card.Header class="pb-2">
			<Card.Title class="text-base">Monthly Calendar Heatmap (Mon-Fri)</Card.Title>
		</Card.Header>
		<Card.Content>
			<WeekdayMonthlyHeatmap
				sessions={heatmapSessions}
				statusOptions={statusOptions}
				activeFilters={modalFilterLabels}
				rangeStartDate={rangeStart}
				rangeEndDate={rangeEnd}
				expandedTitle="Monthly Calendar Heatmap (Mon-Fri)"
			/>
		</Card.Content>
	</Card.Root>

	<TablePanel
		title="Scheduling Detail"
		columns={TABLE_COLUMNS}
		rows={table}
		footerText={summary ? `Generated at ${new Date(summary.generatedAt).toLocaleString()}` : 'No rows available.'}
		pageSize={20}
	/>
</div>
