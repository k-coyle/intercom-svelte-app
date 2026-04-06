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
const DEFAULT_HISTORY_FILE_PATH = path.resolve('.report-history', 'api-history.json');
const LAMBDA_HISTORY_FILE_PATH = path.resolve('/tmp', 'report-history', 'api-history.json');
const MEMORY_HISTORY_FILE_PATH = 'memory://report-history/api-history.json';

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
let storageMode: 'file' | 'memory' = 'file';
let historyFilePath = resolveInitialHistoryFilePath();
let memoryHistory: HistoryFile = { ...EMPTY_HISTORY, runs: [] };

function normalizePath(raw: unknown): string | null {
	const value = typeof raw === 'string' ? raw.trim() : '';
	return value ? path.resolve(value) : null;
}

function isLikelyLambdaRuntime(): boolean {
	return Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME || String(process.env.AWS_EXECUTION_ENV ?? '').includes('Lambda'));
}

function resolveInitialHistoryFilePath(): string {
	const envPath = normalizePath(process.env.REPORT_HISTORY_FILE_PATH);
	if (envPath) return envPath;
	if (isLikelyLambdaRuntime()) return LAMBDA_HISTORY_FILE_PATH;
	return DEFAULT_HISTORY_FILE_PATH;
}

function isFsWritePermissionError(error: any): boolean {
	const code = String(error?.code ?? '');
	return code === 'EACCES' || code === 'EPERM' || code === 'EROFS';
}

function trySwitchToLambdaPath(reason: unknown): boolean {
	if (historyFilePath === LAMBDA_HISTORY_FILE_PATH) return false;
	historyFilePath = LAMBDA_HISTORY_FILE_PATH;
	console.warn(
		'REPORT_HISTORY switched_to_lambda_tmp',
		String((reason as any)?.message ?? reason ?? 'filesystem permission error')
	);
	return true;
}

function inMemoryHistoryPath(): string {
	return storageMode === 'file' ? historyFilePath : MEMORY_HISTORY_FILE_PATH;
}

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
	if (storageMode === 'memory') return memoryHistory;

	try {
		const raw = await fs.readFile(historyFilePath, 'utf8');
		return coerceHistoryFile(JSON.parse(raw));
	} catch (error: any) {
		if (error?.code === 'ENOENT') return { ...EMPTY_HISTORY, runs: [] };
		if (isFsWritePermissionError(error) && trySwitchToLambdaPath(error)) {
			return readHistoryFile();
		}
		console.error('REPORT_HISTORY read_failed', error?.message ?? String(error));
		storageMode = 'memory';
		return memoryHistory;
	}
}

async function writeHistoryFile(data: HistoryFile): Promise<void> {
	if (storageMode === 'memory') {
		memoryHistory = data;
		return;
	}

	try {
		const dir = path.dirname(historyFilePath);
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(historyFilePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
		memoryHistory = data;
	} catch (error: any) {
		if (isFsWritePermissionError(error) && trySwitchToLambdaPath(error)) {
			await writeHistoryFile(data);
			return;
		}
		console.error('REPORT_HISTORY write_failed', error?.message ?? String(error));
		storageMode = 'memory';
		memoryHistory = data;
	}
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
			console.error('REPORT_HISTORY queue_failed', error?.message ?? String(error));
		});

	await writeQueue;
}

export async function getApiHistorySnapshot(limit = 120): Promise<{
	filePath: string;
	storageMode: 'file' | 'memory';
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
		filePath: inMemoryHistoryPath(),
		storageMode,
		updatedAt: history.updatedAt,
		totalRuns: history.runs.length,
		endpoints,
		recentRuns
	};
}
