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
