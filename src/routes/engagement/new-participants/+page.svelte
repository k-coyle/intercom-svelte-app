<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import ReportCanvas from '$lib/components/report/ReportCanvas.svelte';
	import LoadStatus from '$lib/components/report/LoadStatus.svelte';
	import * as Card from '$lib/components/ui/card';
	import { Input } from '$lib/components/ui/input';
	import { Button } from '$lib/components/ui/button';
	import {
		fetchAllNewParticipantsRows,
		cleanupNewParticipantsJob,
		fetchNewParticipantsView,
		runNewParticipantsJobUntilComplete
	} from '$lib/client/new-participants-job';
	import { DEFAULT_NEW_PARTICIPANTS_LOOKBACK_DAYS } from '$lib/client/report-defaults';
	import { buildShareKpi, formatIsoDate, formatUnixDate } from '$lib/client/report-page-utils';
	import { MAX_LOOKBACK_DAYS, parseLookbackDays } from '$lib/client/report-utils';
	import type { KpiItem, TableColumn } from '$lib/components/report/engagementReportConfig';

	const DEFAULT_LOOKBACK_DAYS = DEFAULT_NEW_PARTICIPANTS_LOOKBACK_DAYS;
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
		coachIds: string[];
		coachNames: string[];
		buckets: {
			gt_14_to_21: boolean;
			gt_21_to_28: boolean;
			gt_28: boolean;
		};
	};

	let topKpisOverride: KpiItem[] | null = null;
	let bottomLeftLinesOverride: string[] | null = null;
	let bottomRightTableOverride: {
		title?: string;
		columns?: TableColumn[];
		rows?: Record<string, any>[];
		footerText?: string;
	} | null = null;

	let loadedSummary: NewParticipantsSummaryResponse | null = null;
	let loadedRows: NewParticipantsRow[] = [];
	let loading = false;
	let error: string | null = null;
	let progressText: string | null = null;

	let selectedLookbackDays = String(DEFAULT_LOOKBACK_DAYS);
	let selectedCoachId = '';
	let selectedClient = '';
	let rangeStart = '';
	let rangeEnd = '';
	let uniqueCoaches: Array<{ id: string; name: string }> = [];
	let uniqueClients: string[] = [];

	let activeJobId = '';
	let controller: AbortController | null = null;

	function mapTopKpis(rows: NewParticipantsRow[]): KpiItem[] {
		const total = rows.length;
		const gt_14_to_21 = rows.filter((row) => row.buckets?.gt_14_to_21).length;
		const gt_21_to_28 = rows.filter((row) => row.buckets?.gt_21_to_28).length;
		const gt_28 = rows.filter((row) => row.buckets?.gt_28).length;

		return [
			buildShareKpi('15-21 days without session', gt_14_to_21, total),
			buildShareKpi('22-28 days without session', gt_21_to_28, total),
			buildShareKpi('> 28 days without session', gt_28, total)
		];
	}

	function mapBottomLeft(summary: NewParticipantsSummaryResponse, rows: NewParticipantsRow[]): string[] {
		const gt_14_to_21 = rows.filter((row) => row.buckets?.gt_14_to_21).length;
		const gt_21_to_28 = rows.filter((row) => row.buckets?.gt_21_to_28).length;
		const gt_28 = rows.filter((row) => row.buckets?.gt_28).length;

		return [
			`Lookback window: last ${summary.lookbackDays} days`,
			`Generated at: ${formatIsoDate(summary.generatedAt)}`,
			`Filtered participants: ${rows.length} of ${loadedRows.length}`,
			`15-21 days without session: ${gt_14_to_21}`,
			`22-28 days without session: ${gt_21_to_28}`,
			`> 28 days without session: ${gt_28}`
		];
	}

	function mapTable(data: NewParticipantsRow[]): {
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

		const rows = data.slice(0, TABLE_LIMIT).map((item) => ({
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
			footerText: `Showing 1-${shown} of ${data.length} entries`
		};
	}

	function buildFilterOptions(): void {
		const coachById = new Map<string, string>();
		const clientSet = new Set<string>();

		for (const row of loadedRows) {
			row.coachIds.forEach((id, index) => {
				if (!coachById.has(id)) {
					coachById.set(id, row.coachNames[index] ?? id);
				}
			});

			if (row.client) {
				clientSet.add(row.client);
			}
		}

		uniqueCoaches = [...coachById.entries()]
			.map(([id, name]) => ({ id, name }))
			.sort((a, b) => a.name.localeCompare(b.name));
		uniqueClients = [...clientSet].sort((a, b) => a.localeCompare(b));
	}

	function filteredRows(): NewParticipantsRow[] {
		let rows = loadedRows;

		if (selectedCoachId) {
			rows = rows.filter((row) => row.coachIds.includes(selectedCoachId));
		}

		if (selectedClient) {
			rows = rows.filter((row) => row.client === selectedClient);
		}

		if (rangeStart) {
			const startUnix = Math.floor(Date.parse(rangeStart) / 1000);
			rows = rows.filter((row) => row.participantAt != null && row.participantAt >= startUnix);
		}

		if (rangeEnd) {
			const endUnix = Math.floor(Date.parse(rangeEnd) / 1000) + 24 * 60 * 60;
			rows = rows.filter((row) => row.participantAt != null && row.participantAt < endUnix);
		}

		return [...rows].sort((a, b) => {
			const aDays = a.daysWithoutSession ?? -1;
			const bDays = b.daysWithoutSession ?? -1;
			return bDays - aDays;
		});
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
		selectedCoachId = '';
		selectedClient = '';
		rangeStart = '';
		rangeEnd = '';
	}

	async function loadNewParticipants(): Promise<void> {
		if (!controller) return;

		loading = true;
		error = null;
		progressText = 'Starting enrolled participants job...';

		let jobIdForCleanup = '';
		try {
			const lookbackDays = parseLookbackDays(selectedLookbackDays);
			selectedLookbackDays = String(lookbackDays);

			const { jobId } = await runNewParticipantsJobUntilComplete({
				lookbackDays,
				signal: controller.signal,
				onJobCreated: (createdJobId) => {
					activeJobId = createdJobId;
					jobIdForCleanup = createdJobId;
				},
				onProgress: (progress) => {
					const p = progress?.progress ?? {};
					progressText = `Phase ${progress?.phase ?? 'running'} | participant pages ${p.participantPagesFetched ?? 0} | conversation pages ${p.conversationPagesFetched ?? 0}`;
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
				fetchAllNewParticipantsRows<NewParticipantsRow>({
					jobId,
					limit: 1000,
					signal: controller.signal,
					onPage: ({ loaded, total }) => {
						progressText = `Loading participant rows for filters ${loaded}${total != null ? ` / ${total}` : ''}...`;
					}
				})
			]);

			loadedSummary = summary;
			loadedRows = rows;
			buildFilterOptions();
			recomputeDisplay();
		} catch (e: any) {
			error = e?.message ?? 'Unable to load enrolled participants report.';
			loadedSummary = null;
			loadedRows = [];
			topKpisOverride = null;
			bottomLeftLinesOverride = null;
			bottomRightTableOverride = null;
		} finally {
			loading = false;
			progressText = null;
			if (jobIdForCleanup) {
				void cleanupNewParticipantsJob(jobIdForCleanup);
				if (activeJobId === jobIdForCleanup) activeJobId = '';
			}
		}
	}

	$: if (loadedSummary) {
		selectedCoachId;
		selectedClient;
		rangeStart;
		rangeEnd;
		recomputeDisplay();
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

<div class="space-y-4">
	<Card.Root>
		<Card.Header class="pb-3">
			<Card.Title class="text-base">Enrolled Filters</Card.Title>
			<Card.Description>Restore legacy enrolled participants filters.</Card.Description>
		</Card.Header>
		<Card.Content class="space-y-4">
			<div class="grid gap-3 md:grid-cols-4">
				<div class="space-y-1">
					<label class="text-xs font-medium text-muted-foreground" for="lookbackDays">Lookback Days</label>
					<Input id="lookbackDays" type="number" min="1" max={MAX_LOOKBACK_DAYS} bind:value={selectedLookbackDays} />
				</div>
				<div class="space-y-1">
					<label class="text-xs font-medium text-muted-foreground" for="coachFilter">Coach</label>
					<select
						id="coachFilter"
						class="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
						bind:value={selectedCoachId}
					>
						<option value="">All coaches</option>
						{#each uniqueCoaches as coach}
							<option value={coach.id}>{coach.name}</option>
						{/each}
					</select>
				</div>
				<div class="space-y-1">
					<label class="text-xs font-medium text-muted-foreground" for="clientFilter">Client</label>
					<select
						id="clientFilter"
						class="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
						bind:value={selectedClient}
					>
						<option value="">All clients</option>
						{#each uniqueClients as client}
							<option value={client}>{client}</option>
						{/each}
					</select>
				</div>
				<div class="flex items-end gap-2">
					<Button class="w-full" onclick={loadNewParticipants} disabled={loading}>
						{loading ? 'Loading...' : 'Run'}
					</Button>
					<Button variant="outline" onclick={resetFilters} disabled={loading}>Reset</Button>
				</div>
			</div>

			<div class="grid gap-3 md:grid-cols-2">
				<div class="space-y-1">
					<label class="text-xs font-medium text-muted-foreground" for="rangeStart">Enrolled Start</label>
					<Input id="rangeStart" type="date" bind:value={rangeStart} />
				</div>
				<div class="space-y-1">
					<label class="text-xs font-medium text-muted-foreground" for="rangeEnd">Enrolled End</label>
					<Input id="rangeEnd" type="date" bind:value={rangeEnd} />
				</div>
			</div>

			<LoadStatus {loading} {error} {progressText} />
		</Card.Content>
	</Card.Root>

	<ReportCanvas
		reportKey="enrolled"
		disableFallback={true}
		{topKpisOverride}
		{bottomLeftLinesOverride}
		{bottomRightTableOverride}
	/>
</div>

