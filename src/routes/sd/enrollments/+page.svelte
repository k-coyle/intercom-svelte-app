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
		cleanupSdEnrollmentsJob,
		fetchAllSdEnrollmentsRows,
		fetchSdEnrollmentsView,
		runSdEnrollmentsJobUntilComplete
	} from '$lib/client/sd-enrollments-job';
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

	type EnrollmentRow = {
		memberId: string;
		memberName: string | null;
		memberEmail: string | null;
		employer: string | null;
		programs: string[];
		registrationAt: number | null;
		enrolledAt: number | null;
		enrollmentAt: number | null;
		enrollmentDate: string | null;
	};

	type FilterChip = {
		key: string;
		label: string;
		onRemove: () => void;
	};

	type EnrollmentChartCompareKey =
		| 'newProgramBar'
		| 'newEmployerBar'
		| 'newProgramLine'
		| 'newEmployerLine'
		| 'totalProgramBar'
		| 'totalEmployerBar'
		| 'totalProgramLine'
		| 'totalEmployerLine';

	type LineSeriesResult = {
		dates: string[];
		series: Array<{ name: string; values: Array<number | null> }>;
		xAxisLabel: string;
	};

	type EnrollmentSummary = {
		generatedAt: string;
		startDate: string;
		endDate: string;
		totalRows: number;
		dateBounds: {
			minEnrollmentDate: string | null;
			maxEnrollmentDate: string | null;
		};
	};

	export let data: {
		sandboxModeOffline?: boolean;
	};

	const TABLE_COLUMNS: TableColumn[] = [
		{ key: 'member', header: 'Member' },
		{ key: 'employer', header: 'Employer' },
		{ key: 'programs', header: 'Programs' },
		{ key: 'enrollmentDate', header: 'Enrollment Date' },
		{ key: 'isNew', header: 'New in Period' }
	];
	const RUN_BUTTON_CLASS = 'bg-red-700 text-white hover:bg-red-600 border-red-700';
	const EXPORT_BUTTON_CLASS = 'border-green-700 text-green-700 hover:bg-green-50';
	const COMPARISON_ENABLED_BUTTON_CLASS = 'w-full bg-blue-900 text-white hover:bg-blue-800 border-blue-900';
	const COMPARISON_DISABLED_BUTTON_CLASS =
		'w-full border-blue-300 text-blue-900 hover:bg-blue-50';
	const CHART_COMPARE_ACTIVE_CLASS =
		'border-slate-900 bg-slate-900 text-white hover:bg-slate-800';
	const CHART_COMPARE_INACTIVE_CLASS =
		'border-slate-300 text-slate-700 hover:bg-slate-50';
	const DEFAULT_CHART_COMPARISON: Record<EnrollmentChartCompareKey, boolean> = {
		newProgramBar: false,
		newEmployerBar: false,
		newProgramLine: false,
		newEmployerLine: false,
		totalProgramBar: false,
		totalEmployerBar: false,
		totalProgramLine: false,
		totalEmployerLine: false
	};

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

	let summary: EnrollmentSummary | null = null;
	let loadedRows: EnrollmentRow[] = [];
	let comparisonSummary: EnrollmentSummary | null = null;
	let comparisonLoadedRows: EnrollmentRow[] = [];
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

	function dateInRange(row: EnrollmentRow, startUnix: number, endUnixExclusive: number): boolean {
		if (row.enrollmentAt == null) return false;
		return row.enrollmentAt >= startUnix && row.enrollmentAt < endUnixExclusive;
	}

	function includesSelectedPrograms(row: EnrollmentRow): boolean {
		if (selectedPrograms.length === 0) return true;
		const rowPrograms = new Set((row.programs ?? []).map((value) => value.trim()));
		return selectedPrograms.some((value) => rowPrograms.has(value));
	}

	function includesSelectedEmployers(row: EnrollmentRow): boolean {
		if (selectedEmployers.length === 0) return true;
		if (!row.employer) return false;
		return selectedEmployers.includes(row.employer);
	}

	function rowsAfterNonDateFilters(sourceRows: EnrollmentRow[]): EnrollmentRow[] {
		return sourceRows.filter((row) => includesSelectedPrograms(row) && includesSelectedEmployers(row));
	}

	function effectiveStartDate(): string | null {
		const value = String(rangeStart || summary?.startDate || '').trim();
		return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
	}

	function effectiveEndDate(): string | null {
		const value = String(rangeEnd || summary?.endDate || '').trim();
		return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
	}

	function totalEnrollmentRows(sourceRows: EnrollmentRow[], endDateIso: string): EnrollmentRow[] {
		const endUnixExclusive = toUnixEndExclusive(endDateIso);
		if (endUnixExclusive == null) return [];
		return rowsAfterNonDateFilters(sourceRows).filter(
			(row) => row.enrollmentAt != null && row.enrollmentAt < endUnixExclusive
		);
	}

	function newEnrollmentRows(sourceRows: EnrollmentRow[], startDateIso: string, endDateIso: string): EnrollmentRow[] {
		const startUnix = toUnixStart(startDateIso);
		const endUnixExclusive = toUnixEndExclusive(endDateIso);
		if (startUnix == null || endUnixExclusive == null) return [];
		return rowsAfterNonDateFilters(sourceRows).filter((row) => dateInRange(row, startUnix, endUnixExclusive));
	}

	function buildBarData(rows: EnrollmentRow[], dimension: 'program' | 'employer') {
		const counts = new Map<string, number>();
		for (const row of rows) {
			if (dimension === 'program') {
				const programs = row.programs?.length ? row.programs : ['Unspecified'];
				for (const program of programs) {
					counts.set(program, (counts.get(program) ?? 0) + 1);
				}
			} else {
				const employer = row.employer?.trim() || 'Unspecified';
				counts.set(employer, (counts.get(employer) ?? 0) + 1);
			}
		}
		return [...counts.entries()]
			.map(([label, value]) => ({ label, value }))
			.sort((a, b) => {
				if (b.value !== a.value) return b.value - a.value;
				return a.label.localeCompare(b.label);
			});
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

	function bucketLabel(unix: number, _granularity: 'day' | 'week' | 'month' | 'year'): string {
		return new Date(unix * 1000).toISOString().slice(0, 10);
	}

	function buildDateSeries(
		rows: EnrollmentRow[],
		dimension: 'program' | 'employer',
		mode: 'selected-range' | 'from-first-enrollment' | 'selected-range-cumulative',
		range: { startDate: string; endDate: string } | null = null
	): LineSeriesResult {
		const startDateIso = range?.startDate ?? effectiveStartDate() ?? '';
		const endDateIso = range?.endDate ?? effectiveEndDate() ?? '';
		const endUnixExclusive = toUnixEndExclusive(endDateIso);
		if (endUnixExclusive == null) return { dates: [], series: [], xAxisLabel: 'Date' };

		let startUnix: number | null = null;
		if (mode === 'selected-range' || mode === 'selected-range-cumulative') {
			startUnix = toUnixStart(startDateIso);
		} else {
			const source = rowsAfterNonDateFilters(loadedRows)
				.map((row) => row.enrollmentAt)
					.filter((value): value is number => value != null && Number.isFinite(value));
			if (source.length > 0) {
				startUnix = Math.min(...source);
			}
		}
		if (startUnix == null || endUnixExclusive <= startUnix) {
			return { dates: [], series: [], xAxisLabel: 'Date' };
		}

		const granularity = pickGranularity(startUnix, endUnixExclusive);
		const firstBucket = bucketStartUnix(startUnix, granularity);
		const bucketStarts: number[] = [];
		for (let cursor = firstBucket; cursor < endUnixExclusive; cursor = nextBucketUnix(cursor, granularity)) {
			bucketStarts.push(cursor);
		}
			const labels = bucketStarts.map((unix) => bucketLabel(unix, granularity));
			const indexByBucket = new Map<number, number>(bucketStarts.map((unix, index) => [unix, index]));

			const totals = new Map<string, number>();
			for (const row of rows) {
				if (row.enrollmentAt == null || row.enrollmentAt >= endUnixExclusive) {
					continue;
				}
				if (mode !== 'selected-range-cumulative' && row.enrollmentAt < startUnix) {
					continue;
				}
				const keys =
					dimension === 'program'
						? row.programs?.length
						? row.programs
						: ['Unspecified']
					: [row.employer?.trim() || 'Unspecified'];
			for (const key of keys) {
				totals.set(key, (totals.get(key) ?? 0) + 1);
			}
		}

		const orderedKeys = [...totals.entries()]
			.sort((a, b) => {
				if (b[1] !== a[1]) return b[1] - a[1];
				return a[0].localeCompare(b[0]);
			})
			.map(([key]) => key);
			const seriesMap = new Map<string, Array<number | null>>();
		for (const key of orderedKeys) {
			seriesMap.set(key, labels.map(() => 0));
		}
		const openingCounts = new Map<string, number>();

		for (const row of rows) {
			if (row.enrollmentAt == null || row.enrollmentAt >= endUnixExclusive) {
				continue;
			}
			const keys =
				dimension === 'program'
					? row.programs?.length
						? row.programs
						: ['Unspecified']
					: [row.employer?.trim() || 'Unspecified'];

			if (mode === 'selected-range-cumulative' && row.enrollmentAt < startUnix) {
				for (const key of keys) {
					openingCounts.set(key, (openingCounts.get(key) ?? 0) + 1);
				}
				continue;
			}
			if (row.enrollmentAt < startUnix) {
				continue;
			}

			const bucketUnix = bucketStartUnix(row.enrollmentAt, granularity);
			const bucketIndex = indexByBucket.get(bucketUnix);
			if (bucketIndex == null) continue;

			for (const key of keys) {
				const values = seriesMap.get(key);
				if (!values) continue;
				values[bucketIndex] = (values[bucketIndex] ?? 0) + 1;
			}
		}

		if (mode === 'selected-range-cumulative') {
				for (const key of orderedKeys) {
					const values = seriesMap.get(key);
					if (!values) continue;
					let running = openingCounts.get(key) ?? 0;
					let started = false;
					for (let index = 0; index < values.length; index += 1) {
						running += values[index] ?? 0;
						if (!started && running <= 0) {
							values[index] = null;
							continue;
						}
						started = true;
						values[index] = running;
					}
				}
			}

		return {
			dates: labels,
			series: [...seriesMap.entries()].map(([name, values]) => ({ name, values })),
			xAxisLabel: 'Date'
		};
	}

	function resetChartComparisons(): void {
		chartComparison = { ...DEFAULT_CHART_COMPARISON };
	}

	function toggleChartComparison(key: EnrollmentChartCompareKey): void {
		chartComparison = { ...chartComparison, [key]: !chartComparison[key] };
	}

	function tableRows() {
		const startUnix = toUnixStart(effectiveStartDate() ?? '');
		const endDate = effectiveEndDate() ?? '';
		const rows = totalEnrollmentRows(loadedRows, endDate);
		return rows.map((row) => ({
			member: row.memberName ?? row.memberEmail ?? row.memberId,
			employer: row.employer ?? '-',
			programs: row.programs?.join(', ') || '-',
			enrollmentDate: row.enrollmentDate ?? '-',
			isNew: startUnix != null && row.enrollmentAt != null && row.enrollmentAt >= startUnix ? 'Yes' : 'No'
		}));
	}

	function exportCsv() {
		const rows = tableRows();
		exportRowsAsCsv({
			filenamePrefix: 'sd_enrollments',
			headers: ['Member', 'Employer', 'Programs', 'Enrollment Date', 'New in Period'],
			rows: rows.map((row) => [row.member, row.employer, row.programs, row.enrollmentDate, row.isNew])
		});
	}

	function refreshFilterOptions() {
		programOptions = uniqueListValues(loadedRows);
		employerOptions = uniqueSorted(loadedRows.map((row) => row.employer));
		selectedPrograms = selectedPrograms.filter((program) => programOptions.includes(program));
		selectedEmployers = selectedEmployers.filter((employer) => employerOptions.includes(employer));
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
			resetChartComparisons();
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

	function toggleComparison(): void {
		comparisonEnabled = !comparisonEnabled;
		if (comparisonEnabled) {
			syncComparisonInputsForPreviousMode(true);
		}
	}

	function activeFilterChips(): FilterChip[] {
		const chips: FilterChip[] = [];
		if (rangeStart || rangeEnd) {
			chips.push({
				key: 'date-range',
				label: `Date: ${rangeStart || '...'} to ${rangeEnd || '...'}`,
				onRemove: clearDateRange
			});
		}
		if (comparisonEnabled) {
			if (comparisonMode === 'custom') {
				chips.push({
					key: 'comparison-custom',
					label: `Comparison: ${comparisonStart || '...'} to ${comparisonEnd || '...'}`,
					onRemove: () => {
						comparisonEnabled = false;
						comparisonStart = '';
						comparisonEnd = '';
					}
				});
			} else {
				chips.push({
					key: 'comparison-previous',
					label: 'Comparison: Previous Period',
					onRemove: () => {
						comparisonEnabled = false;
					}
				});
			}
		}
		for (const program of selectedPrograms) {
			chips.push({
				key: `program-${program}`,
				label: `Program: ${program}`,
				onRemove: () => {
					selectedPrograms = selectedPrograms.filter((value) => value !== program);
				}
			});
		}
		for (const employer of selectedEmployers) {
			chips.push({
				key: `employer-${employer}`,
				label: `Employer: ${employer}`,
				onRemove: () => {
					selectedEmployers = selectedEmployers.filter((value) => value !== employer);
				}
			});
		}
		return chips;
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

	function datasetKey(_startDate: string, endDate: string): string {
		// The enrollments backend query uses endDate as the retrieval bound.
		return `end:${endDate}`;
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
	): Promise<{ summary: EnrollmentSummary; rows: EnrollmentRow[] }> {
		if (!controller) throw new Error('Missing abort controller');
		const tag = kind === 'comparison' ? 'comparison' : 'reporting';
		const cacheKey = datasetKey(startDate, endDate);
		const cachedJobId = jobIdByRangeKey.get(cacheKey) ?? '';
		if (cachedJobId) {
			try {
				progressText = `${tag} | reusing cached job ${cachedJobId}...`;
				const failFastRetry = { retryNotFound: false, retryNotComplete: false, retryLimit: 0 };
				const loadedSummary = await fetchSdEnrollmentsView<EnrollmentSummary>(
					cachedJobId,
					'summary',
					undefined,
					undefined,
					controller.signal,
					failFastRetry
				);
				const rows = await fetchAllSdEnrollmentsRows<EnrollmentRow>({
					jobId: cachedJobId,
					limit: 5000,
					signal: controller.signal,
					retry: failFastRetry,
					onPage: ({ loaded, total }) => {
						progressText = `${tag} | loading cached enrollment rows ${loaded}${total != null ? ` / ${total}` : ''}...`;
					}
				});
				return { summary: loadedSummary, rows };
			} catch (err) {
				if (!isTransientJobFetchError(err)) throw err;
				jobIdByRangeKey.delete(cacheKey);
				sessionJobIds.delete(cachedJobId);
			}
		}

		const { jobId } = await runSdEnrollmentsJobUntilComplete({
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
				progressText = `${tag} | phase ${progress?.phase ?? 'running'} | reg pages ${p.registrationPagesFetched ?? 0} | enr pages ${p.enrolledPagesFetched ?? 0} | contacts ${p.dedupedContacts ?? 0}`;
			}
		});
		const loadedSummary = await fetchSdEnrollmentsView<EnrollmentSummary>(
			jobId,
			'summary',
			undefined,
			undefined,
			controller.signal
		);
		const rows = await fetchAllSdEnrollmentsRows<EnrollmentRow>({
			jobId,
			limit: 5000,
			signal: controller.signal,
			onPage: ({ loaded, total }) => {
				progressText = `${tag} | loading enrollment rows ${loaded}${total != null ? ` / ${total}` : ''}...`;
			}
		});
		if (kind === 'primary' && activePrimaryJobId === jobId) activePrimaryJobId = '';
		if (kind === 'comparison' && activeComparisonJobId === jobId) activeComparisonJobId = '';
		return { summary: loadedSummary, rows };
	}

	async function runReport(): Promise<void> {
		resetChartComparisons();
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
		progressText = 'Starting enrollments job...';
		try {
			const primary = await fetchDatasetForDates(rangeStart, rangeEnd, 'primary');
			const comparison = comparisonRange
				? await fetchDatasetForDates(comparisonRange.startDate, comparisonRange.endDate, 'comparison')
				: null;
			summary = primary.summary;
			loadedRows = primary.rows;
			comparisonSummary = comparison?.summary ?? null;
			comparisonLoadedRows = comparison?.rows ?? [];
			comparisonLoadedKey = comparisonRange ? `${comparisonRange.startDate}..${comparisonRange.endDate}` : '';
			refreshFilterOptions();

			if (data?.sandboxModeOffline) {
				sandboxDateMin = primary.summary?.dateBounds?.minEnrollmentDate ?? '';
				sandboxDateMax = primary.summary?.dateBounds?.maxEnrollmentDate ?? '';
			}
		} catch (err: any) {
			error = err?.message ?? 'Unable to load enrollments report.';
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

	let totalRows: EnrollmentRow[] = [];
	let newRows: EnrollmentRow[] = [];
	let comparisonTotalRows: EnrollmentRow[] = [];
	let comparisonNewRows: EnrollmentRow[] = [];
	let totalProgramBar: Array<{ label: string; value: number }> = [];
	let totalEmployerBar: Array<{ label: string; value: number }> = [];
	let newProgramBar: Array<{ label: string; value: number }> = [];
	let newEmployerBar: Array<{ label: string; value: number }> = [];
	let comparisonTotalProgramBar: Array<{ label: string; value: number }> = [];
	let comparisonTotalEmployerBar: Array<{ label: string; value: number }> = [];
	let comparisonNewProgramBar: Array<{ label: string; value: number }> = [];
	let comparisonNewEmployerBar: Array<{ label: string; value: number }> = [];
	let totalProgramSeries: LineSeriesResult = {
		dates: [],
		series: [],
		xAxisLabel: 'Date'
	};
	let totalEmployerSeries: LineSeriesResult = {
		dates: [],
		series: [],
		xAxisLabel: 'Date'
	};
	let newProgramSeries: LineSeriesResult = {
		dates: [],
		series: [],
		xAxisLabel: 'Date'
	};
	let newEmployerSeries: LineSeriesResult = {
		dates: [],
		series: [],
		xAxisLabel: 'Date'
	};
	let comparisonTotalProgramSeries: LineSeriesResult = {
		dates: [],
		series: [],
		xAxisLabel: 'Date'
	};
	let comparisonTotalEmployerSeries: LineSeriesResult = {
		dates: [],
		series: [],
		xAxisLabel: 'Date'
	};
	let comparisonNewProgramSeries: LineSeriesResult = {
		dates: [],
		series: [],
		xAxisLabel: 'Date'
	};
	let comparisonNewEmployerSeries: LineSeriesResult = {
		dates: [],
		series: [],
		xAxisLabel: 'Date'
	};
	let table: Array<Record<string, string>> = [];
	let chips: FilterChip[] = [];
	let modalFilterLabels: string[] = [];
	let hasFilterData = false;
	let chartComparison = { ...DEFAULT_CHART_COMPARISON };
	let currentRangeLabel = '';
	let comparisonRangeLabel = '';

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

	$: if (!comparisonDisplayEnabled && Object.values(chartComparison).some(Boolean)) {
		resetChartComparisons();
	}

	$: {
		loadedRows;
		summary;
		comparisonSummary;
		comparisonLoadedRows;
		rangeStart;
		rangeEnd;
		comparisonEnabled;
		comparisonMode;
		comparisonStart;
		comparisonEnd;
		selectedPrograms;
		selectedEmployers;

			const currentStart = effectiveStartDate() ?? '';
			const currentEnd = effectiveEndDate() ?? '';
			currentRangeLabel = currentStart && currentEnd ? `${currentStart} to ${currentEnd}` : '';
			totalRows = totalEnrollmentRows(loadedRows, currentEnd);
			newRows = newEnrollmentRows(loadedRows, currentStart, currentEnd);
			const comparisonRange = resolvedComparisonRange();
			comparisonRangeLabel =
				comparisonEnabled && comparisonRange
					? `${comparisonRange.startDate} to ${comparisonRange.endDate}`
					: '';
			comparisonTotalRows =
				comparisonEnabled && comparisonRange
					? totalEnrollmentRows(comparisonLoadedRows, comparisonRange.endDate)
					: [];
			comparisonNewRows =
				comparisonEnabled && comparisonRange
					? newEnrollmentRows(comparisonLoadedRows, comparisonRange.startDate, comparisonRange.endDate)
					: [];
			totalProgramBar = buildBarData(totalRows, 'program');
			totalEmployerBar = buildBarData(totalRows, 'employer');
			newProgramBar = buildBarData(newRows, 'program');
			newEmployerBar = buildBarData(newRows, 'employer');
			comparisonTotalProgramBar = buildBarData(comparisonTotalRows, 'program');
			comparisonTotalEmployerBar = buildBarData(comparisonTotalRows, 'employer');
			comparisonNewProgramBar = buildBarData(comparisonNewRows, 'program');
			comparisonNewEmployerBar = buildBarData(comparisonNewRows, 'employer');
			totalProgramSeries = buildDateSeries(totalRows, 'program', 'selected-range-cumulative', {
				startDate: currentStart,
				endDate: currentEnd
			});
			totalEmployerSeries = buildDateSeries(totalRows, 'employer', 'selected-range-cumulative', {
				startDate: currentStart,
				endDate: currentEnd
			});
			newProgramSeries = buildDateSeries(newRows, 'program', 'selected-range', {
				startDate: currentStart,
				endDate: currentEnd
			});
			newEmployerSeries = buildDateSeries(newRows, 'employer', 'selected-range', {
				startDate: currentStart,
				endDate: currentEnd
			});
			comparisonTotalProgramSeries =
				comparisonEnabled && comparisonRange
					? buildDateSeries(
							comparisonTotalRows,
							'program',
							'selected-range-cumulative',
							comparisonRange
						)
					: { dates: [], series: [], xAxisLabel: 'Date' };
			comparisonTotalEmployerSeries =
				comparisonEnabled && comparisonRange
					? buildDateSeries(
							comparisonTotalRows,
							'employer',
							'selected-range-cumulative',
							comparisonRange
						)
					: { dates: [], series: [], xAxisLabel: 'Date' };
			comparisonNewProgramSeries =
				comparisonEnabled && comparisonRange
					? buildDateSeries(comparisonNewRows, 'program', 'selected-range', comparisonRange)
					: { dates: [], series: [], xAxisLabel: 'Date' };
			comparisonNewEmployerSeries =
				comparisonEnabled && comparisonRange
					? buildDateSeries(comparisonNewRows, 'employer', 'selected-range', comparisonRange)
					: { dates: [], series: [], xAxisLabel: 'Date' };
			table = tableRows();
			chips = activeFilterChips();
			modalFilterLabels = chips.map((chip) => chip.label);
			hasFilterData = loadedRows.length > 0;
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
			void cleanupSdEnrollmentsJob(jobId, true);
		}
		sessionJobIds.clear();
		jobIdByRangeKey.clear();
	});
</script>

<div class="space-y-4">
	<Card.Root>
		<Card.Header class="pb-3">
			<Card.Title class="text-base">Enrollment Filters</Card.Title>
		</Card.Header>
			<Card.Content class="space-y-4">
				<div class="grid gap-3 md:grid-cols-4">
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
						<label class="text-xs font-medium text-muted-foreground" for="comparisonToggle">Comparison</label>
						<Button
							id="comparisonToggle"
							type="button"
							variant={comparisonEnabled ? 'default' : 'outline'}
							class={comparisonEnabled
								? COMPARISON_ENABLED_BUTTON_CLASS
								: COMPARISON_DISABLED_BUTTON_CLASS}
							onclick={toggleComparison}
							disabled={loading}
						>
							{comparisonEnabled ? 'Disable Comparison' : 'Enable Comparison'}
						</Button>
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

				{#if !hasFilterData}
					<p class="text-sm text-muted-foreground">
						{summary
							? 'No rows were returned for this range, so there are no additional filters to apply.'
							: 'Run the report to load available Program and Employer filter values.'}
					</p>
				{/if}

				{#if hasFilterData}
					<div class="grid gap-3 md:grid-cols-4">
						<div class="space-y-1">
							<p class="text-xs font-medium text-muted-foreground">Program</p>
							<MultiSelectDropdown
								placeholder="All programs"
								options={programOptions.map((value) => ({ value, label: value }))}
								bind:selected={selectedPrograms}
								disabled={loading}
							/>
						</div>
						<div class="space-y-1">
							<p class="text-xs font-medium text-muted-foreground">Employer</p>
							<MultiSelectDropdown
								placeholder="All employers"
								options={employerOptions.map((value) => ({ value, label: value }))}
								bind:selected={selectedEmployers}
								disabled={loading}
							/>
						</div>
					</div>
					<ActiveFilterChips chips={chips} />
				{/if}

			<div class="flex flex-wrap items-center gap-2">
				<Button variant="destructive" class={RUN_BUTTON_CLASS} onclick={runReport} disabled={loading}>
					{loading ? 'Loading...' : 'Run'}
				</Button>
				<Button variant="outline" onclick={resetFilters} disabled={loading}>Reset Filters</Button>
				<Button
					variant="outline"
					class={EXPORT_BUTTON_CLASS}
					onclick={exportCsv}
					disabled={table.length === 0 || loading}
				>
					Export CSV
				</Button>
			</div>

			<LoadStatus {loading} {error} {progressText} />
		</Card.Content>
	</Card.Root>

	<div class="grid gap-4 xl:grid-cols-2">
		<div class="space-y-4">
			<KpiCard
				title="New Enrollments"
				value={newRows.length}
				comparisonEnabled={comparisonDisplayEnabled}
				comparisonValue={comparisonDisplayEnabled ? comparisonNewRows.length : null}
				comparisonTrend="higher_is_better"
			/>
			<Card.Root>
				<Card.Header class="flex flex-row items-center justify-between gap-2 pb-2">
					<Card.Title class="text-base">New Enrollments by Program</Card.Title>
					{#if comparisonDisplayEnabled}
						<Button
							size="sm"
							variant={chartComparison.newProgramBar ? 'default' : 'outline'}
							class={chartComparison.newProgramBar
								? CHART_COMPARE_ACTIVE_CLASS
								: CHART_COMPARE_INACTIVE_CLASS}
							onclick={() => toggleChartComparison('newProgramBar')}
						>
							{chartComparison.newProgramBar ? 'Comparing' : 'Compare'}
						</Button>
					{/if}
				</Card.Header>
				<Card.Content>
					<HorizontalBarChart
						items={newProgramBar}
						comparisonItems={comparisonNewProgramBar}
						showComparison={chartComparison.newProgramBar}
						currentRangeLabel={currentRangeLabel}
						comparisonRangeLabel={comparisonRangeLabel}
						xAxisLabel="Enrollments"
						yAxisLabel="Program"
						expandedTitle="New Enrollments by Program"
						activeFilters={modalFilterLabels}
					/>
				</Card.Content>
			</Card.Root>
			<Card.Root>
				<Card.Header class="flex flex-row items-center justify-between gap-2 pb-2">
					<Card.Title class="text-base">New Enrollments by Employer</Card.Title>
					{#if comparisonDisplayEnabled}
						<Button
							size="sm"
							variant={chartComparison.newEmployerBar ? 'default' : 'outline'}
							class={chartComparison.newEmployerBar
								? CHART_COMPARE_ACTIVE_CLASS
								: CHART_COMPARE_INACTIVE_CLASS}
							onclick={() => toggleChartComparison('newEmployerBar')}
						>
							{chartComparison.newEmployerBar ? 'Comparing' : 'Compare'}
						</Button>
					{/if}
				</Card.Header>
				<Card.Content>
					<HorizontalBarChart
						items={newEmployerBar}
						comparisonItems={comparisonNewEmployerBar}
						showComparison={chartComparison.newEmployerBar}
						currentRangeLabel={currentRangeLabel}
						comparisonRangeLabel={comparisonRangeLabel}
						xAxisLabel="Enrollments"
						yAxisLabel="Employer"
						expandedTitle="New Enrollments by Employer"
						activeFilters={modalFilterLabels}
					/>
				</Card.Content>
			</Card.Root>
			<Card.Root>
				<Card.Header class="flex flex-row items-center justify-between gap-2 pb-2">
					<Card.Title class="text-base">New Enrollments Trend by Program</Card.Title>
					{#if comparisonDisplayEnabled}
						<Button
							size="sm"
							variant={chartComparison.newProgramLine ? 'default' : 'outline'}
							class={chartComparison.newProgramLine
								? CHART_COMPARE_ACTIVE_CLASS
								: CHART_COMPARE_INACTIVE_CLASS}
							onclick={() => toggleChartComparison('newProgramLine')}
						>
							{chartComparison.newProgramLine ? 'Comparing' : 'Compare'}
						</Button>
					{/if}
				</Card.Header>
				<Card.Content>
					<MultiSeriesLineChart
						dates={newProgramSeries.dates}
						series={newProgramSeries.series}
						comparisonSeries={comparisonNewProgramSeries.series}
						showComparison={chartComparison.newProgramLine}
						currentRangeLabel={currentRangeLabel}
						comparisonRangeLabel={comparisonRangeLabel}
						yAxisLabel="Enrollments"
						xAxisLabel={newProgramSeries.xAxisLabel}
						expandedTitle="New Enrollments Trend by Program"
						activeFilters={modalFilterLabels}
					/>
				</Card.Content>
			</Card.Root>
			<Card.Root>
				<Card.Header class="flex flex-row items-center justify-between gap-2 pb-2">
					<Card.Title class="text-base">New Enrollments Trend by Employer</Card.Title>
					{#if comparisonDisplayEnabled}
						<Button
							size="sm"
							variant={chartComparison.newEmployerLine ? 'default' : 'outline'}
							class={chartComparison.newEmployerLine
								? CHART_COMPARE_ACTIVE_CLASS
								: CHART_COMPARE_INACTIVE_CLASS}
							onclick={() => toggleChartComparison('newEmployerLine')}
						>
							{chartComparison.newEmployerLine ? 'Comparing' : 'Compare'}
						</Button>
					{/if}
				</Card.Header>
				<Card.Content>
					<MultiSeriesLineChart
						dates={newEmployerSeries.dates}
						series={newEmployerSeries.series}
						comparisonSeries={comparisonNewEmployerSeries.series}
						showComparison={chartComparison.newEmployerLine}
						currentRangeLabel={currentRangeLabel}
						comparisonRangeLabel={comparisonRangeLabel}
						yAxisLabel="Enrollments"
						xAxisLabel={newEmployerSeries.xAxisLabel}
						expandedTitle="New Enrollments Trend by Employer"
						activeFilters={modalFilterLabels}
					/>
				</Card.Content>
			</Card.Root>
		</div>

		<div class="space-y-4">
			<KpiCard title="Total Enrollments" value={totalRows.length} />
			<Card.Root>
				<Card.Header class="flex flex-row items-center justify-between gap-2 pb-2">
					<Card.Title class="text-base">Total Enrollments by Program</Card.Title>
					{#if comparisonDisplayEnabled}
						<Button
							size="sm"
							variant={chartComparison.totalProgramBar ? 'default' : 'outline'}
							class={chartComparison.totalProgramBar
								? CHART_COMPARE_ACTIVE_CLASS
								: CHART_COMPARE_INACTIVE_CLASS}
							onclick={() => toggleChartComparison('totalProgramBar')}
						>
							{chartComparison.totalProgramBar ? 'Comparing' : 'Compare'}
						</Button>
					{/if}
				</Card.Header>
				<Card.Content>
					<HorizontalBarChart
						items={totalProgramBar}
						comparisonItems={comparisonTotalProgramBar}
						showComparison={chartComparison.totalProgramBar}
						currentRangeLabel={currentRangeLabel}
						comparisonRangeLabel={comparisonRangeLabel}
						xAxisLabel="Enrollments"
						yAxisLabel="Program"
						expandedTitle="Total Enrollments by Program"
						activeFilters={modalFilterLabels}
					/>
				</Card.Content>
			</Card.Root>
			<Card.Root>
				<Card.Header class="flex flex-row items-center justify-between gap-2 pb-2">
					<Card.Title class="text-base">Total Enrollments by Employer</Card.Title>
					{#if comparisonDisplayEnabled}
						<Button
							size="sm"
							variant={chartComparison.totalEmployerBar ? 'default' : 'outline'}
							class={chartComparison.totalEmployerBar
								? CHART_COMPARE_ACTIVE_CLASS
								: CHART_COMPARE_INACTIVE_CLASS}
							onclick={() => toggleChartComparison('totalEmployerBar')}
						>
							{chartComparison.totalEmployerBar ? 'Comparing' : 'Compare'}
						</Button>
					{/if}
				</Card.Header>
				<Card.Content>
					<HorizontalBarChart
						items={totalEmployerBar}
						comparisonItems={comparisonTotalEmployerBar}
						showComparison={chartComparison.totalEmployerBar}
						currentRangeLabel={currentRangeLabel}
						comparisonRangeLabel={comparisonRangeLabel}
						xAxisLabel="Enrollments"
						yAxisLabel="Employer"
						expandedTitle="Total Enrollments by Employer"
						activeFilters={modalFilterLabels}
					/>
				</Card.Content>
			</Card.Root>
			<Card.Root>
				<Card.Header class="flex flex-row items-center justify-between gap-2 pb-2">
					<Card.Title class="text-base">Total Enrollments Trend by Program</Card.Title>
					{#if comparisonDisplayEnabled}
						<Button
							size="sm"
							variant={chartComparison.totalProgramLine ? 'default' : 'outline'}
							class={chartComparison.totalProgramLine
								? CHART_COMPARE_ACTIVE_CLASS
								: CHART_COMPARE_INACTIVE_CLASS}
							onclick={() => toggleChartComparison('totalProgramLine')}
						>
							{chartComparison.totalProgramLine ? 'Comparing' : 'Compare'}
						</Button>
					{/if}
				</Card.Header>
				<Card.Content>
					<MultiSeriesLineChart
						dates={totalProgramSeries.dates}
						series={totalProgramSeries.series}
						comparisonSeries={comparisonTotalProgramSeries.series}
						showComparison={chartComparison.totalProgramLine}
						currentRangeLabel={currentRangeLabel}
						comparisonRangeLabel={comparisonRangeLabel}
						yAxisLabel="Enrollments"
						xAxisLabel={totalProgramSeries.xAxisLabel}
						expandedTitle="Total Enrollments Trend by Program"
						activeFilters={modalFilterLabels}
					/>
				</Card.Content>
			</Card.Root>
			<Card.Root>
				<Card.Header class="flex flex-row items-center justify-between gap-2 pb-2">
					<Card.Title class="text-base">Total Enrollments Trend by Employer</Card.Title>
					{#if comparisonDisplayEnabled}
						<Button
							size="sm"
							variant={chartComparison.totalEmployerLine ? 'default' : 'outline'}
							class={chartComparison.totalEmployerLine
								? CHART_COMPARE_ACTIVE_CLASS
								: CHART_COMPARE_INACTIVE_CLASS}
							onclick={() => toggleChartComparison('totalEmployerLine')}
						>
							{chartComparison.totalEmployerLine ? 'Comparing' : 'Compare'}
						</Button>
					{/if}
				</Card.Header>
				<Card.Content>
					<MultiSeriesLineChart
						dates={totalEmployerSeries.dates}
						series={totalEmployerSeries.series}
						comparisonSeries={comparisonTotalEmployerSeries.series}
						showComparison={chartComparison.totalEmployerLine}
						currentRangeLabel={currentRangeLabel}
						comparisonRangeLabel={comparisonRangeLabel}
						yAxisLabel="Enrollments"
						xAxisLabel={totalEmployerSeries.xAxisLabel}
						expandedTitle="Total Enrollments Trend by Employer"
						activeFilters={modalFilterLabels}
					/>
				</Card.Content>
			</Card.Root>
		</div>
	</div>

	<TablePanel
		title="Enrollment Detail"
		columns={TABLE_COLUMNS}
		rows={table}
		footerText={summary ? `Generated at ${new Date(summary.generatedAt).toLocaleString()}` : 'No rows available.'}
		pageSize={20}
	/>
</div>
