import { fetchJson } from '$lib/client/report-utils';

const BILLING_ENDPOINT = '/API/engagement/billing';

export type BillingCreateResponse = {
	jobId: string;
	status?: string;
	phase?: string;
	monthYearLabel?: string;
};

export async function createBillingJob(
	monthYearLabel?: string,
	signal?: AbortSignal
): Promise<string> {
	const body: Record<string, unknown> = { op: 'create' };
	if (monthYearLabel && monthYearLabel.trim()) {
		body.monthYearLabel = monthYearLabel.trim();
	}

	const data = await fetchJson<BillingCreateResponse>(BILLING_ENDPOINT, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
		signal
	});

	const jobId = String(data?.jobId ?? '');
	if (!jobId) throw new Error('Create billing job failed: missing jobId');
	return jobId;
}

export async function stepBillingJob(jobId: string, signal?: AbortSignal): Promise<any> {
	return fetchJson<any>(BILLING_ENDPOINT, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ op: 'step', jobId }),
		signal
	});
}

export async function cancelBillingJob(jobId: string): Promise<any> {
	return fetchJson<any>(BILLING_ENDPOINT, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ op: 'cancel', jobId })
	});
}

export async function cleanupBillingJob(jobId: string, keepalive = false): Promise<void> {
	try {
		await fetchJson(BILLING_ENDPOINT, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ op: 'cleanup', jobId }),
			keepalive
		});
	} catch {
		// Best-effort cleanup.
	}
}

export async function fetchBillingView<T>(
	jobId: string,
	view?: 'summary' | 'rows' | 'report',
	offset?: number,
	limit?: number,
	signal?: AbortSignal
): Promise<T> {
	const params = new URLSearchParams({ jobId });
	if (view) params.set('view', view);
	if (offset != null) params.set('offset', String(offset));
	if (limit != null) params.set('limit', String(limit));

	return fetchJson<T>(`${BILLING_ENDPOINT}?${params.toString()}`, { signal });
}

export async function runBillingJobUntilComplete(opts: {
	monthYearLabel?: string;
	signal?: AbortSignal;
	stepDelayMs?: number;
	onJobCreated?: (jobId: string) => void;
	onProgress?: (progress: any) => void;
}): Promise<{ jobId: string; progress: any }> {
	const jobId = await createBillingJob(opts.monthYearLabel, opts.signal);
	if (opts.onJobCreated) opts.onJobCreated(jobId);

	const stepDelayMs = Math.max(0, Math.floor(opts.stepDelayMs ?? 150));
	let lastProgress: any = null;

	while (true) {
		if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

		const prog = await stepBillingJob(jobId, opts.signal);
		lastProgress = prog;
		if (opts.onProgress) opts.onProgress(prog);

		if (prog?.status === 'error') {
			throw new Error(String(prog?.error ?? 'Billing job failed'));
		}
		if (prog?.status === 'cancelled') {
			throw new Error('Billing job cancelled');
		}

		const done = !!prog?.done || prog?.status === 'complete' || prog?.phase === 'complete';
		if (done) break;

		if (stepDelayMs > 0) {
			await new Promise((resolve) => setTimeout(resolve, stepDelayMs));
		}
	}

	return { jobId, progress: lastProgress };
}

export async function fetchAllBillingRows<T>(opts: {
	jobId: string;
	limit?: number;
	signal?: AbortSignal;
	onPage?: (page: { loaded: number; total: number | null; nextOffset: number | null }) => void;
}): Promise<T[]> {
	const limit = Math.min(5000, Math.max(1, Math.floor(opts.limit ?? 750)));
	const all: T[] = [];
	let offset = 0;

	while (true) {
		if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

		const page = await fetchBillingView<any>(opts.jobId, 'rows', offset, limit, opts.signal);
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
