<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import ReportCanvas from '$lib/components/report/ReportCanvas.svelte';
	import {
		beaconCleanupCaseloadJob,
		cleanupCaseloadJob,
		fetchCaseloadViewPage,
		runCaseloadJobUntilComplete
	} from '$lib/client/caseload-job';
	import type { TableColumn } from '$lib/components/report/engagementReportConfig';

	const DEFAULT_LOOKBACK_DAYS = 90;
	const TABLE_LIMIT = 50;

	type CaseloadSummaryResponse = {
		lookbackDays: number;
		generatedAt?: string;
		totalMembers: number;
		summary?: {
			bucket_1: number;
			bucket_2: number;
			bucket_3: number;
			bucket_4: number;
		} | null;
		counts?: {
			members: number;
			sessions: number;
		};
	};

	type CaseloadMemberBuckets = {
		bucket_1: boolean;
		bucket_2: boolean;
		bucket_3: boolean;
		bucket_4: boolean;
	};

	type CaseloadMemberRow = {
		memberId: string;
		memberName: string | null;
		memberEmail: string | null;
		client: string | null;
		coachNames: string[];
		channelCombo: string;
		lastSessionAt: number;
		daysSinceLastSession: number;
		buckets: CaseloadMemberBuckets;
	};

	type CaseloadMembersResponse = {
		items: CaseloadMemberRow[];
		total: number;
		nextOffset: number | null;
	};

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
		return d.toLocaleDateString();
	}

	function formatIsoDate(iso?: string): string {
		if (!iso) return '-';
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return '-';
		return d.toLocaleString();
	}

	function getBucketLabel(buckets: CaseloadMemberBuckets): string {
		if (buckets.bucket_1) return '<= 7d';
		if (buckets.bucket_2) return '8-28d';
		if (buckets.bucket_3) return '29-56d';
		if (buckets.bucket_4) return '> 56d';
		return '-';
	}

	function mapBottomLeft(summary: CaseloadSummaryResponse): string[] {
		return [
			`Lookback window: last ${summary.lookbackDays} days`,
			`Generated at: ${formatIsoDate(summary.generatedAt)}`,
			`Unique members: ${summary.totalMembers ?? 0}`,
			`Qualifying sessions: ${summary.counts?.sessions ?? 0}`,
			`Bucket 1 (<= 7d): ${summary.summary?.bucket_1 ?? 0}`,
			`Bucket 2 (8-28d): ${summary.summary?.bucket_2 ?? 0}`,
			`Bucket 3 (29-56d): ${summary.summary?.bucket_3 ?? 0}`,
			`Bucket 4 (> 56d): ${summary.summary?.bucket_4 ?? 0}`
		];
	}

	function mapTable(members: CaseloadMembersResponse): {
		title: string;
		columns: TableColumn[];
		rows: Record<string, any>[];
		footerText: string;
	} {
		const columns: TableColumn[] = [
			{ key: 'member', header: 'Member' },
			{ key: 'client', header: 'Client' },
			{ key: 'coaches', header: 'Coaches' },
			{ key: 'channels', header: 'Channel Mix' },
			{ key: 'lastSession', header: 'Last Session' },
			{ key: 'daysSince', header: 'Days Since' },
			{ key: 'bucket', header: 'Bucket' }
		];

		const rows = (members.items ?? []).map((item) => ({
			member: item.memberName ?? item.memberEmail ?? item.memberId,
			client: item.client ?? '-',
			coaches: item.coachNames?.join(', ') || '-',
			channels: item.channelCombo || '-',
			lastSession: formatUnixDate(item.lastSessionAt),
			daysSince: Number.isFinite(item.daysSinceLastSession)
				? Math.round(item.daysSinceLastSession)
				: '-',
			bucket: getBucketLabel(item.buckets)
		}));

		const shownCount = rows.length;
		const totalCount = Number.isFinite(members.total) ? members.total : shownCount;

		return {
			title: 'Caseload Member Detail',
			columns,
			rows,
			footerText: `Showing 1-${shownCount} of ${totalCount} entries`
		};
	}

	async function loadCaseload(): Promise<void> {
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

			const [summary, members] = await Promise.all([
				fetchCaseloadViewPage<CaseloadSummaryResponse>(
					jobId,
					'summary',
					undefined,
					undefined,
					controller.signal
				),
				fetchCaseloadViewPage<CaseloadMembersResponse>(
					jobId,
					'members',
					0,
					TABLE_LIMIT,
					controller.signal
				)
			]);

			bottomLeftLinesOverride = mapBottomLeft(summary);
			bottomRightTableOverride = mapTable(members);
		} catch {
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
		void loadCaseload();
	});

	onDestroy(() => {
		controller?.abort();
		if (activeJobId) {
			beaconCleanupCaseloadJob(activeJobId);
		}
	});
</script>

<ReportCanvas reportKey="caseload" {bottomLeftLinesOverride} {bottomRightTableOverride} />
