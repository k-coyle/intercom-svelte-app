import fs from 'node:fs/promises';
import path from 'node:path';

export type HistoryRunStatus = 'success' | 'failed';

export interface HistoryRunEntry {
	id: string;
	endpoint: string;
	method: string;
	status: HistoryRunStatus;
	httpStatus: number;
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	errorMessage: string | null;
}

export interface EndpointHistorySummary {
	endpoint: string;
	lastHitAt: string | null;
	lastStatus: HistoryRunStatus | null;
	lastHttpStatus: number | null;
	lastDurationMs: number | null;
	lastErrorMessage: string | null;
	lastSuccessAt: string | null;
	consecutiveFailureCount: number;
	totalRuns: number;
}

interface HistoryFile {
	version: 1;
	updatedAt: string;
	runs: HistoryRunEntry[];
}

const HISTORY_MAX_RUNS = 750;
const HISTORY_FILE_PATH = path.resolve('.report-history', 'api-history.json');

const TRACKED_ENDPOINTS = [
	'/API/engagement/overview',
	'/API/engagement/caseload',
	'/API/engagement/new-participants',
	'/API/engagement/billing',
	'/API/engagement/engagement-sync',
	'/API/engagement/session-sync',
	'/API/engagement/referral-sync',
	'/API/engagement/report/engagement',
	'/API/engagement/report/conversations',
	'/API/sd/enrollments',
	'/API/sd/coaching-activity',
	'/API/sd/scheduling'
] as const;

const EMPTY_HISTORY: HistoryFile = {
	version: 1,
	updatedAt: new Date(0).toISOString(),
	runs: []
};

let writeQueue: Promise<void> = Promise.resolve();

function trimErrorMessage(raw: unknown): string | null {
	if (raw == null) return null;
	const text = String(raw).trim();
	if (!text) return null;
	return text.slice(0, 500);
}

function coerceHistoryFile(raw: unknown): HistoryFile {
	if (!raw || typeof raw !== 'object') return { ...EMPTY_HISTORY, runs: [] };

	const input = raw as { version?: unknown; updatedAt?: unknown; runs?: unknown };
	const runsRaw = Array.isArray(input.runs) ? input.runs : [];
	const runs: HistoryRunEntry[] = [];

	for (const item of runsRaw) {
		if (!item || typeof item !== 'object') continue;
		const run = item as Partial<HistoryRunEntry>;
		const endpoint = typeof run.endpoint === 'string' ? run.endpoint : '';
		const method = typeof run.method === 'string' ? run.method : 'UNKNOWN';
		const status = run.status === 'failed' ? 'failed' : run.status === 'success' ? 'success' : null;
		const httpStatus = Number(run.httpStatus);
		const startedAt = typeof run.startedAt === 'string' ? run.startedAt : null;
		const finishedAt = typeof run.finishedAt === 'string' ? run.finishedAt : null;
		const durationMs = Number(run.durationMs);

		if (!endpoint || !status || !startedAt || !finishedAt || !Number.isFinite(httpStatus)) continue;

		runs.push({
			id: typeof run.id === 'string' ? run.id : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			endpoint,
			method,
			status,
			httpStatus,
			startedAt,
			finishedAt,
			durationMs: Number.isFinite(durationMs) && durationMs >= 0 ? Math.round(durationMs) : 0,
			errorMessage: trimErrorMessage(run.errorMessage)
		});
	}

	return {
		version: input.version === 1 ? 1 : 1,
		updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : new Date(0).toISOString(),
		runs
	};
}

async function readHistoryFile(): Promise<HistoryFile> {
	try {
		const raw = await fs.readFile(HISTORY_FILE_PATH, 'utf8');
		return coerceHistoryFile(JSON.parse(raw));
	} catch (error: any) {
		if (error?.code === 'ENOENT') return { ...EMPTY_HISTORY, runs: [] };
		console.error('REPORT_HISTORY read_failed', error?.message ?? String(error));
		return { ...EMPTY_HISTORY, runs: [] };
	}
}

async function writeHistoryFile(data: HistoryFile): Promise<void> {
	const dir = path.dirname(HISTORY_FILE_PATH);
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(HISTORY_FILE_PATH, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function summarizeEndpoint(endpoint: string, runs: HistoryRunEntry[]): EndpointHistorySummary {
	const ordered = runs
		.filter((run) => run.endpoint === endpoint)
		.sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt));
	const latest = ordered[0] ?? null;
	const lastSuccess = ordered.find((run) => run.status === 'success') ?? null;

	let consecutiveFailureCount = 0;
	for (const run of ordered) {
		if (run.status === 'failed') {
			consecutiveFailureCount += 1;
			continue;
		}
		break;
	}

	return {
		endpoint,
		lastHitAt: latest?.finishedAt ?? null,
		lastStatus: latest?.status ?? null,
		lastHttpStatus: latest?.httpStatus ?? null,
		lastDurationMs: latest?.durationMs ?? null,
		lastErrorMessage: latest?.errorMessage ?? null,
		lastSuccessAt: lastSuccess?.finishedAt ?? null,
		consecutiveFailureCount,
		totalRuns: ordered.length
	};
}

export async function recordApiHistoryRun(input: {
	endpoint: string;
	method: string;
	httpStatus: number;
	status: HistoryRunStatus;
	startedAtMs: number;
	finishedAtMs?: number;
	errorMessage?: unknown;
}): Promise<void> {
	const finishedAtMs = input.finishedAtMs ?? Date.now();
	const startedAtMs = Math.min(input.startedAtMs, finishedAtMs);
	const durationMs = Math.max(0, finishedAtMs - startedAtMs);

	const entry: HistoryRunEntry = {
		id: `run-${finishedAtMs.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
		endpoint: input.endpoint,
		method: input.method.toUpperCase(),
		status: input.status,
		httpStatus: Math.max(0, Math.floor(input.httpStatus)),
		startedAt: new Date(startedAtMs).toISOString(),
		finishedAt: new Date(finishedAtMs).toISOString(),
		durationMs,
		errorMessage: trimErrorMessage(input.errorMessage)
	};

	writeQueue = writeQueue
		.then(async () => {
			const history = await readHistoryFile();
			const nextRuns = [...history.runs, entry];
			const boundedRuns =
				nextRuns.length > HISTORY_MAX_RUNS ? nextRuns.slice(nextRuns.length - HISTORY_MAX_RUNS) : nextRuns;

			await writeHistoryFile({
				version: 1,
				updatedAt: entry.finishedAt,
				runs: boundedRuns
			});
		})
		.catch((error: any) => {
			console.error('REPORT_HISTORY write_failed', error?.message ?? String(error));
		});

	await writeQueue;
}

export async function getApiHistorySnapshot(limit = 120): Promise<{
	filePath: string;
	updatedAt: string;
	totalRuns: number;
	endpoints: EndpointHistorySummary[];
	recentRuns: HistoryRunEntry[];
}> {
	await writeQueue;
	const history = await readHistoryFile();
	const allEndpoints = new Set<string>(TRACKED_ENDPOINTS);
	for (const run of history.runs) allEndpoints.add(run.endpoint);

	const endpoints = Array.from(allEndpoints)
		.sort((a, b) => a.localeCompare(b))
		.map((endpoint) => summarizeEndpoint(endpoint, history.runs));

	const safeLimit = Math.min(1000, Math.max(1, Math.floor(limit)));
	const recentRuns = [...history.runs]
		.sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt))
		.slice(0, safeLimit);

	return {
		filePath: HISTORY_FILE_PATH,
		updatedAt: history.updatedAt,
		totalRuns: history.runs.length,
		endpoints,
		recentRuns
	};
}
