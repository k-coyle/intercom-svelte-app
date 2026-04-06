import { fetchJson } from '$lib/client/report-utils';

type CreateJobOptions = {
	signal?: AbortSignal;
	missingJobIdMessage?: string;
};

type FetchJobViewOptions = {
	jobId: string;
	view?: string;
	offset?: number;
	limit?: number;
	signal?: AbortSignal;
};

const STEP_JOB_NOT_FOUND_RETRY_LIMIT = 20;
const VIEW_TRANSIENT_RETRY_LIMIT = 30;
const JOB_RETRY_BASE_DELAY_MS = 125;
const JOB_RETRY_MAX_DELAY_MS = 2_000;

function errorMessage(error: unknown): string {
	return String((error as any)?.message ?? error ?? '');
}

function isJobNotFoundError(error: unknown, jobId?: string): boolean {
	const message = errorMessage(error);
	const isNotFound = message.includes('HTTP 404') && message.includes('Job not found');
	if (!isNotFound) return false;
	if (!jobId) return true;
	return message.includes(jobId) || !message.includes('jobId');
}

function isJobNotCompleteError(error: unknown): boolean {
	const message = errorMessage(error);
	return message.includes('HTTP 409') && message.includes('Job not complete');
}

function retryDelayMs(attempt: number): number {
	const exp = JOB_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1);
	return Math.min(JOB_RETRY_MAX_DELAY_MS, exp);
}

async function withRetry<T>(opts: {
	run: () => Promise<T>;
	shouldRetry: (error: unknown) => boolean;
	retryLimit: number;
	signal?: AbortSignal;
}): Promise<T> {
	let attempt = 0;
	while (true) {
		if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
		try {
			return await opts.run();
		} catch (error) {
			if (!opts.shouldRetry(error) || attempt >= opts.retryLimit) {
				throw error;
			}
			attempt += 1;
			await waitWithAbort(retryDelayMs(attempt), opts.signal);
		}
	}
}

function isStepJobRetryableError(error: unknown, jobId: string): boolean {
	return isJobNotFoundError(error, jobId);
}

function isFetchViewRetryableError(error: unknown, jobId: string): boolean {
	return isJobNotFoundError(error, jobId) || isJobNotCompleteError(error);
}

async function withStepJobRetry<T>(run: () => Promise<T>, jobId: string, signal?: AbortSignal): Promise<T> {
	return withRetry({
		run,
		shouldRetry: (error) => isStepJobRetryableError(error, jobId),
		retryLimit: STEP_JOB_NOT_FOUND_RETRY_LIMIT,
		signal
	});
}

async function withFetchViewRetry<T>(run: () => Promise<T>, jobId: string, signal?: AbortSignal): Promise<T> {
	return withRetry({
		run,
		shouldRetry: (error) => isFetchViewRetryableError(error, jobId),
		retryLimit: VIEW_TRANSIENT_RETRY_LIMIT,
		signal
	});
}

async function waitWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) return;
	if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

	await new Promise<void>((resolve, reject) => {
		let timeout: ReturnType<typeof setTimeout> | null = null;
		const onAbort = () => {
			if (timeout) clearTimeout(timeout);
			signal?.removeEventListener('abort', onAbort);
			reject(new DOMException('Aborted', 'AbortError'));
		};

		timeout = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);

		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

export async function createJob(
	endpoint: string,
	body: Record<string, unknown>,
	options: CreateJobOptions = {}
): Promise<string> {
	const data = await fetchJson<{ jobId?: unknown }>(endpoint, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
		signal: options.signal
	});

	const jobId = String(data?.jobId ?? '');
	if (!jobId) {
		throw new Error(options.missingJobIdMessage ?? 'Create job failed: missing jobId');
	}
	return jobId;
}

export async function stepJob(endpoint: string, jobId: string, signal?: AbortSignal): Promise<any> {
	return withStepJobRetry(
		() =>
			fetchJson<any>(endpoint, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ op: 'step', jobId }),
				signal
			}),
		jobId,
		signal
	);
}

export async function cancelJob(endpoint: string, jobId: string): Promise<any> {
	return fetchJson<any>(endpoint, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ op: 'cancel', jobId })
	});
}

export async function cleanupJob(
	endpoint: string,
	jobId: string,
	keepalive = false
): Promise<void> {
	try {
		await fetchJson(endpoint, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ op: 'cleanup', jobId }),
			keepalive
		});
	} catch {
		// Best-effort cleanup.
	}
}

export async function fetchJobView<T>(endpoint: string, options: FetchJobViewOptions): Promise<T> {
	const params = new URLSearchParams({ jobId: options.jobId });
	if (options.view) params.set('view', options.view);
	if (options.offset != null) params.set('offset', String(options.offset));
	if (options.limit != null) params.set('limit', String(options.limit));

	const url = `${endpoint}?${params.toString()}`;
	return withFetchViewRetry(
		() => fetchJson<T>(url, { signal: options.signal }),
		options.jobId,
		options.signal
	);
}
