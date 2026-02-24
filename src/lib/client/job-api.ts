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
	return fetchJson<any>(endpoint, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ op: 'step', jobId }),
		signal
	});
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

	return fetchJson<T>(`${endpoint}?${params.toString()}`, { signal: options.signal });
}
