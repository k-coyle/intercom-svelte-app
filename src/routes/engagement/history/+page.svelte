<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';

	type HistoryRunStatus = 'success' | 'failed';

	type EndpointHistorySummary = {
		endpoint: string;
		lastHitAt: string | null;
		lastStatus: HistoryRunStatus | null;
		lastHttpStatus: number | null;
		lastDurationMs: number | null;
		lastErrorMessage: string | null;
		lastSuccessAt: string | null;
		consecutiveFailureCount: number;
		totalRuns: number;
	};

	type HistoryRunEntry = {
		id: string;
		endpoint: string;
		method: string;
		status: HistoryRunStatus;
		httpStatus: number;
		startedAt: string;
		finishedAt: string;
		durationMs: number;
		errorMessage: string | null;
	};

	type HistoryResponse = {
		generatedAt: string;
		buildInfo?: {
			version: string;
			commitHash: string | null;
			commitShort: string | null;
			branch: string | null;
			commitTimestamp: string | null;
			buildTimestamp: string | null;
			treeState: 'clean' | 'dirty' | 'unknown';
			source: string;
		};
		filePath: string;
		storageMode?: 'file' | 'memory';
		updatedAt: string;
		totalRuns: number;
		endpoints: EndpointHistorySummary[];
		recentRuns: HistoryRunEntry[];
	};

	const REFRESH_MS = 30_000;

	let loading = true;
	let refreshing = false;
	let error: string | null = null;
	let data: HistoryResponse | null = null;
	let refreshTimer: ReturnType<typeof setInterval> | null = null;

	function sortEndpoints(rows: EndpointHistorySummary[]): EndpointHistorySummary[] {
		const rank = (row: EndpointHistorySummary) => {
			if (row.lastStatus === 'failed') return 0;
			if (row.lastStatus === 'success') return 1;
			return 2;
		};

		return [...rows].sort((a, b) => {
			const r = rank(a) - rank(b);
			if (r !== 0) return r;
			const aTime = Date.parse(a.lastHitAt ?? '');
			const bTime = Date.parse(b.lastHitAt ?? '');
			if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) return bTime - aTime;
			return a.endpoint.localeCompare(b.endpoint);
		});
	}

	function formatTimestamp(value: string | null): string {
		if (!value) return 'Never';
		const ms = Date.parse(value);
		if (!Number.isFinite(ms)) return value;
		return new Date(ms).toLocaleString();
	}

	function formatDuration(value: number | null): string {
		if (value == null || !Number.isFinite(value)) return '-';
		if (value < 1000) return `${value} ms`;
		return `${(value / 1000).toFixed(2)} s`;
	}

	function formatCommit(value: string | null, short: string | null): string {
		if (short) return short;
		if (!value) return 'unknown';
		return value.slice(0, 12);
	}

	function statusClass(status: HistoryRunStatus | null): string {
		if (status === 'success') return 'bg-emerald-100 text-emerald-800';
		if (status === 'failed') return 'bg-rose-100 text-rose-800';
		return 'bg-slate-100 text-slate-600';
	}

	async function loadHistory(isRefresh = false): Promise<void> {
		if (isRefresh) refreshing = true;
		else loading = true;
		error = null;

		try {
			const res = await fetch('/API/engagement/history?limit=200');
			if (!res.ok) {
				throw new Error(`History request failed (${res.status})`);
			}

			const payload = (await res.json()) as HistoryResponse;
			payload.endpoints = sortEndpoints(payload.endpoints ?? []);
			payload.recentRuns = (payload.recentRuns ?? []).slice(0, 100);
			data = payload;
		} catch (e: any) {
			error = e?.message ?? String(e);
		} finally {
			loading = false;
			refreshing = false;
		}
	}

	$: endpointCount = data?.endpoints?.length ?? 0;
	$: failingCount = data?.endpoints?.filter((row) => row.lastStatus === 'failed').length ?? 0;
	$: neverRunCount = data?.endpoints?.filter((row) => row.lastHitAt == null).length ?? 0;

	onMount(() => {
		void loadHistory(false);
		refreshTimer = setInterval(() => {
			void loadHistory(true);
		}, REFRESH_MS);
	});

	onDestroy(() => {
		if (refreshTimer) clearInterval(refreshTimer);
	});
</script>

<section class="space-y-6 p-4 md:p-6">
	<div class="flex flex-wrap items-center justify-between gap-3">
		<div>
			<h1 class="text-2xl font-semibold tracking-tight">API History</h1>
			<p class="text-sm text-muted-foreground">Latest endpoint runs and recent failures.</p>
		</div>
		<Button onclick={() => void loadHistory(true)} disabled={loading || refreshing}>
			{refreshing ? 'Refreshing...' : 'Refresh'}
		</Button>
	</div>

	{#if error}
		<Card.Root class="border-rose-300">
			<Card.Content class="pt-6 text-sm text-rose-700">{error}</Card.Content>
		</Card.Root>
	{/if}

	<div class="grid grid-cols-1 gap-3 md:grid-cols-4">
		<Card.Root>
			<Card.Header>
				<Card.Title class="text-sm font-medium text-muted-foreground">Tracked Endpoints</Card.Title>
			</Card.Header>
			<Card.Content class="text-2xl font-semibold">{endpointCount}</Card.Content>
		</Card.Root>
		<Card.Root>
			<Card.Header>
				<Card.Title class="text-sm font-medium text-muted-foreground">Failing Endpoints</Card.Title>
			</Card.Header>
			<Card.Content class="text-2xl font-semibold">{failingCount}</Card.Content>
		</Card.Root>
		<Card.Root>
			<Card.Header>
				<Card.Title class="text-sm font-medium text-muted-foreground">Never Run</Card.Title>
			</Card.Header>
			<Card.Content class="text-2xl font-semibold">{neverRunCount}</Card.Content>
		</Card.Root>
		<Card.Root>
			<Card.Header>
				<Card.Title class="text-sm font-medium text-muted-foreground">Recorded Runs</Card.Title>
			</Card.Header>
			<Card.Content class="text-2xl font-semibold">{data?.totalRuns ?? 0}</Card.Content>
		</Card.Root>
	</div>

	<Card.Root>
		<Card.Header>
			<Card.Title>Build Info</Card.Title>
			<Card.Description>Version and git commit for the currently running deployment.</Card.Description>
		</Card.Header>
		<Card.Content class="grid gap-2 text-sm md:grid-cols-2">
			<div>
				<span class="text-muted-foreground">Version:</span>
				<code class="ml-1">{data?.buildInfo?.version ?? '-'}</code>
			</div>
			<div>
				<span class="text-muted-foreground">Commit:</span>
				<code class="ml-1">{formatCommit(data?.buildInfo?.commitHash ?? null, data?.buildInfo?.commitShort ?? null)}</code>
			</div>
			<div>
				<span class="text-muted-foreground">Branch:</span>
				<code class="ml-1">{data?.buildInfo?.branch ?? '-'}</code>
			</div>
			<div>
				<span class="text-muted-foreground">Tree:</span>
				<code class="ml-1">{data?.buildInfo?.treeState ?? 'unknown'}</code>
			</div>
			<div>
				<span class="text-muted-foreground">Commit Time:</span>
				<span class="ml-1">{formatTimestamp(data?.buildInfo?.commitTimestamp ?? null)}</span>
			</div>
			<div>
				<span class="text-muted-foreground">Build Time:</span>
				<span class="ml-1">{formatTimestamp(data?.buildInfo?.buildTimestamp ?? null)}</span>
			</div>
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title>Endpoint Status</Card.Title>
				<Card.Description>
					Last update: {formatTimestamp(data?.generatedAt ?? null)} | File:
					<code>{data?.filePath ?? '-'}</code> | Store:
					<code>{data?.storageMode ?? 'file'}</code>
				</Card.Description>
			</Card.Header>
		<Card.Content class="overflow-x-auto">
			{#if loading}
				<p class="text-sm text-muted-foreground">Loading endpoint history...</p>
			{:else}
				<table class="w-full min-w-[900px] text-left text-sm">
					<thead class="border-b text-xs uppercase text-muted-foreground">
						<tr>
							<th class="px-2 py-2">Endpoint</th>
							<th class="px-2 py-2">Last Hit</th>
							<th class="px-2 py-2">Status</th>
							<th class="px-2 py-2">HTTP</th>
							<th class="px-2 py-2">Duration</th>
							<th class="px-2 py-2">Last Success</th>
							<th class="px-2 py-2">Consecutive Failures</th>
							<th class="px-2 py-2">Last Error</th>
						</tr>
					</thead>
					<tbody>
						{#each data?.endpoints ?? [] as row}
							<tr class="border-b align-top">
								<td class="px-2 py-3 font-mono text-xs">{row.endpoint}</td>
								<td class="px-2 py-3">{formatTimestamp(row.lastHitAt)}</td>
								<td class="px-2 py-3">
									<span class={`rounded-full px-2 py-1 text-xs font-medium ${statusClass(row.lastStatus)}`}>
										{row.lastStatus ?? 'unknown'}
									</span>
								</td>
								<td class="px-2 py-3">{row.lastHttpStatus ?? '-'}</td>
								<td class="px-2 py-3">{formatDuration(row.lastDurationMs)}</td>
								<td class="px-2 py-3">{formatTimestamp(row.lastSuccessAt)}</td>
								<td class="px-2 py-3">{row.consecutiveFailureCount}</td>
								<td class="max-w-[320px] px-2 py-3 text-xs text-muted-foreground">
									{row.lastErrorMessage ?? '-'}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title>Recent Runs</Card.Title>
			<Card.Description>Most recent 100 API requests recorded.</Card.Description>
		</Card.Header>
		<Card.Content class="overflow-x-auto">
			<table class="w-full min-w-[900px] text-left text-sm">
				<thead class="border-b text-xs uppercase text-muted-foreground">
					<tr>
						<th class="px-2 py-2">Finished</th>
						<th class="px-2 py-2">Endpoint</th>
						<th class="px-2 py-2">Method</th>
						<th class="px-2 py-2">Status</th>
						<th class="px-2 py-2">HTTP</th>
						<th class="px-2 py-2">Duration</th>
						<th class="px-2 py-2">Error</th>
					</tr>
				</thead>
				<tbody>
					{#each data?.recentRuns ?? [] as run}
						<tr class="border-b align-top">
							<td class="px-2 py-3">{formatTimestamp(run.finishedAt)}</td>
							<td class="px-2 py-3 font-mono text-xs">{run.endpoint}</td>
							<td class="px-2 py-3">{run.method}</td>
							<td class="px-2 py-3">
								<span class={`rounded-full px-2 py-1 text-xs font-medium ${statusClass(run.status)}`}>
									{run.status}
								</span>
							</td>
							<td class="px-2 py-3">{run.httpStatus}</td>
							<td class="px-2 py-3">{formatDuration(run.durationMs)}</td>
							<td class="max-w-[300px] px-2 py-3 text-xs text-muted-foreground">
								{run.errorMessage ?? '-'}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</Card.Content>
	</Card.Root>
</section>
