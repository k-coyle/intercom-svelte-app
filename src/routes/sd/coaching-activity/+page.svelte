<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import LoadStatus from '$lib/components/report/LoadStatus.svelte';
	import HorizontalBarChart from '$lib/components/report/HorizontalBarChart.svelte';
	import MultiSeriesLineChart from '$lib/components/report/MultiSeriesLineChart.svelte';
	import MultiSelectDropdown from '$lib/components/report/MultiSelectDropdown.svelte';
	import ActiveFilterChips from '$lib/components/report/ActiveFilterChips.svelte';
	import KpiCard from '$lib/components/report/KpiCard.svelte';
	import TablePanel from '$lib/components/report/TablePanel.svelte';
	import * as Card from '$lib/components/ui/card';
	import { Input } from '$lib/components/ui/input';
	import { Button } from '$lib/components/ui/button';
	import {
		cleanupSdCoachingActivityJob,
		fetchAllSdCoachingActivityRows,
		fetchSdCoachingActivityView,
		runSdCoachingActivityJobUntilComplete
	} from '$lib/client/sd-coaching-activity-job';
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

	type CoachingRow = {
		conversationId: string;
		createdAt: number;
		createdDate: string;
		memberId: string | null;
		memberName: string | null;
		memberEmail: string | null;
		programs: string[];
		employer: string | null;
		channel: string | null;
		serviceCode: string | null;
		coachId: string | null;
		coachName: string | null;
		directionality: 'Unidirectional' | 'Bidirectional' | 'Other';
		state: string | null;
	};

	type FilterChip = {
		key: string;
		label: string;
		onRemove: () => void;
	};

	type CoachingSummary = {
		generatedAt: string;
		startDate: string;
		endDate: string;
		totalRows: number;
		dateBounds: {
			minCreatedDate: string | null;
			maxCreatedDate: string | null;
		};
	};

	type DimensionKey = 'program' | 'employer' | 'channel' | 'serviceCode' | 'coach' | 'directionality';
	type TimeSeriesResult = {
		dates: string[];
		series: Array<{ name: string; values: number[] }>;
		xAxisLabel: string;
	};

	export let data: {
		sandboxModeOffline?: boolean;
	};

	const TABLE_COLUMNS: TableColumn[] = [
		{ key: 'date', header: 'Created' },
		{ key: 'member', header: 'Member' },
		{ key: 'employer', header: 'Employer' },
		{ key: 'programs', header: 'Programs' },
		{ key: 'channel', header: 'Channel' },
		{ key: 'serviceCode', header: 'Service Code' },
		{ key: 'coach', header: 'Coach' },
		{ key: 'directionality', header: 'Directionality' }
	];
	const DIRECTIONALITY_OPTIONS = ['Unidirectional', 'Bidirectional', 'Other'];
	const RUN_BUTTON_CLASS = 'bg-red-700 text-white hover:bg-red-600 border-red-700';
	const EXPORT_BUTTON_CLASS = 'border-green-700 text-green-700 hover:bg-green-50';

	let rangeStart = '';
	let rangeEnd = '';
	let sandboxDateMin = '';
	let sandboxDateMax = '';
	let comparisonEnabled = false;
	let comparisonMode: ComparisonRangeMode = 'previous';
	let comparisonStart = '';
	let comparisonEnd = '';
	let lastAutoPreviousStart = '';
	let lastAutoPreviousEnd = '';

	let selectedPrograms: string[] = [];
	let selectedEmployers: string[] = [];
	let selectedServiceCodes: string[] = [];
	let selectedCoaches: string[] = [];
	let selectedChannels: string[] = [];
	let selectedDirectionality: string[] = [];
	let chartMode: 'bar' | 'line' = 'bar';

	let summary: CoachingSummary | null = null;
	let loadedRows: CoachingRow[] = [];
	let comparisonSummary: CoachingSummary | null = null;
	let comparisonLoadedRows: CoachingRow[] = [];
	let comparisonLoadedKey = '';
	let comparisonInputsSignature = '';
	let comparisonDisplayEnabled = false;
	let loading = false;
	let error: string | null = null;
	let progressText: string | null = null;
	let activePrimaryJobId = '';
	let activeComparisonJobId = '';
	const sessionJobIds = new Set<string>();
	const jobIdByRangeKey = new Map<string, string>();
	let controller: AbortController | null = null;

	let programOptions: string[] = [];
	let employerOptions: string[] = [];
	let serviceCodeOptions: string[] = [];
	let coachOptions: string[] = [];
	let channelOptions: string[] = [];
	let directionalityOptions: string[] = [...DIRECTIONALITY_OPTIONS];

	function toUnixStart(isoDate: string): number | null {
		const ms = Date.parse(`${isoDate}T00:00:00Z`);
		if (Number.isNaN(ms)) return null;
		return Math.floor(ms / 1000);
	}

	function toUnixEndExclusive(isoDate: string): number | null {
		const start = toUnixStart(isoDate);
		if (start == null) return null;
		return start + 24 * 60 * 60;
	}

	function effectiveStartDate(): string | null {
		const value = String(rangeStart || summary?.startDate || '').trim();
		return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
	}

	function effectiveEndDate(): string | null {
		const value = String(rangeEnd || summary?.endDate || '').trim();
		return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
	}

	function startOfUtcDay(unix: number): number {
		const date = new Date(unix * 1000);
		return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 1000);
	}

	function startOfUtcWeek(unix: number): number {
		const date = new Date(unix * 1000);
		const day = (date.getUTCDay() + 6) % 7;
		const aligned = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day));
		return Math.floor(aligned.getTime() / 1000);
	}

	function startOfUtcMonth(unix: number): number {
		const date = new Date(unix * 1000);
		return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / 1000);
	}

	function startOfUtcYear(unix: number): number {
		const date = new Date(unix * 1000);
		return Math.floor(Date.UTC(date.getUTCFullYear(), 0, 1) / 1000);
	}

	function pickGranularity(startUnix: number, endUnixExclusive: number): 'day' | 'week' | 'month' | 'year' {
		const daySpan = (endUnixExclusive - startUnix) / (24 * 60 * 60);
		if (daySpan >= 365) return 'year';
		if (daySpan >= 90) return 'month';
		if (daySpan >= 21) return 'week';
		return 'day';
	}

	function bucketStartUnix(unix: number, granularity: 'day' | 'week' | 'month' | 'year'): number {
		if (granularity === 'year') return startOfUtcYear(unix);
		if (granularity === 'month') return startOfUtcMonth(unix);
		if (granularity === 'week') return startOfUtcWeek(unix);
		return startOfUtcDay(unix);
	}

	function nextBucketUnix(unix: number, granularity: 'day' | 'week' | 'month' | 'year'): number {
		if (granularity === 'year') {
			const d = new Date(unix * 1000);
			return Math.floor(Date.UTC(d.getUTCFullYear() + 1, 0, 1) / 1000);
		}
		if (granularity === 'month') {
			const d = new Date(unix * 1000);
			return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000);
		}
		if (granularity === 'week') return unix + 7 * 24 * 60 * 60;
		return unix + 24 * 60 * 60;
	}

	function granularityAxisLabel(granularity: 'day' | 'week' | 'month' | 'year'): string {
		if (granularity === 'year') return 'Year';
		if (granularity === 'month') return 'Month';
		if (granularity === 'week') return 'Week';
		return 'Day';
	}

	function includesPrograms(row: CoachingRow): boolean {
		if (selectedPrograms.length === 0) return true;
		const rowPrograms = new Set((row.programs ?? []).map((value) => value.trim()));
		return selectedPrograms.some((value) => rowPrograms.has(value));
	}

	function includesEmployers(row: CoachingRow): boolean {
		if (selectedEmployers.length === 0) return true;
		if (!row.employer) return false;
		return selectedEmployers.includes(row.employer);
	}

	function includesServiceCodes(row: CoachingRow): boolean {
		if (selectedServiceCodes.length === 0) return true;
		if (!row.serviceCode) return false;
		return selectedServiceCodes.includes(row.serviceCode);
	}

	function includesCoaches(row: CoachingRow): boolean {
		if (selectedCoaches.length === 0) return true;
		if (!row.coachName) return false;
		return selectedCoaches.includes(row.coachName);
	}

	function includesChannels(row: CoachingRow): boolean {
		if (selectedChannels.length === 0) return true;
		if (!row.channel) return false;
		return selectedChannels.includes(row.channel);
	}

	function includesDirectionality(row: CoachingRow): boolean {
		if (selectedDirectionality.length === 0) return true;
		return selectedDirectionality.includes(row.directionality);
	}

	function filteredRowsFrom(sourceRows: CoachingRow[]): CoachingRow[] {
		return sourceRows.filter(
			(row) =>
				includesPrograms(row) &&
				includesEmployers(row) &&
				includesServiceCodes(row) &&
				includesCoaches(row) &&
				includesChannels(row) &&
				includesDirectionality(row)
		);
	}

	function valueKeys(row: CoachingRow, dimension: DimensionKey): string[] {
		if (dimension === 'program') return row.programs?.length ? row.programs : ['Unspecified'];
		if (dimension === 'employer') return [row.employer?.trim() || 'Unspecified'];
		if (dimension === 'channel') return [row.channel?.trim() || 'Unspecified'];
		if (dimension === 'serviceCode') return [row.serviceCode?.trim() || 'Unspecified'];
		if (dimension === 'coach') return [row.coachName?.trim() || 'Unassigned'];
		return [row.directionality || 'Other'];
	}

	function countsByDimension(rows: CoachingRow[], dimension: DimensionKey) {
		const counts = new Map<string, number>();
		for (const row of rows) {
			for (const key of valueKeys(row, dimension)) {
				counts.set(key, (counts.get(key) ?? 0) + 1);
			}
		}
		return [...counts.entries()].map(([label, value]) => ({ label, value }));
	}

	function dateSeriesByDimension(rows: CoachingRow[], dimension: DimensionKey): TimeSeriesResult {
		const startUnix = toUnixStart(effectiveStartDate() ?? '');
		const endUnixExclusive = toUnixEndExclusive(effectiveEndDate() ?? '');
		if (startUnix == null || endUnixExclusive == null || endUnixExclusive <= startUnix) {
			return { dates: [], series: [], xAxisLabel: 'Date' };
		}

		const granularity = pickGranularity(startUnix, endUnixExclusive);
		const firstBucket = bucketStartUnix(startUnix, granularity);
		const bucketStarts: number[] = [];
		for (let cursor = firstBucket; cursor < endUnixExclusive; cursor = nextBucketUnix(cursor, granularity)) {
			bucketStarts.push(cursor);
		}
		const dates = bucketStarts.map((unix) => new Date(unix * 1000).toISOString().slice(0, 10));
		const dateIndex = new Map<number, number>(bucketStarts.map((unix, index) => [unix, index]));
		const totals = new Map<string, number>();
		for (const row of rows) {
			if (row.createdAt < startUnix || row.createdAt >= endUnixExclusive) continue;
			for (const key of valueKeys(row, dimension)) {
				totals.set(key, (totals.get(key) ?? 0) + 1);
			}
		}

		const topKeys = [...totals.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 5)
			.map(([key]) => key);
		const otherKey = topKeys.length < totals.size ? 'Other' : null;
		const seriesMap = new Map<string, number[]>();
		for (const key of topKeys) seriesMap.set(key, dates.map(() => 0));
		if (otherKey) seriesMap.set(otherKey, dates.map(() => 0));

		for (const row of rows) {
			if (row.createdAt < startUnix || row.createdAt >= endUnixExclusive) continue;
			const idx = dateIndex.get(bucketStartUnix(row.createdAt, granularity));
			if (idx == null) continue;
			for (const key of valueKeys(row, dimension)) {
				if (seriesMap.has(key)) seriesMap.get(key)![idx] += 1;
				else if (otherKey) seriesMap.get(otherKey)![idx] += 1;
			}
		}

		return {
			dates,
			series: [...seriesMap.entries()].map(([name, values]) => ({ name, values })),
			xAxisLabel: granularityAxisLabel(granularity)
		};
	}

	function refreshFilterOptions() {
		programOptions = uniqueListValues(loadedRows);
		employerOptions = uniqueSorted(loadedRows.map((row) => row.employer));
		serviceCodeOptions = uniqueSorted(loadedRows.map((row) => row.serviceCode));
		coachOptions = uniqueSorted(loadedRows.map((row) => row.coachName));
		channelOptions = uniqueSorted(loadedRows.map((row) => row.channel));
		directionalityOptions = [...DIRECTIONALITY_OPTIONS];

		selectedPrograms = selectedPrograms.filter((value) => programOptions.includes(value));
		selectedEmployers = selectedEmployers.filter((value) => employerOptions.includes(value));
		selectedServiceCodes = selectedServiceCodes.filter((value) => serviceCodeOptions.includes(value));
		selectedCoaches = selectedCoaches.filter((value) => coachOptions.includes(value));
		selectedChannels = selectedChannels.filter((value) => channelOptions.includes(value));
		selectedDirectionality = selectedDirectionality.filter((value) => directionalityOptions.includes(value));
	}

	function resetFilters() {
		comparisonEnabled = false;
		comparisonMode = 'previous';
		comparisonStart = '';
		comparisonEnd = '';
		lastAutoPreviousStart = '';
		lastAutoPreviousEnd = '';
		selectedPrograms = [];
		selectedEmployers = [];
		selectedServiceCodes = [];
		selectedCoaches = [];
		selectedChannels = [];
		selectedDirectionality = [];
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

	function buildFilterChips(): FilterChip[] {
		const output: FilterChip[] = [];
		if (rangeStart || rangeEnd) {
			output.push({
				key: 'date-range',
				label: `Date: ${rangeStart || '...'} to ${rangeEnd || '...'}`,
				onRemove: clearDateRange
			});
		}
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
		for (const value of selectedServiceCodes) {
			output.push({
				key: `service-${value}`,
				label: `Service: ${value}`,
				onRemove: () => (selectedServiceCodes = selectedServiceCodes.filter((entry) => entry !== value))
			});
		}
		for (const value of selectedCoaches) {
			output.push({
				key: `coach-${value}`,
				label: `Coach: ${value}`,
				onRemove: () => (selectedCoaches = selectedCoaches.filter((entry) => entry !== value))
			});
		}
		for (const value of selectedChannels) {
			output.push({
				key: `channel-${value}`,
				label: `Channel: ${value}`,
				onRemove: () => (selectedChannels = selectedChannels.filter((entry) => entry !== value))
			});
		}
		for (const value of selectedDirectionality) {
			output.push({
				key: `direction-${value}`,
				label: `Directionality: ${value}`,
				onRemove: () =>
					(selectedDirectionality = selectedDirectionality.filter((entry) => entry !== value))
			});
		}
		return output;
	}

	function tableRows(rows: CoachingRow[]) {
		return rows.map((row) => ({
			date: row.createdDate ?? '-',
			member: row.memberName ?? row.memberEmail ?? row.memberId ?? '-',
			employer: row.employer ?? '-',
			programs: row.programs?.join(', ') || '-',
			channel: row.channel ?? '-',
			serviceCode: row.serviceCode ?? '-',
			coach: row.coachName ?? row.coachId ?? '-',
			directionality: row.directionality
		}));
	}

	function exportCsv(rows: CoachingRow[]) {
		const mapped = tableRows(rows);
		exportRowsAsCsv({
			filenamePrefix: 'sd_coaching_activity',
			headers: ['Created', 'Member', 'Employer', 'Programs', 'Channel', 'Service Code', 'Coach', 'Directionality'],
			rows: mapped.map((row) => [
				row.date,
				row.member,
				row.employer,
				row.programs,
				row.channel,
				row.serviceCode,
				row.coach,
				row.directionality
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

	function isJobNotFoundError(err: unknown): boolean {
		const message = String((err as any)?.message ?? err ?? '');
		return message.includes('HTTP 404') && message.includes('Job not found');
	}

	function isJobNotCompleteError(err: unknown): boolean {
		const message = String((err as any)?.message ?? err ?? '');
		return message.includes('HTTP 409') && message.includes('Job not complete');
	}

	function isTransientJobFetchError(err: unknown): boolean {
		return isJobNotFoundError(err) || isJobNotCompleteError(err);
	}

	function datasetKey(startDate: string, endDate: string): string {
		return `${startDate}..${endDate}`;
	}

	function comparisonSelectionKey(): string {
		const range = resolvedComparisonRange();
		if (!comparisonEnabled || !range) return '';
		return `${range.startDate}..${range.endDate}`;
	}

	function comparisonSignature(): string {
		return [
			comparisonEnabled ? 'enabled' : 'disabled',
			comparisonMode,
			comparisonStart,
			comparisonEnd,
			rangeStart,
			rangeEnd
		].join('|');
	}

	async function fetchDatasetForDates(
		startDate: string,
		endDate: string,
		kind: 'primary' | 'comparison'
	): Promise<{ summary: CoachingSummary; rows: CoachingRow[] }> {
		if (!controller) throw new Error('Missing abort controller');
		const tag = kind === 'comparison' ? 'comparison' : 'reporting';
		const cacheKey = datasetKey(startDate, endDate);
		const cachedJobId = jobIdByRangeKey.get(cacheKey) ?? '';
		if (cachedJobId) {
			try {
				progressText = `${tag} | reusing cached job ${cachedJobId}...`;
				const [loadedSummary, rows] = await Promise.all([
					fetchSdCoachingActivityView<CoachingSummary>(
						cachedJobId,
						'summary',
						undefined,
						undefined,
						controller.signal
					),
					fetchAllSdCoachingActivityRows<CoachingRow>({
						jobId: cachedJobId,
						limit: 5000,
						signal: controller.signal,
						onPage: ({ loaded, total }) => {
							progressText = `${tag} | loading cached coaching rows ${loaded}${total != null ? ` / ${total}` : ''}...`;
						}
					})
				]);
				return { summary: loadedSummary, rows };
			} catch (err) {
				if (!isTransientJobFetchError(err)) throw err;
				jobIdByRangeKey.delete(cacheKey);
				sessionJobIds.delete(cachedJobId);
			}
		}

		const { jobId } = await runSdCoachingActivityJobUntilComplete({
			startDate,
			endDate,
			signal: controller.signal,
			onJobCreated: (id) => {
				if (kind === 'primary') activePrimaryJobId = id;
				else activeComparisonJobId = id;
				sessionJobIds.add(id);
				jobIdByRangeKey.set(cacheKey, id);
			},
			onProgress: (progress) => {
				const p = progress?.progress ?? {};
				progressText = `${tag} | phase ${progress?.phase ?? 'running'} | conv pages ${p.conversationPagesFetched ?? 0} | details ${p.detailsLoaded ?? 0} | contacts ${p.contactsLoaded ?? 0}`;
			}
		});

		const [loadedSummary, rows] = await Promise.all([
			fetchSdCoachingActivityView<CoachingSummary>(
				jobId,
				'summary',
				undefined,
				undefined,
				controller.signal
			),
			fetchAllSdCoachingActivityRows<CoachingRow>({
				jobId,
				limit: 5000,
				signal: controller.signal,
				onPage: ({ loaded, total }) => {
					progressText = `${tag} | loading coaching rows ${loaded}${total != null ? ` / ${total}` : ''}...`;
				}
			})
		]);
		if (kind === 'primary' && activePrimaryJobId === jobId) activePrimaryJobId = '';
		if (kind === 'comparison' && activeComparisonJobId === jobId) activeComparisonJobId = '';
		return { summary: loadedSummary, rows };
	}

	async function runReport(): Promise<void> {
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
		progressText = 'Starting coaching activity job...';
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
			comparisonLoadedKey = comparisonRange ? `${comparisonRange.startDate}..${comparisonRange.endDate}` : '';
			refreshFilterOptions();

			if (data?.sandboxModeOffline) {
				sandboxDateMin = primary.summary?.dateBounds?.minCreatedDate ?? '';
				sandboxDateMax = primary.summary?.dateBounds?.maxCreatedDate ?? '';
			}
		} catch (err: any) {
			error = err?.message ?? 'Unable to load coaching activity report.';
			summary = null;
			loadedRows = [];
			comparisonSummary = null;
			comparisonLoadedRows = [];
			comparisonLoadedKey = '';
		} finally {
			loading = false;
			progressText = null;
		}
	}

	let rows: CoachingRow[] = [];
	let comparisonRows: CoachingRow[] = [];
	let uniqueMembers = 0;
	let comparisonUniqueMembers = 0;
	let activeCoaches = 0;
	let comparisonActiveCoaches = 0;
	let encountersPerCoach = '0.00';
	let comparisonEncountersPerCoach = 0;
	let barsProgram: Array<{ label: string; value: number }> = [];
	let barsEmployer: Array<{ label: string; value: number }> = [];
	let barsChannel: Array<{ label: string; value: number }> = [];
	let barsServiceCode: Array<{ label: string; value: number }> = [];
	let barsCoach: Array<{ label: string; value: number }> = [];
	let barsDirection: Array<{ label: string; value: number }> = [];
	let lineProgram: TimeSeriesResult = {
		dates: [],
		series: [],
		xAxisLabel: 'Date'
	};
	let lineEmployer: TimeSeriesResult = {
		dates: [],
		series: [],
		xAxisLabel: 'Date'
	};
	let lineChannel: TimeSeriesResult = {
		dates: [],
		series: [],
		xAxisLabel: 'Date'
	};
	let lineServiceCode: TimeSeriesResult = {
		dates: [],
		series: [],
		xAxisLabel: 'Date'
	};
	let lineCoach: TimeSeriesResult = {
		dates: [],
		series: [],
		xAxisLabel: 'Date'
	};
	let lineDirection: TimeSeriesResult = {
		dates: [],
		series: [],
		xAxisLabel: 'Date'
	};
	let table: Array<Record<string, string>> = [];
	let chipItems: FilterChip[] = [];
	let modalFilterLabels: string[] = [];

	$: {
		const nextSignature = comparisonSignature();
		if (comparisonInputsSignature && nextSignature !== comparisonInputsSignature) {
			comparisonLoadedKey = '';
		}
		comparisonInputsSignature = nextSignature;
	}

	$: {
		const activeComparisonKey = comparisonSelectionKey();
		comparisonDisplayEnabled =
			comparisonEnabled &&
			activeComparisonKey.length > 0 &&
			comparisonLoadedKey.length > 0 &&
			activeComparisonKey === comparisonLoadedKey;
	}

	$: {
		loadedRows;
		comparisonLoadedRows;
		rangeStart;
		rangeEnd;
		comparisonEnabled;
		comparisonMode;
		comparisonStart;
		comparisonEnd;
		selectedPrograms;
		selectedEmployers;
		selectedServiceCodes;
		selectedCoaches;
		selectedChannels;
		selectedDirectionality;

		rows = filteredRowsFrom(loadedRows);
		comparisonRows = filteredRowsFrom(comparisonLoadedRows);
		uniqueMembers = new Set(rows.map((row) => row.memberId || row.memberEmail || row.conversationId)).size;
		comparisonUniqueMembers = new Set(
			comparisonRows.map((row) => row.memberId || row.memberEmail || row.conversationId)
		).size;
		activeCoaches = new Set(rows.map((row) => row.coachId || row.coachName || '').filter(Boolean)).size;
		comparisonActiveCoaches = new Set(
			comparisonRows.map((row) => row.coachId || row.coachName || '').filter(Boolean)
		).size;
		encountersPerCoach = activeCoaches > 0 ? (rows.length / activeCoaches).toFixed(2) : '0.00';
		comparisonEncountersPerCoach =
			comparisonActiveCoaches > 0 ? comparisonRows.length / comparisonActiveCoaches : 0;
		barsProgram = countsByDimension(rows, 'program');
		barsEmployer = countsByDimension(rows, 'employer');
		barsChannel = countsByDimension(rows, 'channel');
		barsServiceCode = countsByDimension(rows, 'serviceCode');
		barsCoach = countsByDimension(rows, 'coach');
		barsDirection = countsByDimension(rows, 'directionality');
		lineProgram = dateSeriesByDimension(rows, 'program');
		lineEmployer = dateSeriesByDimension(rows, 'employer');
		lineChannel = dateSeriesByDimension(rows, 'channel');
		lineServiceCode = dateSeriesByDimension(rows, 'serviceCode');
		lineCoach = dateSeriesByDimension(rows, 'coach');
		lineDirection = dateSeriesByDimension(rows, 'directionality');
		table = tableRows(rows);
		chipItems = buildFilterChips();
		modalFilterLabels = chipItems.map((chip) => chip.label);
	}

	$: syncComparisonInputsForPreviousMode();

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
		for (const jobId of sessionJobIds) {
			void cleanupSdCoachingActivityJob(jobId, true);
		}
		sessionJobIds.clear();
		jobIdByRangeKey.clear();
	});
</script>

<div class="space-y-4">
	<Card.Root>
		<Card.Header class="pb-3">
			<Card.Title class="text-base">Coaching Activity Filters</Card.Title>
		</Card.Header>
		<Card.Content class="space-y-4">
			<div class="grid gap-3 md:grid-cols-4 xl:grid-cols-7">
				<div class="space-y-1">
					<label class="text-xs font-medium text-muted-foreground" for="rangeStart">Reporting Start</label>
					<Input
						id="rangeStart"
						type="date"
						bind:value={rangeStart}
						min={data?.sandboxModeOffline ? sandboxDateMin : undefined}
						max={data?.sandboxModeOffline ? sandboxDateMax : undefined}
					/>
				</div>
				<div class="space-y-1">
					<label class="text-xs font-medium text-muted-foreground" for="rangeEnd">Reporting End</label>
					<Input
						id="rangeEnd"
						type="date"
						bind:value={rangeEnd}
						min={data?.sandboxModeOffline ? sandboxDateMin : undefined}
						max={data?.sandboxModeOffline ? sandboxDateMax : undefined}
					/>
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
					<p class="text-xs font-medium text-muted-foreground">Service Code</p>
					<MultiSelectDropdown
						placeholder="All service codes"
						options={serviceCodeOptions.map((value) => ({ value, label: value }))}
						bind:selected={selectedServiceCodes}
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
				<div class="space-y-1">
					<p class="text-xs font-medium text-muted-foreground">Channel</p>
					<MultiSelectDropdown
						placeholder="All channels"
						options={channelOptions.map((value) => ({ value, label: value }))}
						bind:selected={selectedChannels}
						disabled={loading || loadedRows.length === 0}
					/>
				</div>
			</div>

			<div class="grid gap-3 md:grid-cols-4">
				<div class="space-y-1 md:col-span-2">
					<p class="text-xs font-medium text-muted-foreground">Directionality</p>
					<MultiSelectDropdown
						placeholder="All directionality"
						options={directionalityOptions.map((value) => ({ value, label: value }))}
						bind:selected={selectedDirectionality}
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
				<div class="ml-auto flex items-center gap-2">
					<Button
						variant={chartMode === 'bar' ? 'default' : 'outline'}
						class={chartMode === 'bar'
							? 'bg-blue-900 text-white hover:bg-blue-800 border-blue-900'
							: 'border-blue-200 text-blue-900 hover:bg-blue-50'}
						onclick={() => (chartMode = 'bar')}
					>
						Bar Charts
					</Button>
					<Button
						variant={chartMode === 'line' ? 'default' : 'outline'}
						class={chartMode === 'line'
							? 'bg-blue-900 text-white hover:bg-blue-800 border-blue-900'
							: 'border-blue-200 text-blue-900 hover:bg-blue-50'}
						onclick={() => (chartMode = 'line')}
					>
						Line Charts
					</Button>
				</div>
			</div>

			<LoadStatus {loading} {error} {progressText} />
		</Card.Content>
	</Card.Root>

	<div class="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
		<KpiCard
			title="Total Coach Encounters"
			value={rows.length}
			comparisonEnabled={comparisonDisplayEnabled}
			comparisonValue={comparisonDisplayEnabled ? comparisonRows.length : null}
			comparisonTrend="higher_is_better"
		/>
		<KpiCard
			title="Unique Members"
			value={uniqueMembers}
			comparisonEnabled={comparisonDisplayEnabled}
			comparisonValue={comparisonDisplayEnabled ? comparisonUniqueMembers : null}
			comparisonTrend="higher_is_better"
		/>
		<KpiCard
			title="Active Coaches"
			value={activeCoaches}
			comparisonEnabled={comparisonDisplayEnabled}
			comparisonValue={comparisonDisplayEnabled ? comparisonActiveCoaches : null}
			comparisonTrend="neutral"
		/>
		<KpiCard
			title="Encounters / Coach"
			value={Number(encountersPerCoach)}
			comparisonEnabled={comparisonDisplayEnabled}
			comparisonValue={comparisonDisplayEnabled ? comparisonEncountersPerCoach : null}
			comparisonTrend="neutral"
			valueFractionDigits={2}
			deltaFractionDigits={2}
		/>
	</div>

	{#if chartMode === 'bar'}
		<div class="grid gap-4 xl:grid-cols-2">
			<Card.Root><Card.Header class="pb-2"><Card.Title class="text-base">Encounters by Program</Card.Title></Card.Header><Card.Content><HorizontalBarChart items={barsProgram} xAxisLabel="Encounters" yAxisLabel="Program" expandedTitle="Encounters by Program" activeFilters={modalFilterLabels} /></Card.Content></Card.Root>
			<Card.Root><Card.Header class="pb-2"><Card.Title class="text-base">Encounters by Employer</Card.Title></Card.Header><Card.Content><HorizontalBarChart items={barsEmployer} xAxisLabel="Encounters" yAxisLabel="Employer" expandedTitle="Encounters by Employer" activeFilters={modalFilterLabels} /></Card.Content></Card.Root>
			<Card.Root><Card.Header class="pb-2"><Card.Title class="text-base">Encounters by Channel</Card.Title></Card.Header><Card.Content><HorizontalBarChart items={barsChannel} xAxisLabel="Encounters" yAxisLabel="Channel" expandedTitle="Encounters by Channel" activeFilters={modalFilterLabels} /></Card.Content></Card.Root>
			<Card.Root><Card.Header class="pb-2"><Card.Title class="text-base">Encounters by Service Code</Card.Title></Card.Header><Card.Content><HorizontalBarChart items={barsServiceCode} xAxisLabel="Encounters" yAxisLabel="Service Code" expandedTitle="Encounters by Service Code" activeFilters={modalFilterLabels} /></Card.Content></Card.Root>
			<Card.Root><Card.Header class="pb-2"><Card.Title class="text-base">Encounters by Coach</Card.Title></Card.Header><Card.Content><HorizontalBarChart items={barsCoach} xAxisLabel="Encounters" yAxisLabel="Coach" expandedTitle="Encounters by Coach" activeFilters={modalFilterLabels} /></Card.Content></Card.Root>
			<Card.Root><Card.Header class="pb-2"><Card.Title class="text-base">Encounters by Directionality</Card.Title></Card.Header><Card.Content><HorizontalBarChart items={barsDirection} xAxisLabel="Encounters" yAxisLabel="Directionality" expandedTitle="Encounters by Directionality" activeFilters={modalFilterLabels} /></Card.Content></Card.Root>
		</div>
	{:else}
		<div class="grid gap-4 xl:grid-cols-2">
			<Card.Root><Card.Header class="pb-2"><Card.Title class="text-base">Encounter Trend by Program</Card.Title></Card.Header><Card.Content><MultiSeriesLineChart dates={lineProgram.dates} series={lineProgram.series} yAxisLabel="Encounters" xAxisLabel={lineProgram.xAxisLabel} expandedTitle="Encounter Trend by Program" activeFilters={modalFilterLabels} /></Card.Content></Card.Root>
			<Card.Root><Card.Header class="pb-2"><Card.Title class="text-base">Encounter Trend by Employer</Card.Title></Card.Header><Card.Content><MultiSeriesLineChart dates={lineEmployer.dates} series={lineEmployer.series} yAxisLabel="Encounters" xAxisLabel={lineEmployer.xAxisLabel} expandedTitle="Encounter Trend by Employer" activeFilters={modalFilterLabels} /></Card.Content></Card.Root>
			<Card.Root><Card.Header class="pb-2"><Card.Title class="text-base">Encounter Trend by Channel</Card.Title></Card.Header><Card.Content><MultiSeriesLineChart dates={lineChannel.dates} series={lineChannel.series} yAxisLabel="Encounters" xAxisLabel={lineChannel.xAxisLabel} expandedTitle="Encounter Trend by Channel" activeFilters={modalFilterLabels} /></Card.Content></Card.Root>
			<Card.Root><Card.Header class="pb-2"><Card.Title class="text-base">Encounter Trend by Service Code</Card.Title></Card.Header><Card.Content><MultiSeriesLineChart dates={lineServiceCode.dates} series={lineServiceCode.series} yAxisLabel="Encounters" xAxisLabel={lineServiceCode.xAxisLabel} expandedTitle="Encounter Trend by Service Code" activeFilters={modalFilterLabels} /></Card.Content></Card.Root>
			<Card.Root><Card.Header class="pb-2"><Card.Title class="text-base">Encounter Trend by Coach</Card.Title></Card.Header><Card.Content><MultiSeriesLineChart dates={lineCoach.dates} series={lineCoach.series} yAxisLabel="Encounters" xAxisLabel={lineCoach.xAxisLabel} expandedTitle="Encounter Trend by Coach" activeFilters={modalFilterLabels} /></Card.Content></Card.Root>
			<Card.Root><Card.Header class="pb-2"><Card.Title class="text-base">Encounter Trend by Directionality</Card.Title></Card.Header><Card.Content><MultiSeriesLineChart dates={lineDirection.dates} series={lineDirection.series} yAxisLabel="Encounters" xAxisLabel={lineDirection.xAxisLabel} expandedTitle="Encounter Trend by Directionality" activeFilters={modalFilterLabels} /></Card.Content></Card.Root>
		</div>
	{/if}

	<TablePanel
		title="Coaching Encounter Detail"
		columns={TABLE_COLUMNS}
		rows={table}
		footerText={summary ? `Generated at ${new Date(summary.generatedAt).toLocaleString()}` : 'No rows available.'}
		pageSize={20}
	/>
</div>
