import { fetchAllPagedViewItems, runJobUntilComplete } from '$lib/client/job-runtime';
import { cancelJob, cleanupJob, createJob, fetchJobView, stepJob } from '$lib/client/job-api';

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

	return createJob(NEW_PARTICIPANTS_ENDPOINT, body, {
		signal,
		missingJobIdMessage: 'Create job failed: missing jobId'
	});
}

export async function stepNewParticipantsJob(jobId: string, signal?: AbortSignal): Promise<any> {
	return stepJob(NEW_PARTICIPANTS_ENDPOINT, jobId, signal);
}

export async function cancelNewParticipantsJob(jobId: string): Promise<any> {
	return cancelJob(NEW_PARTICIPANTS_ENDPOINT, jobId);
}

export async function cleanupNewParticipantsJob(jobId: string, keepalive = false): Promise<void> {
	return cleanupJob(NEW_PARTICIPANTS_ENDPOINT, jobId, keepalive);
}

export async function fetchNewParticipantsView<T>(
	jobId: string,
	view?: 'summary' | 'participants' | 'report',
	offset?: number,
	limit?: number,
	signal?: AbortSignal
): Promise<T> {
	return fetchJobView<T>(NEW_PARTICIPANTS_ENDPOINT, { jobId, view, offset, limit, signal });
}

export async function runNewParticipantsJobUntilComplete(opts: {
	lookbackDays?: number;
	signal?: AbortSignal;
	stepDelayMs?: number;
	onJobCreated?: (jobId: string) => void;
	onProgress?: (progress: any) => void;
}): Promise<{ jobId: string; progress: any }> {
	return runJobUntilComplete({
		createJob: () => createNewParticipantsJob(opts.lookbackDays, opts.signal),
		stepJob: (jobId) => stepNewParticipantsJob(jobId, opts.signal),
		signal: opts.signal,
		stepDelayMs: opts.stepDelayMs,
		defaultErrorMessage: 'Report job failed',
		cancelledErrorMessage: 'Report job cancelled',
		onJobCreated: opts.onJobCreated,
		onProgress: opts.onProgress
	});
}

export async function fetchAllNewParticipantsRows<T>(opts: {
	jobId: string;
	limit?: number;
	signal?: AbortSignal;
	onPage?: (page: { loaded: number; total: number | null; nextOffset: number | null }) => void;
}): Promise<T[]> {
	return fetchAllPagedViewItems<T>({
		limit: opts.limit,
		defaultLimit: 1000,
		maxLimit: 5000,
		signal: opts.signal,
		fetchPage: (offset, limit) =>
			fetchNewParticipantsView<any>(opts.jobId, 'participants', offset, limit, opts.signal),
		onPage: opts.onPage
	});
}
