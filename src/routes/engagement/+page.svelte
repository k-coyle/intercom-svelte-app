<script lang="ts">
	import { onMount } from 'svelte';
	import ReportCanvas from '$lib/components/report/ReportCanvas.svelte';
	import { fetchOverviewReport, type OverviewResponse } from '$lib/client/overview-report';
	import type { KpiItem } from '$lib/components/report/engagementReportConfig';

	let overview: OverviewResponse | null = null;
	let topKpisOverride: KpiItem[] | null = null;

	function signed(value: number): string {
		return value >= 0 ? `+${value}` : String(value);
	}

	function trendFromDelta(delta: number): 'up' | 'down' | 'flat' {
		if (delta > 0) return 'up';
		if (delta < 0) return 'down';
		return 'flat';
	}

	function mapOverviewKpis(data: OverviewResponse): KpiItem[] {
		return [
			{
				label: 'New registrations (MTD)',
				value: data.kpis.newRegistrationsMtd.count,
				deltaLabel: signed(data.kpis.newRegistrationsMtd.deltaCount),
				deltaPct:
					data.kpis.newRegistrationsMtd.deltaPct == null
						? 'n/a'
						: `${signed(Number(data.kpis.newRegistrationsMtd.deltaPct.toFixed(2)))}%`,
				trend: trendFromDelta(data.kpis.newRegistrationsMtd.deltaCount),
				points: data.kpis.newRegistrationsMtd.sparkline
			},
			{
				label: 'New enrollees (MTD)',
				value: data.kpis.newEnrolleesMtd.count,
				deltaLabel: signed(data.kpis.newEnrolleesMtd.deltaCount),
				deltaPct:
					data.kpis.newEnrolleesMtd.deltaPct == null
						? 'n/a'
						: `${signed(Number(data.kpis.newEnrolleesMtd.deltaPct.toFixed(2)))}%`,
				trend: trendFromDelta(data.kpis.newEnrolleesMtd.deltaCount),
				points: data.kpis.newEnrolleesMtd.sparkline
			},
			{
				label: 'Qualifying coaching sessions (MTD)',
				value: data.kpis.qualifyingSessionsMtd.count,
				deltaLabel: signed(data.kpis.qualifyingSessionsMtd.deltaCount),
				deltaPct:
					data.kpis.qualifyingSessionsMtd.deltaPct == null
						? 'n/a'
						: `${signed(Number(data.kpis.qualifyingSessionsMtd.deltaPct.toFixed(2)))}%`,
				trend: trendFromDelta(data.kpis.qualifyingSessionsMtd.deltaCount),
				points: data.kpis.qualifyingSessionsMtd.sparkline
			}
		];
	}

	async function loadOverview(): Promise<void> {
		try {
			overview = await fetchOverviewReport();
			topKpisOverride = mapOverviewKpis(overview);
		} catch {
			// Keep mock config KPIs if overview endpoint is unavailable.
			topKpisOverride = null;
		}
	}

	onMount(() => {
		void loadOverview();
	});
</script>

<ReportCanvas reportKey="overview" {topKpisOverride} />
