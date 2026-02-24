<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import ReportCanvas from '$lib/components/report/ReportCanvas.svelte';
	import {
		beaconCleanupCaseloadJob,
		cleanupCaseloadJob,
		fetchAllCaseloadViewItems,
		runCaseloadJobUntilComplete
	} from '$lib/client/caseload-job';
	import type { KpiItem, TableColumn } from '$lib/components/report/engagementReportConfig';

	const DEFAULT_LOOKBACK_DAYS = 90;
	const TABLE_LIMIT = 50;
	const SECONDS_PER_DAY = 24 * 60 * 60;

	type SessionChannel = 'Phone' | 'Video Conference' | 'Email' | 'Chat';

	type SessionDetailRow = {
		memberId: string;
		memberName: string | null;
		memberEmail: string | null;
		client: string | null;
		coachId: string | null;
		coachName: string | null;
		channel: SessionChannel;
		time: number;
		daysSince?: number;
	};

	let topKpisOverride: KpiItem[] | null = null;
	let bottomLeftLinesOverride: string[] | null = null;
	let bottomRightTableOverride: {
		title?: string;
		columns?: TableColumn[];
		rows?: Record<string, any>[];
		footerText?: string;
	} | null = null;

	let activeJobId = '';
	let controller: AbortController | null = null;

	function formatUnixDate(unix: number): string {
		const d = new Date(unix * 1000);
		if (Number.isNaN(d.getTime())) return '-';
		return d.toLocaleString();
	}

	function buildSparkline(values: number[]): number[] {
		if (!values.length) return [0, 0, 0];
		const points = values.slice(-12);
		while (points.length < 12) {
			points.unshift(points[0] ?? 0);
		}
		return points;
	}

	function mapTopKpis(sessions: SessionDetailRow[]): KpiItem[] {
		const totalSessions = sessions.length;
		const uniqueMembers = new Set(sessions.map((s) => s.memberId)).size;
		const avgSessionsPerMember = uniqueMembers > 0 ? totalSessions / uniqueMembers : 0;

		const byDay = new Map<string, number>();
		for (const s of sessions) {
			const key = new Date(s.time * 1000).toISOString().slice(0, 10);
			byDay.set(key, (byDay.get(key) ?? 0) + 1);
		}
		const dayCounts = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map((x) => x[1]);
		const points = buildSparkline(dayCounts);

		return [
			{
				label: 'Total sessions (window)',
				value: totalSessions,
				deltaLabel: 'Lookback',
				deltaPct: `${DEFAULT_LOOKBACK_DAYS}d`,
				trend: 'flat',
				points
			},
			{
				label: 'Unique members',
				value: uniqueMembers,
				deltaLabel: 'Coverage',
				deltaPct: `${totalSessions > 0 ? ((uniqueMembers / totalSessions) * 100).toFixed(1) : '0.0'}%`,
				trend: 'flat',
				points
			},
			{
				label: 'Avg sessions/member',
				value: avgSessionsPerMember.toFixed(2),
				deltaLabel: 'Rows',
				deltaPct: String(totalSessions),
				trend: 'flat',
				points
			}
		];
	}

	function mapBottomLeft(sessions: SessionDetailRow[]): string[] {
		const uniqueMembers = new Set(sessions.map((s) => s.memberId)).size;
		const uniqueCoaches = new Set(
			sessions.map((s) => s.coachId).filter((id): id is string => Boolean(id))
		).size;
		const uniqueClients = new Set(
			sessions.map((s) => s.client).filter((v): v is string => Boolean(v))
		).size;

		return [
			`Lookback window: last ${DEFAULT_LOOKBACK_DAYS} days`,
			`Qualifying sessions loaded: ${sessions.length}`,
			`Unique members: ${uniqueMembers}`,
			`Unique coaches: ${uniqueCoaches}`,
			`Unique clients: ${uniqueClients}`,
			'Rows are session-level details (not member-level aggregates).'
		];
	}

	function mapTable(sessions: SessionDetailRow[]): {
		title: string;
		columns: TableColumn[];
		rows: Record<string, any>[];
		footerText: string;
	} {
		const columns: TableColumn[] = [
			{ key: 'time', header: 'Session Time' },
			{ key: 'member', header: 'Member' },
			{ key: 'coach', header: 'Coach' },
			{ key: 'client', header: 'Client' },
			{ key: 'channel', header: 'Channel' },
			{ key: 'daysSince', header: 'Days Since' }
		];

		const sorted = [...sessions].sort((a, b) => b.time - a.time);
		const rows = sorted.slice(0, TABLE_LIMIT).map((s) => {
			const daysSince =
				s.daysSince != null && Number.isFinite(s.daysSince)
					? s.daysSince
					: (Math.floor(Date.now() / 1000) - s.time) / SECONDS_PER_DAY;

			return {
				time: formatUnixDate(s.time),
				member: s.memberName ?? s.memberEmail ?? s.memberId,
				coach: s.coachName ?? s.coachId ?? '-',
				client: s.client ?? '-',
				channel: s.channel,
				daysSince: Math.round(daysSince)
			};
		});

		return {
			title: 'Session Detail',
			columns,
			rows,
			footerText: `Showing 1-${rows.length} of ${sorted.length} entries`
		};
	}

	async function loadSessions(): Promise<void> {
		if (!controller) return;

		let jobIdForCleanup = '';
		try {
			const { jobId } = await runCaseloadJobUntilComplete({
				lookbackDays: DEFAULT_LOOKBACK_DAYS,
				signal: controller.signal,
				onJobCreated: (createdJobId) => {
					activeJobId = createdJobId;
					jobIdForCleanup = createdJobId;
				}
			});
			jobIdForCleanup = jobId;

			const sessions = await fetchAllCaseloadViewItems<SessionDetailRow>({
				jobId,
				view: 'sessions',
				limit: 750,
				signal: controller.signal
			});

			topKpisOverride = mapTopKpis(sessions);
			bottomLeftLinesOverride = mapBottomLeft(sessions);
			bottomRightTableOverride = mapTable(sessions);
		} catch {
			topKpisOverride = null;
			bottomLeftLinesOverride = null;
			bottomRightTableOverride = null;
		} finally {
			if (jobIdForCleanup) {
				void cleanupCaseloadJob(jobIdForCleanup);
				if (activeJobId === jobIdForCleanup) activeJobId = '';
			}
		}
	}

	onMount(() => {
		controller = new AbortController();
		void loadSessions();
	});

	onDestroy(() => {
		controller?.abort();
		if (activeJobId) {
			beaconCleanupCaseloadJob(activeJobId);
		}
	});
</script>

<ReportCanvas
	reportKey="sessions"
	disableFallback={true}
	{topKpisOverride}
	{bottomLeftLinesOverride}
	{bottomRightTableOverride}
/>
