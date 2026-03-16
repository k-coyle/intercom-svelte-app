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

const JOB_NOT_FOUND_RETRY_LIMIT = 8;
const JOB_NOT_FOUND_RETRY_DELAY_MS = 200;

function isJobNotFoundError(error: unknown, jobId: string): boolean {
	const message = String((error as any)?.message ?? error ?? '');
	return message.includes('HTTP 404') && message.includes('Job not found') && message.includes(jobId);
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

async function withJobNotFoundRetry<T>(
	run: () => Promise<T>,
	jobId: string,
	signal?: AbortSignal
): Promise<T> {
	let attempt = 0;
	while (true) {
		if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
		try {
			return await run();
		} catch (error) {
			if (!isJobNotFoundError(error, jobId) || attempt >= JOB_NOT_FOUND_RETRY_LIMIT) {
				throw error;
			}
			attempt += 1;
			await waitWithAbort(JOB_NOT_FOUND_RETRY_DELAY_MS * attempt, signal);
		}
	}
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
	return withJobNotFoundRetry(
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
	return withJobNotFoundRetry(
		() => fetchJson<T>(url, { signal: options.signal }),
		options.jobId,
		options.signal
	);
}
