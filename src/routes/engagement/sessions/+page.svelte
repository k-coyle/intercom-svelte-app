<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import ReportCanvas from '$lib/components/report/ReportCanvas.svelte';
	import { fetchSessionsReport, type SessionsReportResponse } from '$lib/client/sessions-report';
	import type { KpiItem, TableColumn } from '$lib/components/report/engagementReportConfig';

	const DEFAULT_LOOKBACK_DAYS = 90;
	const TABLE_LIMIT = 50;

	let topKpisOverride: KpiItem[] | null = null;
	let bottomLeftLinesOverride: string[] | null = null;
	let bottomRightTableOverride: {
		title?: string;
		columns?: TableColumn[];
		rows?: Record<string, any>[];
		footerText?: string;
	} | null = null;

	let controller: AbortController | null = null;

	function parseUsDate(value: string): Date | null {
		const parts = value.split('/').map((part) => Number(part));
		if (parts.length !== 3) return null;

		const [month, day, year] = parts;
		if (!month || !day || !year) return null;

		const date = new Date(year, month - 1, day);
		if (Number.isNaN(date.getTime())) return null;
		return date;
	}

	function buildSparkline(values: number[]): number[] {
		if (!values.length) return [0, 0, 0];
		const sorted = [...values].slice(-12);
		while (sorted.length < 12) sorted.unshift(sorted[0] ?? 0);
		return sorted;
	}

	function signed(value: number): string {
		return value >= 0 ? `+${value}` : String(value);
	}

	function mapTopKpis(data: SessionsReportResponse): KpiItem[] {
		const totalSessions = data.rowsWritten ?? 0;
		const uniqueMembers = new Set(
			(data.preview ?? []).map((row) => row.user_name?.trim()).filter((v) => !!v)
		).size;
		const avgSessionsPerMember = uniqueMembers > 0 ? totalSessions / uniqueMembers : 0;
		const previewCoverage = totalSessions > 0 ? ((data.preview?.length ?? 0) / totalSessions) * 100 : 0;

		const sessionsByDay = new Map<string, number>();
		for (const row of data.preview ?? []) {
			const key = row.created_at;
			sessionsByDay.set(key, (sessionsByDay.get(key) ?? 0) + 1);
		}
		const dayCounts = [...sessionsByDay.entries()]
			.sort((a, b) => {
				const aDate = parseUsDate(a[0])?.getTime() ?? 0;
				const bDate = parseUsDate(b[0])?.getTime() ?? 0;
				return aDate - bDate;
			})
			.map((entry) => entry[1]);

		return [
			{
				label: 'Total sessions (window)',
				value: totalSessions,
				deltaLabel: 'Lookback',
				deltaPct: `${data.lookbackDays}d`,
				trend: 'flat',
				points: buildSparkline(dayCounts)
			},
			{
				label: 'Unique members (preview)',
				value: uniqueMembers,
				deltaLabel: 'Preview',
				deltaPct: `${previewCoverage.toFixed(1)}%`,
				trend: 'flat',
				points: buildSparkline(dayCounts.map((count) => Math.min(count, uniqueMembers || count)))
			},
			{
				label: 'Avg sessions/member',
				value: avgSessionsPerMember.toFixed(2),
				deltaLabel: 'Rows',
				deltaPct: signed(totalSessions),
				trend: 'flat',
				points: buildSparkline(dayCounts)
			}
		];
	}

	function mapBottomLeft(data: SessionsReportResponse): string[] {
		return [
			`Lookback window: last ${data.lookbackDays} days`,
			`Filter field: ${data.filterField}`,
			`Conversations fetched: ${data.conversationsFetched}`,
			`Conversation details fetched: ${data.detailsFetched}`,
			`Rows written: ${data.rowsWritten}`,
			`Skipped (missing user name): ${data.skippedMissingUserName}`,
			`Missing contact records: ${data.missingContact}`,
			`Missing conversation details: ${data.missingDetails}`
		];
	}

	function mapTable(data: SessionsReportResponse): {
		title: string;
		columns: TableColumn[];
		rows: Record<string, any>[];
		footerText: string;
	} {
		const columns: TableColumn[] = [
			{ key: 'createdAt', header: 'Created' },
			{ key: 'user', header: 'User' },
			{ key: 'teammate', header: 'Teammate' },
			{ key: 'channel', header: 'Channel' },
			{ key: 'serviceCode', header: 'Service Code' },
			{ key: 'communication', header: 'Communication' },
			{ key: 'state', header: 'State' },
			{ key: 'employer', header: 'Employer' }
		];

		const previewRows = (data.preview ?? []).slice(0, TABLE_LIMIT).map((row) => ({
			createdAt: row.created_at || '-',
			user: row.user_name || '-',
			teammate: row.teammate_name || '-',
			channel: row.channel || '-',
			serviceCode: row.service_code || '-',
			communication: row.communication_flag || '-',
			state: row.state || '-',
			employer: row.employer || '-'
		}));

		const shown = previewRows.length;
		return {
			title: 'Session Detail (Preview)',
			columns,
			rows: previewRows,
			footerText: `Showing 1-${shown} of ${data.rowsWritten} entries`
		};
	}

	async function loadSessions(): Promise<void> {
		if (!controller) return;

		try {
			const data = await fetchSessionsReport(DEFAULT_LOOKBACK_DAYS, controller.signal);
			topKpisOverride = mapTopKpis(data);
			bottomLeftLinesOverride = mapBottomLeft(data);
			bottomRightTableOverride = mapTable(data);
		} catch {
			topKpisOverride = null;
			bottomLeftLinesOverride = null;
			bottomRightTableOverride = null;
		}
	}

	onMount(() => {
		controller = new AbortController();
		void loadSessions();
	});

	onDestroy(() => {
		controller?.abort();
	});
</script>

<ReportCanvas
	reportKey="sessions"
	{topKpisOverride}
	{bottomLeftLinesOverride}
	{bottomRightTableOverride}
/>
