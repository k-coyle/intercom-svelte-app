<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import ReportCanvas from '$lib/components/report/ReportCanvas.svelte';
	import LoadStatus from '$lib/components/report/LoadStatus.svelte';
	import MultiSelectDropdown from '$lib/components/report/MultiSelectDropdown.svelte';
	import * as Card from '$lib/components/ui/card';
	import { Input } from '$lib/components/ui/input';
	import { Button } from '$lib/components/ui/button';
	import {
		beaconCleanupCaseloadJob,
		cleanupCaseloadJob,
		fetchAllCaseloadViewItems,
		fetchCaseloadViewPage,
		runCaseloadJobUntilComplete
	} from '$lib/client/caseload-job';
	import { buildShareKpi, formatIsoDate, formatUnixDate } from '$lib/client/report-page-utils';
	import { DEFAULT_CASELOAD_LOOKBACK_DAYS } from '$lib/client/report-defaults';
	import { MAX_LOOKBACK_DAYS, parseLookbackDays } from '$lib/client/report-utils';
	import type { KpiItem, TableColumn } from '$lib/components/report/engagementReportConfig';

	const DEFAULT_LOOKBACK_DAYS = DEFAULT_CASELOAD_LOOKBACK_DAYS;
	const ALL_CHANNELS = ['Phone', 'Video Conference', 'Email', 'Chat'] as const;

	type SessionChannel = (typeof ALL_CHANNELS)[number];

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
		coachIds: string[];
		coachNames: string[];
		channelsUsed: SessionChannel[];
		channelCombo: string;
		lastSessionAt: number;
		daysSinceLastSession: number;
		buckets: CaseloadMemberBuckets;
	};

	let bottomLeftLinesOverride: string[] | null = null;
	let topKpisOverride: KpiItem[] | null = null;
	let bottomRightTableOverride: {
		title?: string;
		columns?: TableColumn[];
		rows?: Record<string, any>[];
		footerText?: string;
	} | null = null;

	let reportSummary: CaseloadSummaryResponse | null = null;
	let loadedMembers: CaseloadMemberRow[] = [];

	let selectedLookbackDays = String(DEFAULT_LOOKBACK_DAYS);
	let selectedCoachIds: string[] = [];
	let selectedClients: string[] = [];
	let selectedChannelValues: SessionChannel[] = [...ALL_CHANNELS];

	let uniqueCoaches: Array<{ id: string; name: string }> = [];
	let uniqueClients: string[] = [];
	let loading = false;
	let error: string | null = null;
	let progressText: string | null = null;

	let activeJobId = '';
	let controller: AbortController | null = null;

	function getBucketLabel(buckets: CaseloadMemberBuckets): string {
		if (buckets.bucket_1) return '<= 7d';
		if (buckets.bucket_2) return '8-28d';
		if (buckets.bucket_3) return '29-56d';
		if (buckets.bucket_4) return '> 56d';
		return '-';
	}

	function mapBottomLeft(summary: CaseloadSummaryResponse, filteredMembers: CaseloadMemberRow[]): string[] {
		const bucket_1 = filteredMembers.filter((m) => m.buckets.bucket_1).length;
		const bucket_2 = filteredMembers.filter((m) => m.buckets.bucket_2).length;
		const bucket_3 = filteredMembers.filter((m) => m.buckets.bucket_3).length;
		const bucket_4 = filteredMembers.filter((m) => m.buckets.bucket_4).length;

		return [
			`Lookback window: last ${summary.lookbackDays} days`,
			`Generated at: ${formatIsoDate(summary.generatedAt)}`,
			`Filtered members: ${filteredMembers.length} of ${loadedMembers.length}`,
			`Qualifying sessions: ${summary.counts?.sessions ?? 0}`,
			`Bucket 1 (<= 7d): ${bucket_1}`,
			`Bucket 2 (8-28d): ${bucket_2}`,
			`Bucket 3 (29-56d): ${bucket_3}`,
			`Bucket 4 (> 56d): ${bucket_4}`
		];
	}

	function mapTopKpis(filteredMembers: CaseloadMemberRow[]): KpiItem[] {
		const bucket1 = filteredMembers.filter((m) => m.buckets.bucket_1).length;
		const bucket2 = filteredMembers.filter((m) => m.buckets.bucket_2).length;
		const bucket3 = filteredMembers.filter((m) => m.buckets.bucket_3).length;
		const bucket4 = filteredMembers.filter((m) => m.buckets.bucket_4).length;
		const total = filteredMembers.length;

		return [
			buildShareKpi('Active in <= 7 days', bucket1, total, [bucket1, bucket1, bucket1]),
			buildShareKpi('8-28 days since session', bucket2, total, [bucket2, bucket2, bucket2]),
			buildShareKpi('29-56 days since session', bucket3, total, [bucket3, bucket3, bucket3]),
			buildShareKpi('> 56 days since session', bucket4, total, [bucket4, bucket4, bucket4])
		];
	}

	function mapTable(members: CaseloadMemberRow[]): {
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

		const rows = members.map((item) => ({
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

		return {
			title: 'Caseload Member Detail',
			columns,
			rows,
			footerText: `Showing 1-${rows.length} of ${rows.length} entries`
		};
	}

	function buildFilterOptions(): void {
		const coachById = new Map<string, string>();
		const clientSet = new Set<string>();

		for (const member of loadedMembers) {
			member.coachIds.forEach((id, idx) => {
				if (!coachById.has(id)) {
					coachById.set(id, member.coachNames[idx] ?? id);
				}
			});
			if (member.client) clientSet.add(member.client);
		}

		uniqueCoaches = [...coachById.entries()]
			.map(([id, name]) => ({ id, name }))
			.sort((a, b) => a.name.localeCompare(b.name));
		uniqueClients = [...clientSet].sort((a, b) => a.localeCompare(b));
	}

	function filteredMembers(): CaseloadMemberRow[] {
		let members = loadedMembers;

		if (selectedCoachIds.length > 0) {
			const selected = new Set(selectedCoachIds);
			members = members.filter((m) => m.coachIds.some((id) => selected.has(id)));
		}

		if (selectedClients.length > 0) {
			const selected = new Set(selectedClients);
			members = members.filter((m) => Boolean(m.client) && selected.has(m.client as string));
		}

		if (selectedChannelValues.length !== ALL_CHANNELS.length) {
			const selected = new Set(selectedChannelValues);
			members = members.filter((m) => m.channelsUsed.some((ch) => selected.has(ch)));
		}

		const parsedLookback = Number(selectedLookbackDays);
		if (Number.isFinite(parsedLookback) && parsedLookback > 0) {
			members = members.filter((m) => m.daysSinceLastSession <= parsedLookback);
		}

		return [...members].sort((a, b) => b.lastSessionAt - a.lastSessionAt);
	}

	function recomputeDisplay(): void {
		if (!reportSummary) {
			topKpisOverride = null;
			bottomLeftLinesOverride = null;
			bottomRightTableOverride = null;
			return;
		}

		const members = filteredMembers();
		topKpisOverride = mapTopKpis(members);
		bottomLeftLinesOverride = mapBottomLeft(reportSummary, members);
		bottomRightTableOverride = mapTable(members);
	}

	function resetFilters(): void {
		selectedCoachIds = [];
		selectedClients = [];
		selectedChannelValues = [...ALL_CHANNELS];
	}

	async function loadCaseload(): Promise<void> {
		if (!controller) return;

		loading = true;
		error = null;
		progressText = 'Starting caseload job...';

		let jobIdForCleanup = '';
		try {
			const lookbackDays = parseLookbackDays(selectedLookbackDays);
			selectedLookbackDays = String(lookbackDays);

			const { jobId } = await runCaseloadJobUntilComplete({
				lookbackDays,
				signal: controller.signal,
				onJobCreated: (createdJobId) => {
					activeJobId = createdJobId;
					jobIdForCleanup = createdJobId;
				},
				onProgress: (progress) => {
					const p = progress?.progress ?? {};
					progressText = `Phase ${progress?.phase ?? 'running'} | pages ${p.pagesFetched ?? 0} | members ${p.uniqueMembers ?? 0} | dup conv skipped ${p.duplicateConversationsSkipped ?? 0}`;
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
				fetchAllCaseloadViewItems<CaseloadMemberRow>({
					jobId,
					view: 'members',
					limit: 1000,
					signal: controller.signal,
					onPage: ({ loaded, total }) => {
						progressText = `Loading member rows for filters ${loaded}${total != null ? ` / ${total}` : ''}...`;
					}
				})
			]);

			reportSummary = summary;
			loadedMembers = members;
			buildFilterOptions();
			recomputeDisplay();
		} catch (e: any) {
			error = e?.message ?? 'Unable to load caseload report.';
			reportSummary = null;
			loadedMembers = [];
			topKpisOverride = null;
			bottomLeftLinesOverride = null;
			bottomRightTableOverride = null;
		} finally {
			loading = false;
			progressText = null;
			if (jobIdForCleanup) {
				void cleanupCaseloadJob(jobIdForCleanup);
				if (activeJobId === jobIdForCleanup) activeJobId = '';
			}
		}
	}

	$: if (reportSummary) {
		selectedCoachIds;
		selectedClients;
		selectedLookbackDays;
		selectedChannelValues;
		recomputeDisplay();
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

<div class="space-y-4">
	<Card.Root>
		<Card.Header class="pb-3">
			<Card.Title class="text-base">Caseload Filters</Card.Title>
		</Card.Header>
		<Card.Content class="space-y-4">
			<div class="grid gap-3 md:grid-cols-4">
				<div class="space-y-1">
					<label class="text-xs font-medium text-muted-foreground" for="lookbackDays">Lookback Days</label>
					<Input id="lookbackDays" type="number" min="1" max={MAX_LOOKBACK_DAYS} bind:value={selectedLookbackDays} />
				</div>
				<div class="space-y-1">
					<p class="text-xs font-medium text-muted-foreground">Coach</p>
					<MultiSelectDropdown
						placeholder="All coaches"
						options={uniqueCoaches.map((coach) => ({ value: coach.id, label: coach.name }))}
						bind:selected={selectedCoachIds}
					/>
				</div>
				<div class="space-y-1">
					<p class="text-xs font-medium text-muted-foreground">Client</p>
					<MultiSelectDropdown
						placeholder="All clients"
						options={uniqueClients.map((client) => ({ value: client, label: client }))}
						bind:selected={selectedClients}
					/>
				</div>
				<div class="space-y-1">
					<p class="text-xs font-medium text-muted-foreground">Channel</p>
					<MultiSelectDropdown
						placeholder="All channels"
						options={ALL_CHANNELS.map((channel) => ({ value: channel, label: channel }))}
						bind:selected={selectedChannelValues}
					/>
				</div>
			</div>

			<div class="flex items-center gap-2">
				<Button onclick={loadCaseload} disabled={loading}>
					{loading ? 'Loading...' : 'Run'}
				</Button>
				<Button variant="outline" onclick={resetFilters} disabled={loading}>Reset</Button>
			</div>

			<LoadStatus {loading} {error} {progressText} />
		</Card.Content>
	</Card.Root>

	<ReportCanvas
		reportKey="caseload"
		disableFallback={true}
		{topKpisOverride}
		{bottomLeftLinesOverride}
		{bottomRightTableOverride}
	/>
</div>
