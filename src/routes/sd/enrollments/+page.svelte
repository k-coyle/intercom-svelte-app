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

	type LineSeriesResult = {
		dates: string[];
		series: Array<{ name: string; values: number[] }>;
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
		mode: 'selected-range' | 'from-first-enrollment'
	): LineSeriesResult {
		const endUnixExclusive = toUnixEndExclusive(effectiveEndDate() ?? '');
		if (endUnixExclusive == null) return { dates: [], series: [], xAxisLabel: 'Date' };

		let startUnix: number | null = null;
		if (mode === 'selected-range') {
			startUnix = toUnixStart(effectiveStartDate() ?? '');
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
			if (row.enrollmentAt == null || row.enrollmentAt < startUnix || row.enrollmentAt >= endUnixExclusive) {
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

		const topKeys = [...totals.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 5)
			.map(([key]) => key);
		const otherKey = topKeys.length < totals.size ? 'Other' : null;
		const seriesMap = new Map<string, number[]>();
		for (const key of topKeys) {
			seriesMap.set(key, labels.map(() => 0));
		}
		if (otherKey) seriesMap.set(otherKey, labels.map(() => 0));

		for (const row of rows) {
			if (row.enrollmentAt == null || row.enrollmentAt < startUnix || row.enrollmentAt >= endUnixExclusive) {
				continue;
			}
			const bucketUnix = bucketStartUnix(row.enrollmentAt, granularity);
			const bucketIndex = indexByBucket.get(bucketUnix);
			if (bucketIndex == null) continue;

			const keys =
				dimension === 'program'
					? row.programs?.length
						? row.programs
						: ['Unspecified']
					: [row.employer?.trim() || 'Unspecified'];

			for (const key of keys) {
				if (seriesMap.has(key)) {
					seriesMap.get(key)![bucketIndex] += 1;
				} else if (otherKey) {
					seriesMap.get(otherKey)![bucketIndex] += 1;
				}
			}
		}

		return {
			dates: labels,
			series: [...seriesMap.entries()].map(([name, values]) => ({ name, values })),
			xAxisLabel: 'Date'
		};
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
				const [loadedSummary, rows] = await Promise.all([
					fetchSdEnrollmentsView<EnrollmentSummary>(
						cachedJobId,
						'summary',
						undefined,
						undefined,
						controller.signal
					),
					fetchAllSdEnrollmentsRows<EnrollmentRow>({
						jobId: cachedJobId,
						limit: 1000,
						signal: controller.signal,
						onPage: ({ loaded, total }) => {
							progressText = `${tag} | loading cached enrollment rows ${loaded}${total != null ? ` / ${total}` : ''}...`;
						}
					})
				]);
				return { summary: loadedSummary, rows };
			} catch (err) {
				if (!isJobNotFoundError(err)) throw err;
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
		const [loadedSummary, rows] = await Promise.all([
			fetchSdEnrollmentsView<EnrollmentSummary>(jobId, 'summary', undefined, undefined, controller.signal),
			fetchAllSdEnrollmentsRows<EnrollmentRow>({
				jobId,
				limit: 1000,
				signal: controller.signal,
				onPage: ({ loaded, total }) => {
					progressText = `${tag} | loading enrollment rows ${loaded}${total != null ? ` / ${total}` : ''}...`;
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
		progressText = 'Starting enrollments job...';
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
	let comparisonNewRows: EnrollmentRow[] = [];
	let totalProgramBar: Array<{ label: string; value: number }> = [];
	let totalEmployerBar: Array<{ label: string; value: number }> = [];
	let newProgramBar: Array<{ label: string; value: number }> = [];
	let newEmployerBar: Array<{ label: string; value: number }> = [];
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
	let table: Array<Record<string, string>> = [];
	let chips: FilterChip[] = [];
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
		totalRows = totalEnrollmentRows(loadedRows, currentEnd);
		newRows = newEnrollmentRows(loadedRows, currentStart, currentEnd);
		const comparisonRange = resolvedComparisonRange();
		comparisonNewRows =
			comparisonEnabled && comparisonRange
				? newEnrollmentRows(comparisonLoadedRows, comparisonRange.startDate, comparisonRange.endDate)
				: [];
		totalProgramBar = buildBarData(totalRows, 'program');
		totalEmployerBar = buildBarData(totalRows, 'employer');
		newProgramBar = buildBarData(newRows, 'program');
		newEmployerBar = buildBarData(newRows, 'employer');
		totalProgramSeries = buildDateSeries(totalRows, 'program', 'from-first-enrollment');
		totalEmployerSeries = buildDateSeries(totalRows, 'employer', 'from-first-enrollment');
		newProgramSeries = buildDateSeries(newRows, 'program', 'selected-range');
		newEmployerSeries = buildDateSeries(newRows, 'employer', 'selected-range');
		table = tableRows();
		chips = activeFilterChips();
		modalFilterLabels = chips.map((chip) => chip.label);
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

			<ActiveFilterChips chips={chips} />

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
			<KpiCard title="Total Enrollments" value={totalRows.length} />
			<Card.Root>
				<Card.Header class="pb-2">
					<Card.Title class="text-base">Total Enrollments by Program</Card.Title>
				</Card.Header>
				<Card.Content>
					<HorizontalBarChart
						items={totalProgramBar}
						xAxisLabel="Enrollments"
						yAxisLabel="Program"
						expandedTitle="Total Enrollments by Program"
						activeFilters={modalFilterLabels}
					/>
				</Card.Content>
			</Card.Root>
			<Card.Root>
				<Card.Header class="pb-2">
					<Card.Title class="text-base">Total Enrollments by Employer</Card.Title>
				</Card.Header>
				<Card.Content>
					<HorizontalBarChart
						items={totalEmployerBar}
						xAxisLabel="Enrollments"
						yAxisLabel="Employer"
						expandedTitle="Total Enrollments by Employer"
						activeFilters={modalFilterLabels}
					/>
				</Card.Content>
			</Card.Root>
			<Card.Root>
				<Card.Header class="pb-2">
					<Card.Title class="text-base">Total Enrollments Trend by Program</Card.Title>
				</Card.Header>
				<Card.Content>
					<MultiSeriesLineChart
						dates={totalProgramSeries.dates}
						series={totalProgramSeries.series}
						yAxisLabel="Enrollments"
						xAxisLabel={totalProgramSeries.xAxisLabel}
						expandedTitle="Total Enrollments Trend by Program"
						activeFilters={modalFilterLabels}
					/>
				</Card.Content>
			</Card.Root>
			<Card.Root>
				<Card.Header class="pb-2">
					<Card.Title class="text-base">Total Enrollments Trend by Employer</Card.Title>
				</Card.Header>
				<Card.Content>
					<MultiSeriesLineChart
						dates={totalEmployerSeries.dates}
						series={totalEmployerSeries.series}
						yAxisLabel="Enrollments"
						xAxisLabel={totalEmployerSeries.xAxisLabel}
						expandedTitle="Total Enrollments Trend by Employer"
						activeFilters={modalFilterLabels}
					/>
				</Card.Content>
			</Card.Root>
		</div>

		<div class="space-y-4">
			<KpiCard
				title="New Enrollments"
				value={newRows.length}
				comparisonEnabled={comparisonDisplayEnabled}
				comparisonValue={comparisonDisplayEnabled ? comparisonNewRows.length : null}
				comparisonTrend="higher_is_better"
			/>
			<Card.Root>
				<Card.Header class="pb-2">
					<Card.Title class="text-base">New Enrollments by Program</Card.Title>
				</Card.Header>
				<Card.Content>
					<HorizontalBarChart
						items={newProgramBar}
						xAxisLabel="Enrollments"
						yAxisLabel="Program"
						expandedTitle="New Enrollments by Program"
						activeFilters={modalFilterLabels}
					/>
				</Card.Content>
			</Card.Root>
			<Card.Root>
				<Card.Header class="pb-2">
					<Card.Title class="text-base">New Enrollments by Employer</Card.Title>
				</Card.Header>
				<Card.Content>
					<HorizontalBarChart
						items={newEmployerBar}
						xAxisLabel="Enrollments"
						yAxisLabel="Employer"
						expandedTitle="New Enrollments by Employer"
						activeFilters={modalFilterLabels}
					/>
				</Card.Content>
			</Card.Root>
			<Card.Root>
				<Card.Header class="pb-2">
					<Card.Title class="text-base">New Enrollments Trend by Program</Card.Title>
				</Card.Header>
				<Card.Content>
					<MultiSeriesLineChart
						dates={newProgramSeries.dates}
						series={newProgramSeries.series}
						yAxisLabel="Enrollments"
						xAxisLabel={newProgramSeries.xAxisLabel}
						expandedTitle="New Enrollments Trend by Program"
						activeFilters={modalFilterLabels}
					/>
				</Card.Content>
			</Card.Root>
			<Card.Root>
				<Card.Header class="pb-2">
					<Card.Title class="text-base">New Enrollments Trend by Employer</Card.Title>
				</Card.Header>
				<Card.Content>
					<MultiSeriesLineChart
						dates={newEmployerSeries.dates}
						series={newEmployerSeries.series}
						yAxisLabel="Enrollments"
						xAxisLabel={newEmployerSeries.xAxisLabel}
						expandedTitle="New Enrollments Trend by Employer"
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
