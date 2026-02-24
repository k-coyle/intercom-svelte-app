<script lang="ts">
	import { onMount } from 'svelte';
	import ReportCanvas from '$lib/components/report/ReportCanvas.svelte';
	import { fetchOverviewReport, type OverviewResponse } from '$lib/client/overview-report';
	import type { KpiItem, TableColumn } from '$lib/components/report/engagementReportConfig';

	let overview: OverviewResponse | null = null;
	let topKpisOverride: KpiItem[] | null = null;
	let bottomLeftLinesOverride: string[] | null = null;
	let bottomRightTableOverride: {
		title?: string;
		columns?: TableColumn[];
		rows?: Record<string, any>[];
		footerText?: string;
	} | null = null;

	function signed(value: number): string {
		return value >= 0 ? `+${value}` : String(value);
	}

	function trendFromDelta(delta: number): 'up' | 'down' | 'flat' {
		if (delta > 0) return 'up';
		if (delta < 0) return 'down';
		return 'flat';
	}

	function formatPercent(value: number | null): string {
		if (value == null) return 'n/a';
		return `${signed(Number(value.toFixed(2)))}%`;
	}

	function mapOverviewKpis(data: OverviewResponse): KpiItem[] {
		return [
			{
				label: 'New registrations (MTD)',
				value: data.kpis.newRegistrationsMtd.count,
				deltaLabel: signed(data.kpis.newRegistrationsMtd.deltaCount),
				deltaPct: formatPercent(data.kpis.newRegistrationsMtd.deltaPct),
				trend: trendFromDelta(data.kpis.newRegistrationsMtd.deltaCount),
				points: data.kpis.newRegistrationsMtd.sparkline
			},
			{
				label: 'New enrollees (MTD)',
				value: data.kpis.newEnrolleesMtd.count,
				deltaLabel: signed(data.kpis.newEnrolleesMtd.deltaCount),
				deltaPct: formatPercent(data.kpis.newEnrolleesMtd.deltaPct),
				trend: trendFromDelta(data.kpis.newEnrolleesMtd.deltaCount),
				points: data.kpis.newEnrolleesMtd.sparkline
			},
			{
				label: 'Qualifying coaching sessions (MTD)',
				value: data.kpis.qualifyingSessionsMtd.count,
				deltaLabel: signed(data.kpis.qualifyingSessionsMtd.deltaCount),
				deltaPct: formatPercent(data.kpis.qualifyingSessionsMtd.deltaPct),
				trend: trendFromDelta(data.kpis.qualifyingSessionsMtd.deltaCount),
				points: data.kpis.qualifyingSessionsMtd.sparkline
			}
		];
	}

	function mapOverviewBottomLeft(data: OverviewResponse): string[] {
		return [
			`Month: ${data.monthYearLabel}`,
			`Reporting timezone: ${data.timeZone}`,
			`Current elapsed window: ${data.window.monthStart} to ${data.window.elapsedEnd} (${data.window.elapsedDays} days)`,
			`Prior elapsed window: ${data.window.priorMonthStart} to ${data.window.priorElapsedEnd} (${data.window.priorElapsedDays} days)`,
			'POST /API/engagement/session-sync',
			'POST /API/engagement/engagement-sync',
			'POST /API/engagement/referral-sync',
			'POST /API/engagement/report/engagement',
			'First three endpoints update Intercom attributes; last endpoint produces a reporting stream.'
		];
	}

	function mapOverviewTable(data: OverviewResponse) {
		const columns: TableColumn[] = [
			{ key: 'metric', header: 'Metric' },
			{ key: 'current', header: 'Current MTD' },
			{ key: 'prior', header: 'Prior MTD' },
			{ key: 'delta', header: 'Delta' }
		];

		const rows = [
			{
				metric: 'New registrations',
				current: data.kpis.newRegistrationsMtd.count,
				prior: data.kpis.newRegistrationsMtd.priorCount,
				delta: `${signed(data.kpis.newRegistrationsMtd.deltaCount)} (${formatPercent(data.kpis.newRegistrationsMtd.deltaPct)})`
			},
			{
				metric: 'New enrollees',
				current: data.kpis.newEnrolleesMtd.count,
				prior: data.kpis.newEnrolleesMtd.priorCount,
				delta: `${signed(data.kpis.newEnrolleesMtd.deltaCount)} (${formatPercent(data.kpis.newEnrolleesMtd.deltaPct)})`
			},
			{
				metric: 'Qualifying coaching sessions',
				current: data.kpis.qualifyingSessionsMtd.count,
				prior: data.kpis.qualifyingSessionsMtd.priorCount,
				delta: `${signed(data.kpis.qualifyingSessionsMtd.deltaCount)} (${formatPercent(data.kpis.qualifyingSessionsMtd.deltaPct)})`
			}
		];

		return {
			title: 'Overview Metric Breakdown',
			columns,
			rows,
			footerText: `As of ${data.window.elapsedEnd} (${data.timeZone})`
		};
	}

	async function loadOverview(): Promise<void> {
		try {
			overview = await fetchOverviewReport();
			topKpisOverride = mapOverviewKpis(overview);
			bottomLeftLinesOverride = mapOverviewBottomLeft(overview);
			bottomRightTableOverride = mapOverviewTable(overview);
		} catch {
			// Keep mock config values if overview endpoint is unavailable.
			topKpisOverride = null;
			bottomLeftLinesOverride = null;
			bottomRightTableOverride = null;
		}
	}

	onMount(() => {
		void loadOverview();
	});
</script>

<ReportCanvas
	reportKey="overview"
	{topKpisOverride}
	{bottomLeftLinesOverride}
	{bottomRightTableOverride}
/>
