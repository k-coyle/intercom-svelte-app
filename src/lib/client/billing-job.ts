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
