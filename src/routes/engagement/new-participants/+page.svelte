<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import ReportCanvas from '$lib/components/report/ReportCanvas.svelte';
	import {
		cleanupNewParticipantsJob,
		fetchNewParticipantsView,
		runNewParticipantsJobUntilComplete
	} from '$lib/client/new-participants-job';
	import type { KpiItem, TableColumn } from '$lib/components/report/engagementReportConfig';

	const DEFAULT_LOOKBACK_DAYS = 365;
	const TABLE_LIMIT = 50;

	type NewParticipantsSummaryResponse = {
		generatedAt: string;
		lookbackDays: number;
		totalParticipants: number;
		summary: {
			gt_14_to_21: number;
			gt_21_to_28: number;
			gt_28: number;
		};
	};

	type NewParticipantsRow = {
		memberId: string;
		memberName: string | null;
		memberEmail: string | null;
		client: string | null;
		participantAt: number | null;
		lastSessionAt: number | null;
		daysWithoutSession: number | null;
		coachNames: string[];
	};

	type NewParticipantsRowsResponse = {
		items: NewParticipantsRow[];
		total: number;
		nextOffset: number | null;
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

	function formatUnixDate(unix: number | null): string {
		if (unix == null) return '-';
		const d = new Date(unix * 1000);
		if (Number.isNaN(d.getTime())) return '-';
		return d.toLocaleDateString();
	}

	function formatIsoDate(iso?: string): string {
		if (!iso) return '-';
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return '-';
		return d.toLocaleString();
	}

	function buildKpi(label: string, count: number, total: number): KpiItem {
		const share = total > 0 ? `${((count / total) * 100).toFixed(1)}%` : '0.0%';
		return {
			label,
			value: count,
			deltaLabel: 'Share',
			deltaPct: share,
			trend: 'flat',
			points: [count, count, count]
		};
	}

	function mapTopKpis(summary: NewParticipantsSummaryResponse): KpiItem[] {
		return [
			buildKpi(
				'15-21 days without session',
				summary.summary?.gt_14_to_21 ?? 0,
				summary.totalParticipants ?? 0
			),
			buildKpi(
				'22-28 days without session',
				summary.summary?.gt_21_to_28 ?? 0,
				summary.totalParticipants ?? 0
			),
			buildKpi(
				'> 28 days without session',
				summary.summary?.gt_28 ?? 0,
				summary.totalParticipants ?? 0
			)
		];
	}

	function mapBottomLeft(summary: NewParticipantsSummaryResponse): string[] {
		return [
			`Lookback window: last ${summary.lookbackDays} days`,
			`Generated at: ${formatIsoDate(summary.generatedAt)}`,
			`Participants loaded: ${summary.totalParticipants}`,
			`15-21 days without session: ${summary.summary?.gt_14_to_21 ?? 0}`,
			`22-28 days without session: ${summary.summary?.gt_21_to_28 ?? 0}`,
			`> 28 days without session: ${summary.summary?.gt_28 ?? 0}`
		];
	}

	function mapTable(data: NewParticipantsRowsResponse): {
		title: string;
		columns: TableColumn[];
		rows: Record<string, any>[];
		footerText: string;
	} {
		const columns: TableColumn[] = [
			{ key: 'member', header: 'Member' },
			{ key: 'client', header: 'Client' },
			{ key: 'enrolledDate', header: 'Enrolled Date' },
			{ key: 'lastSession', header: 'Last Session' },
			{ key: 'daysWithoutSession', header: 'Days Without Session' },
			{ key: 'coaches', header: 'Coaches' }
		];

		const rows = (data.items ?? []).map((item) => ({
			member: item.memberName ?? item.memberEmail ?? item.memberId,
			client: item.client ?? '-',
			enrolledDate: formatUnixDate(item.participantAt),
			lastSession: formatUnixDate(item.lastSessionAt),
			daysWithoutSession:
				item.daysWithoutSession != null && Number.isFinite(item.daysWithoutSession)
					? Math.round(item.daysWithoutSession)
					: '-',
			coaches: item.coachNames?.join(', ') || '-'
		}));

		const shown = rows.length;
		return {
			title: 'Recent Enrollments',
			columns,
			rows,
			footerText: `Showing 1-${shown} of ${data.total} entries`
		};
	}

	async function loadNewParticipants(): Promise<void> {
		if (!controller) return;

		let jobIdForCleanup = '';
		try {
			const { jobId } = await runNewParticipantsJobUntilComplete({
				lookbackDays: DEFAULT_LOOKBACK_DAYS,
				signal: controller.signal,
				onJobCreated: (createdJobId) => {
					activeJobId = createdJobId;
					jobIdForCleanup = createdJobId;
				}
			});
			jobIdForCleanup = jobId;

			const [summary, rows] = await Promise.all([
				fetchNewParticipantsView<NewParticipantsSummaryResponse>(
					jobId,
					'summary',
					undefined,
					undefined,
					controller.signal
				),
				fetchNewParticipantsView<NewParticipantsRowsResponse>(
					jobId,
					'participants',
					0,
					TABLE_LIMIT,
					controller.signal
				)
			]);

			topKpisOverride = mapTopKpis(summary);
			bottomLeftLinesOverride = mapBottomLeft(summary);
			bottomRightTableOverride = mapTable(rows);
		} catch {
			topKpisOverride = null;
			bottomLeftLinesOverride = null;
			bottomRightTableOverride = null;
		} finally {
			if (jobIdForCleanup) {
				void cleanupNewParticipantsJob(jobIdForCleanup);
				if (activeJobId === jobIdForCleanup) activeJobId = '';
			}
		}
	}

	onMount(() => {
		controller = new AbortController();
		void loadNewParticipants();
	});

	onDestroy(() => {
		controller?.abort();
		if (activeJobId) {
			void cleanupNewParticipantsJob(activeJobId, true);
		}
	});
</script>

<ReportCanvas
	reportKey="enrolled"
	disableFallback={true}
	{topKpisOverride}
	{bottomLeftLinesOverride}
	{bottomRightTableOverride}
/>
