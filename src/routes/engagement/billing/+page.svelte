<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import ReportCanvas from '$lib/components/report/ReportCanvas.svelte';
	import LoadStatus from '$lib/components/report/LoadStatus.svelte';
	import * as Card from '$lib/components/ui/card';
	import { Input } from '$lib/components/ui/input';
	import { Button } from '$lib/components/ui/button';
	import {
		cleanupBillingJob,
		fetchAllBillingRows,
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

	let topKpisOverride: KpiItem[] | null = null;
	let bottomLeftLinesOverride: string[] | null = null;
	let bottomRightTableOverride: {
		title?: string;
		columns?: TableColumn[];
		rows?: Record<string, any>[];
		footerText?: string;
	} | null = null;

	let loadedSummary: BillingSummaryResponse | null = null;
	let loadedRows: BillingRow[] = [];
	let uniqueEmployers: string[] = [];

	let loading = false;
	let error: string | null = null;
	let progressText: string | null = null;
	let selectedEmployer = '';
	let selectedMonthLabel = '';

	let activeJobId = '';
	let controller: AbortController | null = null;

	function getPreviousMonthLabel(): string {
		const now = new Date();
		let year = now.getFullYear();
		let month = now.getMonth(); // previous month index after adjust
		if (month === 0) {
			year -= 1;
			month = 12;
		}
		return `${year}-${String(month).padStart(2, '0')}`;
	}

	function readMonthLabelFromQuery(): string | null {
		if (typeof window === 'undefined') return null;
		const value = new URLSearchParams(window.location.search).get('monthYearLabel') ?? '';
		return value.trim() || null;
	}

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

	function buildFilterOptions(): void {
		const employers = new Set<string>();
		for (const row of loadedRows) {
			if (row.employer) employers.add(row.employer);
		}
		uniqueEmployers = [...employers].sort((a, b) => a.localeCompare(b));
	}

	function filteredRows(): BillingRow[] {
		if (!selectedEmployer) return loadedRows;
		return loadedRows.filter((row) => row.employer === selectedEmployer);
	}

	function mapTopKpis(rows: BillingRow[]): KpiItem[] {
		const total = rows.length;
		const newParticipants = rows.filter((row) => row.isNewParticipant).length;
		const engaged = rows.filter((row) => row.engagedDuringMonth).length;

		return [
			buildKpi('Total billable users', total, total),
			buildKpi('New participants in month', newParticipants, total),
			buildKpi('Engaged during month', engaged, total)
		];
	}

	function mapBottomLeft(summary: BillingSummaryResponse, rows: BillingRow[]): string[] {
		const total = rows.length;
		const newParticipants = rows.filter((row) => row.isNewParticipant).length;
		const engaged = rows.filter((row) => row.engagedDuringMonth).length;

		return [
			`Billing month: ${summary.monthYearLabel}`,
			`Month window: ${summary.monthStart} to ${summary.monthEnd}`,
			`Generated at: ${formatIsoDate(summary.generatedAt)}`,
			`Filtered billable members: ${total} of ${loadedRows.length}`,
			`New participants: ${newParticipants}`,
			`Engaged participants: ${engaged}`,
			'Rule: billable cohort = new participants UNION engaged participants for selected month.'
		];
	}

	function mapTable(rows: BillingRow[]): {
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

		const tableRows = rows.slice(0, TABLE_LIMIT).map((item) => {
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

		return {
			title: 'Billable Members',
			columns,
			rows: tableRows,
			footerText: `Showing 1-${tableRows.length} of ${rows.length} entries`
		};
	}

	function recomputeDisplay(): void {
		if (!loadedSummary) {
			topKpisOverride = null;
			bottomLeftLinesOverride = null;
			bottomRightTableOverride = null;
			return;
		}

		const rows = filteredRows();
		topKpisOverride = mapTopKpis(rows);
		bottomLeftLinesOverride = mapBottomLeft(loadedSummary, rows);
		bottomRightTableOverride = mapTable(rows);
	}

	function resetFilters(): void {
		selectedEmployer = '';
	}

	function isValidMonthLabel(value: string): boolean {
		return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
	}

	async function loadBilling(): Promise<void> {
		if (!controller) return;

		loading = true;
		error = null;
		progressText = 'Starting billing job...';

		let jobIdForCleanup = '';
		try {
			if (!isValidMonthLabel(selectedMonthLabel)) {
				throw new Error('Month must be in YYYY-MM format.');
			}

			const { jobId } = await runBillingJobUntilComplete({
				monthYearLabel: selectedMonthLabel,
				signal: controller.signal,
				onJobCreated: (createdJobId) => {
					activeJobId = createdJobId;
					jobIdForCleanup = createdJobId;
				},
				onProgress: (progress) => {
					const p = progress?.progress ?? {};
					progressText = `Phase ${progress?.phase ?? 'running'} · conv pages ${p.conversationPagesFetched ?? 0} · participant pages ${p.participantPagesFetched ?? 0} · contacts remaining ${p.contactsRemaining ?? 0}`;
				}
			});
			jobIdForCleanup = jobId;

			const [summary, rows] = await Promise.all([
				fetchBillingView<BillingSummaryResponse>(jobId, 'summary', undefined, undefined, controller.signal),
				fetchAllBillingRows<BillingRow>({
					jobId,
					limit: 1000,
					signal: controller.signal,
					onPage: ({ loaded, total }) => {
						progressText = `Loading billing rows ${loaded}${total != null ? ` / ${total}` : ''}...`;
					}
				})
			]);

			loadedSummary = summary;
			loadedRows = rows;
			buildFilterOptions();
			recomputeDisplay();
		} catch (e: any) {
			error = e?.message ?? 'Unable to load billing report.';
			loadedSummary = null;
			loadedRows = [];
			topKpisOverride = null;
			bottomLeftLinesOverride = null;
			bottomRightTableOverride = null;
		} finally {
			loading = false;
			progressText = null;
			if (jobIdForCleanup) {
				void cleanupBillingJob(jobIdForCleanup);
				if (activeJobId === jobIdForCleanup) activeJobId = '';
			}
		}
	}

	$: if (loadedSummary) {
		selectedEmployer;
		recomputeDisplay();
	}

	onMount(() => {
		controller = new AbortController();
		selectedMonthLabel = readMonthLabelFromQuery() ?? getPreviousMonthLabel();
		void loadBilling();
	});

	onDestroy(() => {
		controller?.abort();
		if (activeJobId) {
			void cleanupBillingJob(activeJobId, true);
		}
	});
</script>

<div class="space-y-4">
	<Card.Root>
		<Card.Header class="pb-3">
			<Card.Title class="text-base">Billing Filters</Card.Title>
			<Card.Description>Restore legacy billing month and employer filters.</Card.Description>
		</Card.Header>
		<Card.Content class="space-y-4">
			<div class="grid gap-3 md:grid-cols-3">
				<div class="space-y-1">
					<label class="text-xs font-medium text-muted-foreground" for="monthYearLabel">Billing Month</label>
					<Input id="monthYearLabel" type="month" bind:value={selectedMonthLabel} />
				</div>
				<div class="space-y-1">
					<label class="text-xs font-medium text-muted-foreground" for="employerFilter">Employer</label>
					<select
						id="employerFilter"
						class="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
						bind:value={selectedEmployer}
					>
						<option value="">All employers</option>
						{#each uniqueEmployers as employer}
							<option value={employer}>{employer}</option>
						{/each}
					</select>
				</div>
				<div class="flex items-end gap-2">
					<Button class="w-full" onclick={loadBilling} disabled={loading}>
						{loading ? 'Loading...' : 'Run'}
					</Button>
					<Button variant="outline" onclick={resetFilters} disabled={loading}>Reset</Button>
				</div>
			</div>

			<LoadStatus {loading} {error} {progressText} />
		</Card.Content>
	</Card.Root>

	<ReportCanvas
		reportKey="billing"
		disableFallback={true}
		{topKpisOverride}
		{bottomLeftLinesOverride}
		{bottomRightTableOverride}
	/>
</div>
