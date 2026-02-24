<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import ReportCanvas from '$lib/components/report/ReportCanvas.svelte';
	import {
		cleanupBillingJob,
		fetchBillingView,
		runBillingJobUntilComplete
	} from '$lib/client/billing-job';
	import type { KpiItem, TableColumn } from '$lib/components/report/engagementReportConfig';

	const TABLE_LIMIT = 50;

	type BillingSummaryResponse = {
		year: number;
		month: number;
		monthYearLabel: string;
		monthStart: string;
		monthEnd: string;
		generatedAt: string;
		totalRows: number;
	};

	type BillingRow = {
		memberId: string;
		memberName: string | null;
		memberEmail: string | null;
		employer: string | null;
		registrationAt: number | null;
		lastSessionAt: number | null;
		isNewParticipant: boolean;
		engagedDuringMonth: boolean;
	};

	type BillingRowsResponse = {
		items: BillingRow[];
		total: number;
		nextOffset: number | null;
	};

	type BillingProgress = {
		newParticipants?: number;
		engagedParticipants?: number;
		unionMembers?: number;
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

	function formatIsoDate(iso?: string): string {
		if (!iso) return '-';
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return '-';
		return d.toLocaleString();
	}

	function formatUnixDate(unix: number | null): string {
		if (unix == null) return '-';
		const d = new Date(unix * 1000);
		if (Number.isNaN(d.getTime())) return '-';
		return d.toLocaleDateString();
	}

	function getMonthYearFromQuery(): string | undefined {
		if (typeof window === 'undefined') return undefined;
		const value = new URLSearchParams(window.location.search).get('monthYearLabel') ?? '';
		return value.trim() || undefined;
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

	function mapTopKpis(summary: BillingSummaryResponse, progress: BillingProgress | null): KpiItem[] {
		const total = summary.totalRows ?? progress?.unionMembers ?? 0;
		const newParticipants = progress?.newParticipants ?? 0;
		const engaged = progress?.engagedParticipants ?? 0;

		return [
			buildKpi('Total billable users', total, total),
			buildKpi('New participants in month', newParticipants, total),
			buildKpi('Engaged during month', engaged, total)
		];
	}

	function mapBottomLeft(summary: BillingSummaryResponse, progress: BillingProgress | null): string[] {
		return [
			`Billing month: ${summary.monthYearLabel}`,
			`Month window: ${summary.monthStart} to ${summary.monthEnd}`,
			`Generated at: ${formatIsoDate(summary.generatedAt)}`,
			`Total billable members: ${summary.totalRows}`,
			`New participants: ${progress?.newParticipants ?? 0}`,
			`Engaged participants: ${progress?.engagedParticipants ?? 0}`,
			'Rule: billable cohort = new participants UNION engaged participants for selected month.'
		];
	}

	function mapTable(data: BillingRowsResponse): {
		title: string;
		columns: TableColumn[];
		rows: Record<string, any>[];
		footerText: string;
	} {
		const columns: TableColumn[] = [
			{ key: 'member', header: 'Member' },
			{ key: 'employer', header: 'Employer' },
			{ key: 'enrolledDate', header: 'Enrolled Date' },
			{ key: 'lastSession', header: 'Last Session' },
			{ key: 'flags', header: 'Flags' }
		];

		const rows = (data.items ?? []).map((item) => {
			const flags: string[] = [];
			if (item.isNewParticipant) flags.push('New');
			if (item.engagedDuringMonth) flags.push('Engaged');

			return {
				member: item.memberName ?? item.memberEmail ?? item.memberId,
				employer: item.employer ?? '-',
				enrolledDate: formatUnixDate(item.registrationAt),
				lastSession: formatUnixDate(item.lastSessionAt),
				flags: flags.join(' + ') || '-'
			};
		});

		const shown = rows.length;
		return {
			title: 'Billable Members',
			columns,
			rows,
			footerText: `Showing 1-${shown} of ${data.total} entries`
		};
	}

	async function loadBilling(): Promise<void> {
		if (!controller) return;

		let jobIdForCleanup = '';
		try {
			const monthYearLabel = getMonthYearFromQuery();
			const { jobId, progress } = await runBillingJobUntilComplete({
				monthYearLabel,
				signal: controller.signal,
				onJobCreated: (createdJobId) => {
					activeJobId = createdJobId;
					jobIdForCleanup = createdJobId;
				}
			});
			jobIdForCleanup = jobId;

			const [summary, rows] = await Promise.all([
				fetchBillingView<BillingSummaryResponse>(jobId, 'summary', undefined, undefined, controller.signal),
				fetchBillingView<BillingRowsResponse>(jobId, 'rows', 0, TABLE_LIMIT, controller.signal)
			]);

			topKpisOverride = mapTopKpis(summary, progress as BillingProgress);
			bottomLeftLinesOverride = mapBottomLeft(summary, progress as BillingProgress);
			bottomRightTableOverride = mapTable(rows);
		} catch {
			topKpisOverride = null;
			bottomLeftLinesOverride = null;
			bottomRightTableOverride = null;
		} finally {
			if (jobIdForCleanup) {
				void cleanupBillingJob(jobIdForCleanup);
				if (activeJobId === jobIdForCleanup) activeJobId = '';
			}
		}
	}

	onMount(() => {
		controller = new AbortController();
		void loadBilling();
	});

	onDestroy(() => {
		controller?.abort();
		if (activeJobId) {
			void cleanupBillingJob(activeJobId, true);
		}
	});
</script>

<ReportCanvas
	reportKey="billing"
	disableFallback={true}
	{topKpisOverride}
	{bottomLeftLinesOverride}
	{bottomRightTableOverride}
/>
