import { fetchJson } from '$lib/client/report-utils';

const NEW_PARTICIPANTS_ENDPOINT = '/API/engagement/new-participants';

export type NewParticipantsCreateResponse = {
	jobId: string;
	status?: string;
	phase?: string;
};

export async function createNewParticipantsJob(
	lookbackDays?: number,
	signal?: AbortSignal
): Promise<string> {
	const body: Record<string, unknown> = { op: 'create' };
	if (lookbackDays != null && Number.isFinite(lookbackDays) && lookbackDays > 0) {
		body.lookbackDays = Math.floor(lookbackDays);
	}

	const data = await fetchJson<NewParticipantsCreateResponse>(NEW_PARTICIPANTS_ENDPOINT, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
		signal
	});

	const jobId = String(data?.jobId ?? '');
	if (!jobId) throw new Error('Create job failed: missing jobId');
	return jobId;
}

export async function stepNewParticipantsJob(jobId: string, signal?: AbortSignal): Promise<any> {
	return fetchJson<any>(NEW_PARTICIPANTS_ENDPOINT, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ op: 'step', jobId }),
		signal
	});
}

export async function cancelNewParticipantsJob(jobId: string): Promise<any> {
	return fetchJson<any>(NEW_PARTICIPANTS_ENDPOINT, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ op: 'cancel', jobId })
	});
}

export async function cleanupNewParticipantsJob(jobId: string, keepalive = false): Promise<void> {
	try {
		await fetchJson(NEW_PARTICIPANTS_ENDPOINT, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ op: 'cleanup', jobId }),
			keepalive
		});
	} catch {
		// Best-effort cleanup.
	}
}

export async function fetchNewParticipantsView<T>(
	jobId: string,
	view?: 'summary' | 'participants' | 'report',
	offset?: number,
	limit?: number,
	signal?: AbortSignal
): Promise<T> {
	const params = new URLSearchParams({ jobId });
	if (view) params.set('view', view);
	if (offset != null) params.set('offset', String(offset));
	if (limit != null) params.set('limit', String(limit));

	return fetchJson<T>(`${NEW_PARTICIPANTS_ENDPOINT}?${params.toString()}`, { signal });
}

export async function runNewParticipantsJobUntilComplete(opts: {
	lookbackDays?: number;
	signal?: AbortSignal;
	stepDelayMs?: number;
	onJobCreated?: (jobId: string) => void;
	onProgress?: (progress: any) => void;
}): Promise<{ jobId: string; progress: any }> {
	const jobId = await createNewParticipantsJob(opts.lookbackDays, opts.signal);
	if (opts.onJobCreated) opts.onJobCreated(jobId);

	const stepDelayMs = Math.max(0, Math.floor(opts.stepDelayMs ?? 150));
	let lastProgress: any = null;

	while (true) {
		if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

		const prog = await stepNewParticipantsJob(jobId, opts.signal);
		lastProgress = prog;
		if (opts.onProgress) opts.onProgress(prog);

		if (prog?.status === 'error') {
			throw new Error(String(prog?.error ?? 'Report job failed'));
		}
		if (prog?.status === 'cancelled') {
			throw new Error('Report job cancelled');
		}

		const done = !!prog?.done || prog?.status === 'complete' || prog?.phase === 'complete';
		if (done) break;

		if (stepDelayMs > 0) {
			await new Promise((resolve) => setTimeout(resolve, stepDelayMs));
		}
	}

	return { jobId, progress: lastProgress };
}

export async function fetchAllNewParticipantsRows<T>(opts: {
	jobId: string;
	limit?: number;
	signal?: AbortSignal;
	onPage?: (page: { loaded: number; total: number | null; nextOffset: number | null }) => void;
}): Promise<T[]> {
	const limit = Math.min(5000, Math.max(1, Math.floor(opts.limit ?? 1000)));
	const all: T[] = [];
	let offset = 0;

	while (true) {
		if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

		const page = await fetchNewParticipantsView<any>(
			opts.jobId,
			'participants',
			offset,
			limit,
			opts.signal
		);

		const items = (page.items ?? []) as T[];
		all.push(...items);

		const nextOffset =
			page.nextOffset == null
				? null
				: Number.isFinite(Number(page.nextOffset))
					? Number(page.nextOffset)
					: null;
		const total = page.total == null ? null : Number(page.total);

		if (opts.onPage) {
			opts.onPage({
				loaded: all.length,
				total: Number.isFinite(total as number) ? (total as number) : null,
				nextOffset
			});
		}

		if (nextOffset == null) break;
		offset = nextOffset;
	}

	return all;
}
