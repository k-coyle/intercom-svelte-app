<script lang="ts">
	import { onMount } from 'svelte';
	import ReportCanvas from '$lib/components/report/ReportCanvas.svelte';
	import LoadStatus from '$lib/components/report/LoadStatus.svelte';
	import DonutConversionChart from '$lib/components/report/DonutConversionChart.svelte';
	import EndpointDocsPanel from '$lib/components/report/EndpointDocsPanel.svelte';
	import ServiceCodeMtdBarChart from '$lib/components/report/ServiceCodeMtdBarChart.svelte';
	import { fetchOverviewReport, type OverviewResponse } from '$lib/client/overview-report';
	import type { KpiItem, TableColumn } from '$lib/components/report/engagementReportConfig';

	let overview: OverviewResponse | null = null;
	let loading = false;
	let error: string | null = null;
	let progressText: string | null = null;
	let topKpisOverride: KpiItem[] | null = null;
	let pageMetaLinesOverride: string[] | null = null;
	let bottomRightTableOverride: {
		title?: string;
		columns?: TableColumn[];
		rows?: Record<string, any>[];
		footerText?: string;
	} | null = null;

	type OverviewEndpointSection = {
		title: string;
		items: Array<{
			method: 'GET' | 'POST';
			path: string;
			summary: string;
			arguments?: string[];
			notes?: string;
		}>;
	};

	const overviewEndpointSections: OverviewEndpointSection[] = [
		{
			title: 'Sync Jobs',
			items: [
				{
					method: 'POST',
					path: '/API/engagement/session-sync',
					summary: 'Hydrates session-derived Intercom attributes (First Session, Last Session, Last Call).',
					arguments: ['op=create|step|cancel|cleanup', 'jobId?', 'lookbackDays?', 'dryRun?', 'mode?'],
					notes: 'Job-style endpoint with step budget/deadline controls. Legacy no-op payloads run to completion. mode: all | first-only | last-and-call-only'
				},
				{
					method: 'POST',
					path: '/API/engagement/engagement-sync',
					summary: 'Reclassifies Engagement Status and Engagement Status Date from enrollment + recency rules.',
					arguments: ['op=create|step|cancel|cleanup', 'jobId?', 'dryRun?', 'enrolledLookbackDays?', 'perPage?'],
					notes: 'Job-style endpoint with step budget/deadline controls. Legacy no-op payloads run to completion.'
				},
				{
					method: 'POST',
					path: '/API/engagement/referral-sync',
					summary: 'Applies referral-based program attributes for eligible member cohorts.',
					arguments: ['op=create|step|cancel|cleanup', 'jobId?', 'dryRun?', 'referralValue?', 'eligibleProgramsValue?', 'perPage?'],
					notes: 'Job-style endpoint with step budget/deadline controls. Legacy no-op payloads run to completion.'
				}
			]
		},
		{
			title: 'Data Exports',
			items: [
				{
					method: 'POST',
					path: '/API/engagement/report/engagement',
					summary: 'Exports participant-level engagement records with optional filtering.',
					arguments: ['returnMode?', 'outputPath?', 'referral?', 'employer?', 'engagementStatus?'],
					notes: 'Supports json, file, and streamed output modes.'
				},
				{
					method: 'POST',
					path: '/API/engagement/report/conversations',
					summary: 'Exports conversation-level activity with channel/service-code flags and teammate metadata.',
					arguments: ['lookbackDays?', 'returnMode?', 'outputPath?', 'perPage?', 'detailsConcurrency?']
				}
			]
		},
		{
			title: 'Explore / Diagnostics',
			items: [
				{
					method: 'GET',
					path: '/API/explore/oncehub/sample-bookings?limit=25',
					summary: 'Returns redacted OnceHub booking samples with field inventory and quick stats.',
					arguments: ['limit?'],
					notes: 'Outside dev, requires x-explore-token header.'
				}
			]
		}
		];

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

	function formatShortDate(value: string): string {
		const date = new Date(`${value}T00:00:00`);
		if (Number.isNaN(date.getTime())) return value;
		return new Intl.DateTimeFormat('en-US', {
			month: 'short',
			day: 'numeric'
		}).format(date);
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

	function mapOverviewHeaderMeta(data: OverviewResponse): string[] {
		return [
			`Current elapsed MTD: ${formatShortDate(data.window.monthStart)} - ${formatShortDate(data.window.elapsedEnd)}`,
			`Prior elapsed MTD: ${formatShortDate(data.window.priorMonthStart)} - ${formatShortDate(data.window.priorElapsedEnd)}`
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
		loading = true;
		error = null;
		progressText = 'Loading overview KPIs...';
		try {
			overview = await fetchOverviewReport();
			topKpisOverride = mapOverviewKpis(overview);
			pageMetaLinesOverride = mapOverviewHeaderMeta(overview);
			bottomRightTableOverride = mapOverviewTable(overview);
		} catch (e: any) {
			// Keep mock config values if overview endpoint is unavailable.
			error = e?.message ?? 'Unable to load overview report.';
			topKpisOverride = null;
			pageMetaLinesOverride = null;
			bottomRightTableOverride = null;
		} finally {
			loading = false;
			progressText = null;
		}
	}

	onMount(() => {
		void loadOverview();
	});
</script>

<div class="space-y-4">
	<LoadStatus {loading} {error} {progressText} />

	<ReportCanvas
		reportKey="overview"
		disableFallback={true}
		{topKpisOverride}
		{pageMetaLinesOverride}
		{bottomRightTableOverride}
	>
		<svelte:fragment slot="midLeft">
			<div class="space-y-4">
				<p class="text-sm text-muted-foreground">
					MTD vs prior-MTD share of newly registered members who completed at least one qualifying
					coaching session.
				</p>
				<div class="grid gap-3 sm:grid-cols-2">
					<DonutConversionChart
						title="Current MTD"
						registeredCount={overview?.enrollmentSnapshot.newlyRegisteredWithQualifyingSessionMtd.current.registeredCount ?? 0}
						withQualifyingSessionCount={overview?.enrollmentSnapshot.newlyRegisteredWithQualifyingSessionMtd.current.withQualifyingSessionCount ?? 0}
						pct={overview?.enrollmentSnapshot.newlyRegisteredWithQualifyingSessionMtd.current.pct ?? null}
						colorVar="var(--color-chart-1)"
					/>
					<DonutConversionChart
						title="Prior MTD"
						registeredCount={overview?.enrollmentSnapshot.newlyRegisteredWithQualifyingSessionMtd.prior.registeredCount ?? 0}
						withQualifyingSessionCount={overview?.enrollmentSnapshot.newlyRegisteredWithQualifyingSessionMtd.prior.withQualifyingSessionCount ?? 0}
						pct={overview?.enrollmentSnapshot.newlyRegisteredWithQualifyingSessionMtd.prior.pct ?? null}
						colorVar="var(--color-chart-2)"
					/>
				</div>
			</div>
		</svelte:fragment>
		<svelte:fragment slot="midRight">
			<ServiceCodeMtdBarChart
				rows={overview?.caseloadTrends.sessionsByServiceCodeMtd ?? []}
				maxBars={6}
			/>
		</svelte:fragment>
		<svelte:fragment slot="bottomLeft">
			<EndpointDocsPanel
				intro="Backend endpoints and background jobs that support the reporting suite."
				sections={overviewEndpointSections}
			/>
		</svelte:fragment>
	</ReportCanvas>
</div>
