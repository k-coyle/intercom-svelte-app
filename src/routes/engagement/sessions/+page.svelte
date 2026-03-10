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
		runCaseloadJobUntilComplete
	} from '$lib/client/caseload-job';
	import { DEFAULT_SESSIONS_LOOKBACK_DAYS } from '$lib/client/report-defaults';
	import { formatUnixDate } from '$lib/client/report-page-utils';
	import { MAX_LOOKBACK_DAYS, parseLookbackDays } from '$lib/client/report-utils';
	import type { KpiItem, TableColumn } from '$lib/components/report/engagementReportConfig';

	const DEFAULT_LOOKBACK_DAYS = DEFAULT_SESSIONS_LOOKBACK_DAYS;
	const ALL_CHANNELS = ['Phone', 'Video Conference', 'Email', 'Chat'] as const;
	const SECONDS_PER_DAY = 24 * 60 * 60;

	type SessionChannel = (typeof ALL_CHANNELS)[number];

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
	let pageMetaLinesOverride: string[] | null = null;
	let bottomRightTableOverride: {
		title?: string;
		columns?: TableColumn[];
		rows?: Record<string, any>[];
		footerText?: string;
	} | null = null;

	let loadedSessions: SessionDetailRow[] = [];
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

	function buildSparkline(values: number[]): number[] {
		if (!values.length) return [0, 0, 0];
		const points = values.slice(-12);
		while (points.length < 12) {
			points.unshift(points[0] ?? 0);
		}
		return points;
	}

	function mapTopKpis(sessions: SessionDetailRow[], lookbackDays: number): KpiItem[] {
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
				deltaPct: `${lookbackDays}d`,
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

	function mapPageMeta(sessions: SessionDetailRow[], lookbackDays: number): string[] {
		const uniqueMembers = new Set(sessions.map((s) => s.memberId)).size;
		const uniqueCoaches = new Set(
			sessions.map((s) => s.coachId).filter((id): id is string => Boolean(id))
		).size;
		const uniqueClients = new Set(
			sessions.map((s) => s.client).filter((v): v is string => Boolean(v))
		).size;

		return [
			`Lookback window: last ${lookbackDays} days`,
			`Filtered sessions: ${sessions.length} of ${loadedSessions.length}`,
			`Unique members: ${uniqueMembers}`,
			`Unique coaches: ${uniqueCoaches}`,
			`Unique clients: ${uniqueClients}`
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
		const rows = sorted.map((s) => {
			const daysSince =
				s.daysSince != null && Number.isFinite(s.daysSince)
					? s.daysSince
					: (Math.floor(Date.now() / 1000) - s.time) / SECONDS_PER_DAY;

			return {
				time: formatUnixDate(s.time, true),
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
			footerText: `Showing 1-${rows.length} of ${rows.length} entries`
		};
	}

	function buildFilterOptions(): void {
		const coachById = new Map<string, string>();
		const clientSet = new Set<string>();

		for (const session of loadedSessions) {
			if (session.coachId) {
				coachById.set(session.coachId, session.coachName ?? session.coachId);
			}
			if (session.client) {
				clientSet.add(session.client);
			}
		}

		uniqueCoaches = [...coachById.entries()]
			.map(([id, name]) => ({ id, name }))
			.sort((a, b) => a.name.localeCompare(b.name));
		uniqueClients = [...clientSet].sort((a, b) => a.localeCompare(b));
	}

	function filteredSessions(): SessionDetailRow[] {
		let sessions = loadedSessions;

		if (selectedCoachIds.length > 0) {
			const selected = new Set(selectedCoachIds);
			sessions = sessions.filter((s) => Boolean(s.coachId) && selected.has(s.coachId as string));
		}

		if (selectedClients.length > 0) {
			const selected = new Set(selectedClients);
			sessions = sessions.filter((s) => Boolean(s.client) && selected.has(s.client as string));
		}

		if (selectedChannelValues.length !== ALL_CHANNELS.length) {
			const selected = new Set(selectedChannelValues);
			sessions = sessions.filter((s) => selected.has(s.channel));
		}

		const parsedLookback = Number(selectedLookbackDays);
		if (Number.isFinite(parsedLookback) && parsedLookback > 0) {
			sessions = sessions.filter((s) => {
				const daysSince = (Math.floor(Date.now() / 1000) - s.time) / SECONDS_PER_DAY;
				return daysSince <= parsedLookback;
			});
		}

		return sessions;
	}

	function recomputeDisplay(): void {
		if (!loadedSessions.length) {
			topKpisOverride = null;
			pageMetaLinesOverride = null;
			bottomRightTableOverride = null;
			return;
		}

		const sessions = filteredSessions();
		const lookbackDays = Number(selectedLookbackDays) || DEFAULT_LOOKBACK_DAYS;
		topKpisOverride = mapTopKpis(sessions, lookbackDays);
		pageMetaLinesOverride = mapPageMeta(sessions, lookbackDays);
		bottomRightTableOverride = mapTable(sessions);
	}

	function resetFilters(): void {
		selectedCoachIds = [];
		selectedClients = [];
		selectedChannelValues = [...ALL_CHANNELS];
	}

	async function loadSessions(): Promise<void> {
		if (!controller) return;

		loading = true;
		error = null;
		progressText = 'Starting sessions job...';

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
					progressText = `Phase ${progress?.phase ?? 'running'} | pages ${p.pagesFetched ?? 0} | sessions ${p.sessionsCount ?? 0} | dup conv skipped ${p.duplicateConversationsSkipped ?? 0}`;
				}
			});
			jobIdForCleanup = jobId;

			const sessions = await fetchAllCaseloadViewItems<SessionDetailRow>({
				jobId,
				view: 'sessions',
				limit: 750,
				signal: controller.signal,
				onPage: ({ loaded, total }) => {
					progressText = `Loading session rows for filters ${loaded}${total != null ? ` / ${total}` : ''}...`;
				}
			});

			loadedSessions = sessions;
			buildFilterOptions();
			recomputeDisplay();
		} catch (e: any) {
			error = e?.message ?? 'Unable to load sessions report.';
			loadedSessions = [];
			topKpisOverride = null;
			pageMetaLinesOverride = null;
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

	$: if (loadedSessions.length) {
		selectedCoachIds;
		selectedClients;
		selectedLookbackDays;
		selectedChannelValues;
		recomputeDisplay();
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

<div class="space-y-4">
	<Card.Root>
		<Card.Header class="pb-3">
			<Card.Title class="text-base">Sessions Filters</Card.Title>
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
				<Button variant="destructive" class="bg-red-700 text-white hover:bg-red-600 border-red-700" onclick={loadSessions} disabled={loading}>
					{loading ? 'Loading...' : 'Run'}
				</Button>
				<Button variant="outline" onclick={resetFilters} disabled={loading}>Reset</Button>
			</div>

			<LoadStatus {loading} {error} {progressText} />
		</Card.Content>
	</Card.Root>

	<ReportCanvas
		reportKey="sessions"
		disableFallback={true}
		hideMidLeftPanel={true}
		hideMidRightPanel={true}
		hideBottomLeftPanel={true}
		{topKpisOverride}
		{pageMetaLinesOverride}
		{bottomRightTableOverride}
	/>
</div>
