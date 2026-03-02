<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import ReportCanvas from '$lib/components/report/ReportCanvas.svelte';
	import LoadStatus from '$lib/components/report/LoadStatus.svelte';
	import MultiSelectDropdown from '$lib/components/report/MultiSelectDropdown.svelte';
	import * as Card from '$lib/components/ui/card';
	import { Input } from '$lib/components/ui/input';
	import { Button } from '$lib/components/ui/button';
	import {
		cleanupBillingJob,
		fetchAllBillingRows,
		fetchBillingView,
		runBillingJobUntilComplete
	} from '$lib/client/billing-job';
	import { formatIsoDate, formatUnixDate } from '$lib/client/report-page-utils';
	import type { KpiItem, TableColumn } from '$lib/components/report/engagementReportConfig';

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
	let loadedPriorRows: BillingRow[] = [];
	let uniqueEmployers: string[] = [];

	let loading = false;
	let error: string | null = null;
	let progressText: string | null = null;
	let selectedEmployers: string[] = [];
	let selectedMonthLabel = '';

	const activeJobIds = new Set<string>();
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

	function toPreviousMonthLabel(monthYearLabel: string): string {
		const match = /^(\d{4})-(\d{2})$/.exec(monthYearLabel);
		if (!match) return getPreviousMonthLabel();

		const year = Number(match[1]);
		const month = Number(match[2]);
		if (month === 1) return `${year - 1}-12`;
		return `${year}-${String(month - 1).padStart(2, '0')}`;
	}

	function buildFilterOptions(): void {
		const employers = new Set<string>();
		for (const row of loadedRows) {
			if (row.employer) employers.add(row.employer);
		}
		uniqueEmployers = [...employers].sort((a, b) => a.localeCompare(b));
	}

	function filteredRows(): BillingRow[] {
		if (selectedEmployers.length === 0) return loadedRows;
		const selected = new Set(selectedEmployers);
		return loadedRows.filter((row) => Boolean(row.employer) && selected.has(row.employer as string));
	}

	function filteredPriorRows(): BillingRow[] {
		if (selectedEmployers.length === 0) return loadedPriorRows;
		const selected = new Set(selectedEmployers);
		return loadedPriorRows.filter((row) => Boolean(row.employer) && selected.has(row.employer as string));
	}

	function signed(value: number): string {
		return value > 0 ? `+${value}` : String(value);
	}

	function toDeltaKpi(label: string, current: number, prior: number): KpiItem {
		const deltaCount = current - prior;
		const deltaPct =
			prior === 0 ? (current === 0 ? '0.0%' : 'n/a') : `${signed(Number((((current - prior) / prior) * 100).toFixed(1)))}%`;
		const trend = deltaCount > 0 ? 'up' : deltaCount < 0 ? 'down' : 'flat';
		return {
			label,
			value: current,
			deltaLabel: signed(deltaCount),
			deltaPct,
			trend,
			points: [prior, current]
		};
	}

	function mapTopKpis(rows: BillingRow[], priorRows: BillingRow[]): KpiItem[] {
		const currentTotal = rows.length;
		const currentNewParticipants = rows.filter((row) => row.isNewParticipant).length;
		const currentEngaged = rows.filter((row) => row.engagedDuringMonth).length;

		const priorTotal = priorRows.length;
		const priorNewParticipants = priorRows.filter((row) => row.isNewParticipant).length;
		const priorEngaged = priorRows.filter((row) => row.engagedDuringMonth).length;

		return [
			toDeltaKpi('Total billable users', currentTotal, priorTotal),
			toDeltaKpi('New participants in month', currentNewParticipants, priorNewParticipants),
			toDeltaKpi('Engaged during month', currentEngaged, priorEngaged)
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

		const tableRows = rows.map((item) => {
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
			footerText: `Showing 1-${tableRows.length} of ${tableRows.length} entries`
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
		const priorRows = filteredPriorRows();
		topKpisOverride = mapTopKpis(rows, priorRows);
		bottomLeftLinesOverride = mapBottomLeft(loadedSummary, rows);
		bottomRightTableOverride = mapTable(rows);
	}

	function resetFilters(): void {
		selectedEmployers = [];
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
		let priorJobIdForCleanup = '';
		try {
			if (!isValidMonthLabel(selectedMonthLabel)) {
				throw new Error('Month must be in YYYY-MM format.');
			}

			const previousMonthLabel = toPreviousMonthLabel(selectedMonthLabel);

			const { jobId } = await runBillingJobUntilComplete({
				monthYearLabel: selectedMonthLabel,
				signal: controller.signal,
				onJobCreated: (createdJobId) => {
					activeJobIds.add(createdJobId);
					jobIdForCleanup = createdJobId;
				},
				onProgress: (progress) => {
					const p = progress?.progress ?? {};
					progressText = `Phase ${progress?.phase ?? 'running'} | conv pages ${p.conversationPagesFetched ?? 0} | participant pages ${p.participantPagesFetched ?? 0} | contacts remaining ${p.contactsRemaining ?? 0}`;
				}
			});
			jobIdForCleanup = jobId;

			progressText = 'Loading prior month comparison...';

			const { jobId: priorJobId } = await runBillingJobUntilComplete({
				monthYearLabel: previousMonthLabel,
				signal: controller.signal,
				onJobCreated: (createdJobId) => {
					activeJobIds.add(createdJobId);
					priorJobIdForCleanup = createdJobId;
				}
			});
			priorJobIdForCleanup = priorJobId;

			const [summary, rows, priorRows] = await Promise.all([
				fetchBillingView<BillingSummaryResponse>(jobId, 'summary', undefined, undefined, controller.signal),
				fetchAllBillingRows<BillingRow>({
					jobId,
					limit: 1000,
					signal: controller.signal,
					onPage: ({ loaded, total }) => {
						progressText = `Loading billing rows for filters ${loaded}${total != null ? ` / ${total}` : ''}...`;
					}
				}),
				fetchAllBillingRows<BillingRow>({
					jobId: priorJobId,
					limit: 1000,
					signal: controller.signal
				})
			]);

			loadedSummary = summary;
			loadedRows = rows;
			loadedPriorRows = priorRows;
			buildFilterOptions();
			recomputeDisplay();
		} catch (e: any) {
			error = e?.message ?? 'Unable to load billing report.';
			loadedSummary = null;
			loadedRows = [];
			loadedPriorRows = [];
			topKpisOverride = null;
			bottomLeftLinesOverride = null;
			bottomRightTableOverride = null;
		} finally {
			loading = false;
			progressText = null;
			if (jobIdForCleanup) {
				void cleanupBillingJob(jobIdForCleanup);
				activeJobIds.delete(jobIdForCleanup);
			}
			if (priorJobIdForCleanup) {
				void cleanupBillingJob(priorJobIdForCleanup);
				activeJobIds.delete(priorJobIdForCleanup);
			}
		}
	}

	$: if (loadedSummary) {
		selectedEmployers;
		recomputeDisplay();
	}

	onMount(() => {
		controller = new AbortController();
		selectedMonthLabel = readMonthLabelFromQuery() ?? getPreviousMonthLabel();
		void loadBilling();
	});

	onDestroy(() => {
		controller?.abort();
		for (const jobId of activeJobIds) {
			void cleanupBillingJob(jobId, true);
		}
		activeJobIds.clear();
	});
</script>

<div class="space-y-4">
	<Card.Root>
		<Card.Header class="pb-3">
			<Card.Title class="text-base">Billing Filters</Card.Title>
		</Card.Header>
		<Card.Content class="space-y-4">
			<div class="grid gap-3 md:grid-cols-2">
				<div class="space-y-1">
					<label class="text-xs font-medium text-muted-foreground" for="monthYearLabel">Billing Month</label>
					<Input id="monthYearLabel" type="month" bind:value={selectedMonthLabel} />
				</div>
				<div class="space-y-1">
					<p class="text-xs font-medium text-muted-foreground">Employer</p>
					<MultiSelectDropdown
						placeholder="All employers"
						options={uniqueEmployers.map((employer) => ({ value: employer, label: employer }))}
						bind:selected={selectedEmployers}
					/>
				</div>
			</div>

			<div class="flex items-center gap-2">
				<Button onclick={loadBilling} disabled={loading}>
					{loading ? 'Loading...' : 'Run'}
				</Button>
				<Button variant="outline" onclick={resetFilters} disabled={loading}>Reset</Button>
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
