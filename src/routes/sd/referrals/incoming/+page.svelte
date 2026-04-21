<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import LoadStatus from '$lib/components/report/LoadStatus.svelte';
	import PieBreakdownChart from '$lib/components/report/PieBreakdownChart.svelte';
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
		cleanupSdIncomingReferralsJob,
		fetchAllSdIncomingReferralsRows,
		fetchSdIncomingReferralsView,
		runSdIncomingReferralsJobUntilComplete
	} from '$lib/client/sd-referrals-incoming-job';
	import {
		SD_BLANK_FILTER_LABELS,
		SD_FILTER_DEFAULT_OPTIONS,
		type ComparisonRangeMode,
		exportRowsAsCsv,
		isoDateDaysAgo,
		matchesSelectedFilter,
		matchesSelectedListFilter,
		mergeFilterOptions,
		normalizeFilterValue,
		previousPeriodRange,
		retainSelectedFilterValues,
		todayIsoDate,
		valuesOrBlank
	} from '$lib/client/sd-report-utils';
	import {
		buildBreakdown,
		buildEventDateSeries,
		type LineSeriesResult
	} from '$lib/client/sd-event-report-utils';
	import type { TableColumn } from '$lib/components/report/engagementReportConfig';

	type Row = {
		memberId: string;
		memberName: string | null;
		memberEmail: string | null;
		employer: string | null;
		programs: string[];
		referralSource: string | null;
		referralReason: string | null;
		referralAt: number | null;
		referralDate: string | null;
	};
	type Summary = { generatedAt: string; startDate: string; endDate: string; totalRows: number; dateBounds: { minReferralDate: string | null; maxReferralDate: string | null } };
	type FilterChip = { key: string; label: string; onRemove: () => void };
	type CompareKey = 'sourceBreakdown' | 'reasonBreakdown' | 'sourceTrend' | 'reasonTrend';

	export let data: { sandboxModeOffline?: boolean };

	const TABLE_COLUMNS: TableColumn[] = [
		{ key: 'member', header: 'Member' },
		{ key: 'employer', header: 'Employer' },
		{ key: 'programs', header: 'Programs' },
		{ key: 'referralSource', header: 'Referral Source' },
		{ key: 'referralReason', header: 'Referral Reason' },
		{ key: 'referralDate', header: 'Referral Date' }
	];
	const RUN_BUTTON_CLASS = 'bg-red-700 text-white hover:bg-red-600 border-red-700';
	const EXPORT_BUTTON_CLASS = 'border-green-700 text-green-700 hover:bg-green-50';
	const COMPARISON_ENABLED_BUTTON_CLASS = 'w-full bg-blue-900 text-white hover:bg-blue-800 border-blue-900';
	const COMPARISON_DISABLED_BUTTON_CLASS = 'w-full border-blue-300 text-blue-900 hover:bg-blue-50';
	const CHART_COMPARE_ACTIVE_CLASS = 'border-slate-900 bg-slate-900 text-white hover:bg-slate-800';
	const CHART_COMPARE_INACTIVE_CLASS = 'border-slate-300 text-slate-700 hover:bg-slate-50';

	let rangeStart = '';
	let rangeEnd = '';
	let sandboxDateMin = '';
	let sandboxDateMax = '';
	let comparisonEnabled = false;
	let comparisonMode: ComparisonRangeMode = 'previous';
	let comparisonStart = '';
	let comparisonEnd = '';
	let selectedPrograms: string[] = [];
	let selectedEmployers: string[] = [];
	let selectedSources: string[] = [];
	let selectedReasons: string[] = [];
	let chartComparison: Record<CompareKey, boolean> = { sourceBreakdown: false, reasonBreakdown: false, sourceTrend: false, reasonTrend: false };
	let summary: Summary | null = null;
	let loadedRows: Row[] = [];
	let comparisonLoadedRows: Row[] = [];
	let comparisonDisplayEnabled = false;
	let comparisonSignature = '';
	let loading = false;
	let error: string | null = null;
	let progressText: string | null = null;
	let controller: AbortController | null = null;
	const sessionJobIds = new Set<string>();
	const jobIdByRangeKey = new Map<string, string>();
	let programOptions: string[] = [];
	let employerOptions: string[] = [];
	let sourceOptions: string[] = [];
	let reasonOptions: string[] = [];
	let filteredRows: Row[] = [];
	let comparisonRows: Row[] = [];
	let chips: FilterChip[] = [];
	let modalFilterLabels: string[] = [];
	let table: Array<Record<string, string>> = [];
	let currentRangeLabel = '';
	let comparisonRangeLabel = '';
	let sourceTrendData: LineSeriesResult = { dates: [], series: [], xAxisLabel: 'Date' };
	let reasonTrendData: LineSeriesResult = { dates: [], series: [], xAxisLabel: 'Date' };
	let comparisonSourceTrendData: LineSeriesResult = { dates: [], series: [], xAxisLabel: 'Date' };
	let comparisonReasonTrendData: LineSeriesResult = { dates: [], series: [], xAxisLabel: 'Date' };

	function programLabels(row: Row): string[] { return valuesOrBlank(row.programs).map((value) => normalizeFilterValue(value, { blankLabel: SD_BLANK_FILTER_LABELS.program })); }
	function employerLabel(row: Row): string { return normalizeFilterValue(row.employer, { blankLabel: SD_BLANK_FILTER_LABELS.employer }); }
	function sourceLabel(row: Row): string { return normalizeFilterValue(row.referralSource, { blankLabel: SD_BLANK_FILTER_LABELS.referralSource }); }
	function reasonLabel(row: Row): string { return normalizeFilterValue(row.referralReason, { blankLabel: SD_BLANK_FILTER_LABELS.referralReason }); }
	function resetChartComparisons() { chartComparison = { sourceBreakdown: false, reasonBreakdown: false, sourceTrend: false, reasonTrend: false }; }
	function inRange(value: number | null, start: string, end: string): boolean { const s = Date.parse(`${start}T00:00:00Z`); const e = Date.parse(`${end}T00:00:00Z`); if (!Number.isFinite(s) || !Number.isFinite(e) || value == null) return false; const unix = Math.floor(s / 1000); const endUnix = Math.floor(e / 1000) + 86400; return value >= unix && value < endUnix; }
	function currentRange() { return rangeStart && rangeEnd ? { startDate: rangeStart, endDate: rangeEnd } : null; }
	function resolvedComparisonRange() { if (!comparisonEnabled) return null; return comparisonMode === 'previous' ? (currentRange() ? previousPeriodRange(rangeStart, rangeEnd) : null) : (comparisonStart && comparisonEnd ? { startDate: comparisonStart, endDate: comparisonEnd } : null); }
	function rangeKey(startDate: string, endDate: string) { return `${startDate}|${endDate}`; }
	function refreshFilterOptions() { programOptions = mergeFilterOptions(SD_FILTER_DEFAULT_OPTIONS.programs, loadedRows.flatMap((row) => valuesOrBlank(row.programs)), { blankLabel: SD_BLANK_FILTER_LABELS.program }); employerOptions = mergeFilterOptions(SD_FILTER_DEFAULT_OPTIONS.employers, loadedRows.map((row) => row.employer), { blankLabel: SD_BLANK_FILTER_LABELS.employer }); sourceOptions = mergeFilterOptions(SD_FILTER_DEFAULT_OPTIONS.referralSources, loadedRows.map((row) => row.referralSource), { blankLabel: SD_BLANK_FILTER_LABELS.referralSource }); reasonOptions = mergeFilterOptions(SD_FILTER_DEFAULT_OPTIONS.referralReasons, loadedRows.map((row) => row.referralReason), { blankLabel: SD_BLANK_FILTER_LABELS.referralReason }); selectedPrograms = retainSelectedFilterValues(selectedPrograms, programOptions); selectedEmployers = retainSelectedFilterValues(selectedEmployers, employerOptions); selectedSources = retainSelectedFilterValues(selectedSources, sourceOptions); selectedReasons = retainSelectedFilterValues(selectedReasons, reasonOptions); }
	function passesFilters(row: Row) { const programsOk = matchesSelectedListFilter(selectedPrograms, row.programs, { blankLabel: SD_BLANK_FILTER_LABELS.program }); const employersOk = matchesSelectedFilter(selectedEmployers, row.employer, { blankLabel: SD_BLANK_FILTER_LABELS.employer }); const sourcesOk = matchesSelectedFilter(selectedSources, row.referralSource, { blankLabel: SD_BLANK_FILTER_LABELS.referralSource }); const reasonsOk = matchesSelectedFilter(selectedReasons, row.referralReason, { blankLabel: SD_BLANK_FILTER_LABELS.referralReason }); return programsOk && employersOk && sourcesOk && reasonsOk; }
	function toggleComparison() { comparisonEnabled = !comparisonEnabled; if (comparisonEnabled && comparisonMode === 'previous' && rangeStart && rangeEnd) { const previous = previousPeriodRange(rangeStart, rangeEnd); comparisonStart = previous?.startDate ?? ''; comparisonEnd = previous?.endDate ?? ''; } }
	function resetFilters() { comparisonEnabled = false; comparisonMode = 'previous'; comparisonStart = ''; comparisonEnd = ''; selectedPrograms = []; selectedEmployers = []; selectedSources = []; selectedReasons = []; resetChartComparisons(); }
	function activeFilterChips(): FilterChip[] { const next: FilterChip[] = []; if (rangeStart || rangeEnd) next.push({ key: 'date', label: `Date: ${rangeStart || '...'} to ${rangeEnd || '...'}`, onRemove: () => { rangeStart = ''; rangeEnd = ''; } }); if (comparisonEnabled) next.push({ key: 'comparison', label: comparisonMode === 'previous' ? `Comparison: ${resolvedComparisonRange()?.startDate ?? '...'} to ${resolvedComparisonRange()?.endDate ?? '...'}` : `Comparison: ${comparisonStart || '...'} to ${comparisonEnd || '...'}`, onRemove: () => { comparisonEnabled = false; comparisonStart = ''; comparisonEnd = ''; } }); for (const value of selectedPrograms) next.push({ key: `program-${value}`, label: `Program: ${value}`, onRemove: () => selectedPrograms = selectedPrograms.filter((entry) => entry !== value) }); for (const value of selectedEmployers) next.push({ key: `employer-${value}`, label: `Employer: ${value}`, onRemove: () => selectedEmployers = selectedEmployers.filter((entry) => entry !== value) }); for (const value of selectedSources) next.push({ key: `source-${value}`, label: `Referral Source: ${value}`, onRemove: () => selectedSources = selectedSources.filter((entry) => entry !== value) }); for (const value of selectedReasons) next.push({ key: `reason-${value}`, label: `Referral Reason: ${value}`, onRemove: () => selectedReasons = selectedReasons.filter((entry) => entry !== value) }); return next; }
	function exportCsv() { exportRowsAsCsv({ filenamePrefix: 'sd_incoming_referrals', headers: ['Member', 'Employer', 'Programs', 'Referral Source', 'Referral Reason', 'Referral Date'], rows: table.map((row) => [row.member, row.employer, row.programs, row.referralSource, row.referralReason, row.referralDate]) }); }

	async function loadRange(startDate: string, endDate: string): Promise<{ jobId: string; summary: Summary; rows: Row[] }> {
		const key = rangeKey(startDate, endDate);
		const signal = controller?.signal;
		const cachedJobId = jobIdByRangeKey.get(key);
		if (cachedJobId) {
			try {
				return { jobId: cachedJobId, summary: await fetchSdIncomingReferralsView<Summary>(cachedJobId, 'summary', undefined, undefined, signal, { retryLimit: 1 }), rows: await fetchAllSdIncomingReferralsRows<Row>({ jobId: cachedJobId, signal, retry: { retryLimit: 1 } }) };
			} catch (err: any) {
				if (!String(err?.message ?? '').toLowerCase().includes('job not found')) throw err;
				jobIdByRangeKey.delete(key);
			}
		}
		const { jobId } = await runSdIncomingReferralsJobUntilComplete({ startDate, endDate, signal, stepDelayMs: 150, onJobCreated: (id) => { sessionJobIds.add(id); jobIdByRangeKey.set(key, id); }, onProgress: (progress) => { progressText = `Loaded ${progress?.progress?.dedupedContacts ?? 0} incoming referrals`; } });
		return { jobId, summary: await fetchSdIncomingReferralsView<Summary>(jobId, 'summary', undefined, undefined, signal, { retryLimit: 2 }), rows: await fetchAllSdIncomingReferralsRows<Row>({ jobId, signal, retry: { retryLimit: 2 } }) };
	}

	async function runReport() {
		if (!rangeStart || !rangeEnd) { error = 'Select a reporting start and end date.'; return; }
		if (comparisonEnabled && !resolvedComparisonRange()) { error = 'Select a valid comparison date range.'; return; }
		controller?.abort(); controller = new AbortController(); loading = true; error = null; progressText = 'Starting incoming referrals report...'; comparisonDisplayEnabled = false; resetChartComparisons();
		try {
			const primary = await loadRange(rangeStart, rangeEnd); summary = primary.summary; loadedRows = primary.rows; refreshFilterOptions();
			if (data?.sandboxModeOffline) { sandboxDateMin = primary.summary.dateBounds.minReferralDate ?? primary.summary.startDate; sandboxDateMax = primary.summary.dateBounds.maxReferralDate ?? primary.summary.endDate; }
			const comparison = resolvedComparisonRange();
				if (comparisonEnabled && comparison) { const comparisonResult = await loadRange(comparison.startDate, comparison.endDate); comparisonLoadedRows = comparisonResult.rows; comparisonDisplayEnabled = true; }
			else { comparisonLoadedRows = []; }
			progressText = null;
		} catch (err: any) { if (err?.name !== 'AbortError') error = err?.message ?? 'Failed to load incoming referrals.'; } finally { loading = false; }
	}

	$: {
		const nextSignature = comparisonEnabled ? `${comparisonMode}|${comparisonStart}|${comparisonEnd}|${rangeStart}|${rangeEnd}` : 'disabled';
			if (nextSignature !== comparisonSignature) { comparisonSignature = nextSignature; comparisonDisplayEnabled = false; resetChartComparisons(); if (comparisonEnabled && comparisonMode === 'previous' && rangeStart && rangeEnd) { const previous = previousPeriodRange(rangeStart, rangeEnd); comparisonStart = previous?.startDate ?? ''; comparisonEnd = previous?.endDate ?? ''; } }
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
		selectedSources;
		selectedReasons;

		const range = currentRange(); const comparison = resolvedComparisonRange(); currentRangeLabel = range ? `${range.startDate} to ${range.endDate}` : ''; comparisonRangeLabel = comparisonEnabled && comparison ? `${comparison.startDate} to ${comparison.endDate}` : ''; filteredRows = range ? loadedRows.filter((row) => passesFilters(row) && inRange(row.referralAt, range.startDate, range.endDate)) : []; comparisonRows = comparison ? comparisonLoadedRows.filter((row) => passesFilters(row) && inRange(row.referralAt, comparison.startDate, comparison.endDate)) : []; chips = loadedRows.length > 0 ? activeFilterChips() : []; modalFilterLabels = chips.map((chip) => chip.label); table = filteredRows.map((row) => ({ member: row.memberName ?? row.memberEmail ?? row.memberId, employer: employerLabel(row), programs: programLabels(row).join(', '), referralSource: sourceLabel(row), referralReason: reasonLabel(row), referralDate: row.referralDate ?? '-' })); sourceTrendData = range ? buildEventDateSeries(filteredRows, (row) => row.referralAt, (row) => [sourceLabel(row)], range) : { dates: [], series: [], xAxisLabel: 'Date' }; reasonTrendData = range ? buildEventDateSeries(filteredRows, (row) => row.referralAt, (row) => [reasonLabel(row)], range) : { dates: [], series: [], xAxisLabel: 'Date' }; comparisonSourceTrendData = comparison ? buildEventDateSeries(comparisonRows, (row) => row.referralAt, (row) => [sourceLabel(row)], comparison) : { dates: [], series: [], xAxisLabel: 'Date' }; comparisonReasonTrendData = comparison ? buildEventDateSeries(comparisonRows, (row) => row.referralAt, (row) => [reasonLabel(row)], comparison) : { dates: [], series: [], xAxisLabel: 'Date' };
	}

	onMount(() => { controller = new AbortController(); if (data?.sandboxModeOffline) { rangeStart = isoDateDaysAgo(30); rangeEnd = todayIsoDate(); void runReport(); } });
	onDestroy(() => { controller?.abort(); for (const jobId of sessionJobIds) void cleanupSdIncomingReferralsJob(jobId, true); sessionJobIds.clear(); jobIdByRangeKey.clear(); });
</script>

<div class="space-y-4">
	<Card.Root>
		<Card.Header class="pb-3"><Card.Title class="text-base">Incoming Referral Filters</Card.Title></Card.Header>
		<Card.Content class="space-y-4">
			<div class="grid gap-3 md:grid-cols-4">
				<div class="space-y-1"><label class="text-xs font-medium text-muted-foreground" for="rangeStart">Reporting Start</label><Input id="rangeStart" type="date" bind:value={rangeStart} min={data?.sandboxModeOffline ? sandboxDateMin : undefined} max={data?.sandboxModeOffline ? sandboxDateMax : undefined} /></div>
				<div class="space-y-1"><label class="text-xs font-medium text-muted-foreground" for="rangeEnd">Reporting End</label><Input id="rangeEnd" type="date" bind:value={rangeEnd} min={data?.sandboxModeOffline ? sandboxDateMin : undefined} max={data?.sandboxModeOffline ? sandboxDateMax : undefined} /></div>
				<div class="space-y-1"><label class="text-xs font-medium text-muted-foreground" for="comparisonToggle">Comparison</label><Button id="comparisonToggle" type="button" variant={comparisonEnabled ? 'default' : 'outline'} class={comparisonEnabled ? COMPARISON_ENABLED_BUTTON_CLASS : COMPARISON_DISABLED_BUTTON_CLASS} onclick={toggleComparison} disabled={loading}>{comparisonEnabled ? 'Disable Comparison' : 'Enable Comparison'}</Button></div>
				{#if comparisonEnabled}
					<div class="space-y-1"><label class="text-xs font-medium text-muted-foreground" for="comparisonMode">Comparison Type</label><select id="comparisonMode" class="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" bind:value={comparisonMode} disabled={loading}><option value="previous">Previous Period</option><option value="custom">Custom Range</option></select></div>
					<div class="space-y-1"><label class="text-xs font-medium text-muted-foreground" for="comparisonStart">Comparison Start</label><Input id="comparisonStart" type="date" bind:value={comparisonStart} disabled={loading} /></div>
					<div class="space-y-1"><label class="text-xs font-medium text-muted-foreground" for="comparisonEnd">Comparison End</label><Input id="comparisonEnd" type="date" bind:value={comparisonEnd} disabled={loading} /></div>
				{/if}
			</div>

			{#if loadedRows.length === 0}
				<p class="text-sm text-muted-foreground">{summary ? 'No rows were returned for this range, so there are no additional filters to apply.' : 'Run the report to load available Program, Employer, Referral Source, and Referral Reason filter values.'}</p>
			{:else}
				<div class="grid gap-3 md:grid-cols-4">
					<div class="space-y-1"><p class="text-xs font-medium text-muted-foreground">Program</p><MultiSelectDropdown placeholder="All programs" options={programOptions.map((value) => ({ value, label: value }))} bind:selected={selectedPrograms} disabled={loading} /></div>
					<div class="space-y-1"><p class="text-xs font-medium text-muted-foreground">Employer</p><MultiSelectDropdown placeholder="All employers" options={employerOptions.map((value) => ({ value, label: value }))} bind:selected={selectedEmployers} disabled={loading} /></div>
					<div class="space-y-1"><p class="text-xs font-medium text-muted-foreground">Referral Source</p><MultiSelectDropdown placeholder="All sources" options={sourceOptions.map((value) => ({ value, label: value }))} bind:selected={selectedSources} disabled={loading} /></div>
					<div class="space-y-1"><p class="text-xs font-medium text-muted-foreground">Referral Reason</p><MultiSelectDropdown placeholder="All reasons" options={reasonOptions.map((value) => ({ value, label: value }))} bind:selected={selectedReasons} disabled={loading} /></div>
				</div>
				<ActiveFilterChips chips={chips} />
			{/if}

			<div class="flex flex-wrap items-center gap-2"><Button variant="destructive" class={RUN_BUTTON_CLASS} onclick={runReport} disabled={loading}>{loading ? 'Loading...' : 'Run'}</Button><Button variant="outline" onclick={resetFilters} disabled={loading}>Reset Filters</Button><Button variant="outline" class={EXPORT_BUTTON_CLASS} onclick={exportCsv} disabled={table.length === 0 || loading}>Export CSV</Button></div>
			<LoadStatus {loading} {error} {progressText} />
		</Card.Content>
	</Card.Root>

	<div class="grid gap-4 md:grid-cols-2">
		<KpiCard title="Total Incoming Referrals" value={filteredRows.length} comparisonEnabled={comparisonDisplayEnabled} comparisonValue={comparisonDisplayEnabled ? comparisonRows.length : null} comparisonTrend="higher_is_better" />
		<KpiCard title="Unique Referred Members" value={new Set(filteredRows.map((row) => row.memberId)).size} comparisonEnabled={comparisonDisplayEnabled} comparisonValue={comparisonDisplayEnabled ? new Set(comparisonRows.map((row) => row.memberId)).size : null} comparisonTrend="higher_is_better" />
	</div>

	<div class="grid gap-4 xl:grid-cols-2">
		<Card.Root>
			<Card.Header class="flex flex-row items-center justify-between gap-2 pb-2"><Card.Title class="text-base">Incoming Referrals by Source</Card.Title>{#if comparisonDisplayEnabled}<Button size="sm" variant={chartComparison.sourceBreakdown ? 'default' : 'outline'} class={chartComparison.sourceBreakdown ? CHART_COMPARE_ACTIVE_CLASS : CHART_COMPARE_INACTIVE_CLASS} onclick={() => chartComparison = { ...chartComparison, sourceBreakdown: !chartComparison.sourceBreakdown }}>{chartComparison.sourceBreakdown ? 'Comparing' : 'Compare'}</Button>{/if}</Card.Header>
			<Card.Content>{#if chartComparison.sourceBreakdown}<HorizontalBarChart items={buildBreakdown(filteredRows, (row) => [sourceLabel(row)])} comparisonItems={buildBreakdown(comparisonRows, (row) => [sourceLabel(row)])} showComparison={true} currentRangeLabel={currentRangeLabel} comparisonRangeLabel={comparisonRangeLabel} xAxisLabel="Referrals" yAxisLabel="Referral Source" expandedTitle="Incoming Referrals by Source" activeFilters={modalFilterLabels} />{:else}<PieBreakdownChart items={buildBreakdown(filteredRows, (row) => [sourceLabel(row)])} expandedTitle="Incoming Referrals by Source" activeFilters={modalFilterLabels} />{/if}</Card.Content>
		</Card.Root>
		<Card.Root>
			<Card.Header class="flex flex-row items-center justify-between gap-2 pb-2"><Card.Title class="text-base">Incoming Referrals by Reason</Card.Title>{#if comparisonDisplayEnabled}<Button size="sm" variant={chartComparison.reasonBreakdown ? 'default' : 'outline'} class={chartComparison.reasonBreakdown ? CHART_COMPARE_ACTIVE_CLASS : CHART_COMPARE_INACTIVE_CLASS} onclick={() => chartComparison = { ...chartComparison, reasonBreakdown: !chartComparison.reasonBreakdown }}>{chartComparison.reasonBreakdown ? 'Comparing' : 'Compare'}</Button>{/if}</Card.Header>
			<Card.Content>{#if chartComparison.reasonBreakdown}<HorizontalBarChart items={buildBreakdown(filteredRows, (row) => [reasonLabel(row)])} comparisonItems={buildBreakdown(comparisonRows, (row) => [reasonLabel(row)])} showComparison={true} currentRangeLabel={currentRangeLabel} comparisonRangeLabel={comparisonRangeLabel} xAxisLabel="Referrals" yAxisLabel="Referral Reason" expandedTitle="Incoming Referrals by Reason" activeFilters={modalFilterLabels} />{:else}<PieBreakdownChart items={buildBreakdown(filteredRows, (row) => [reasonLabel(row)])} expandedTitle="Incoming Referrals by Reason" activeFilters={modalFilterLabels} />{/if}</Card.Content>
		</Card.Root>
		<Card.Root>
			<Card.Header class="flex flex-row items-center justify-between gap-2 pb-2"><Card.Title class="text-base">Incoming Referral Trend by Source</Card.Title>{#if comparisonDisplayEnabled}<Button size="sm" variant={chartComparison.sourceTrend ? 'default' : 'outline'} class={chartComparison.sourceTrend ? CHART_COMPARE_ACTIVE_CLASS : CHART_COMPARE_INACTIVE_CLASS} onclick={() => chartComparison = { ...chartComparison, sourceTrend: !chartComparison.sourceTrend }}>{chartComparison.sourceTrend ? 'Comparing' : 'Compare'}</Button>{/if}</Card.Header>
			<Card.Content><MultiSeriesLineChart dates={sourceTrendData.dates} series={sourceTrendData.series} comparisonSeries={comparisonSourceTrendData.series} showComparison={chartComparison.sourceTrend} currentRangeLabel={currentRangeLabel} comparisonRangeLabel={comparisonRangeLabel} yAxisLabel="Referrals" xAxisLabel="Date" expandedTitle="Incoming Referral Trend by Source" activeFilters={modalFilterLabels} /></Card.Content>
		</Card.Root>
		<Card.Root>
			<Card.Header class="flex flex-row items-center justify-between gap-2 pb-2"><Card.Title class="text-base">Incoming Referral Trend by Reason</Card.Title>{#if comparisonDisplayEnabled}<Button size="sm" variant={chartComparison.reasonTrend ? 'default' : 'outline'} class={chartComparison.reasonTrend ? CHART_COMPARE_ACTIVE_CLASS : CHART_COMPARE_INACTIVE_CLASS} onclick={() => chartComparison = { ...chartComparison, reasonTrend: !chartComparison.reasonTrend }}>{chartComparison.reasonTrend ? 'Comparing' : 'Compare'}</Button>{/if}</Card.Header>
			<Card.Content><MultiSeriesLineChart dates={reasonTrendData.dates} series={reasonTrendData.series} comparisonSeries={comparisonReasonTrendData.series} showComparison={chartComparison.reasonTrend} currentRangeLabel={currentRangeLabel} comparisonRangeLabel={comparisonRangeLabel} yAxisLabel="Referrals" xAxisLabel="Date" expandedTitle="Incoming Referral Trend by Reason" activeFilters={modalFilterLabels} /></Card.Content>
		</Card.Root>
	</div>

	<TablePanel title="Incoming Referral Detail" columns={TABLE_COLUMNS} rows={table} footerText={summary ? `Generated at ${new Date(summary.generatedAt).toLocaleString()}` : 'No rows available.'} pageSize={20} />
</div>
