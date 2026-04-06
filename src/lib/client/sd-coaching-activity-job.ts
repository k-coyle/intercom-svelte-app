import { fetchAllPagedViewItems, runJobUntilComplete } from '$lib/client/job-runtime';
import {
	cleanupJob,
	createJob,
	fetchJobView,
	stepJob,
	type FetchJobViewRetryOptions
} from '$lib/client/job-api';

const ENDPOINT = '/API/sd/coaching-activity';

export async function createSdCoachingActivityJob(
	startDate: string,
	endDate: string,
	signal?: AbortSignal
): Promise<string> {
	return createJob(
		ENDPOINT,
		{
			op: 'create',
			startDate,
			endDate
		},
		{
			signal,
			missingJobIdMessage: 'Create SD coaching activity job failed: missing jobId'
		}
	);
}

export async function stepSdCoachingActivityJob(jobId: string, signal?: AbortSignal): Promise<any> {
	return stepJob(ENDPOINT, jobId, signal);
}

export async function cleanupSdCoachingActivityJob(jobId: string, keepalive = false): Promise<void> {
	return cleanupJob(ENDPOINT, jobId, keepalive);
}

export async function fetchSdCoachingActivityView<T>(
	jobId: string,
	view?: 'summary' | 'rows' | 'report',
	offset?: number,
	limit?: number,
	signal?: AbortSignal,
	retry?: FetchJobViewRetryOptions
): Promise<T> {
	return fetchJobView<T>(ENDPOINT, { jobId, view, offset, limit, signal, retry });
}

export async function runSdCoachingActivityJobUntilComplete(opts: {
	startDate: string;
	endDate: string;
	signal?: AbortSignal;
	stepDelayMs?: number;
	onJobCreated?: (jobId: string) => void;
	onProgress?: (progress: any) => void;
}): Promise<{ jobId: string; progress: any }> {
	return runJobUntilComplete({
		createJob: () => createSdCoachingActivityJob(opts.startDate, opts.endDate, opts.signal),
		stepJob: (jobId) => stepSdCoachingActivityJob(jobId, opts.signal),
		signal: opts.signal,
		stepDelayMs: opts.stepDelayMs,
		defaultErrorMessage: 'SD coaching activity job failed',
		cancelledErrorMessage: 'SD coaching activity job cancelled',
		onJobCreated: opts.onJobCreated,
		onProgress: opts.onProgress
	});
}

export async function fetchAllSdCoachingActivityRows<T>(opts: {
	jobId: string;
	limit?: number;
	signal?: AbortSignal;
	retry?: FetchJobViewRetryOptions;
	onPage?: (page: { loaded: number; total: number | null; nextOffset: number | null }) => void;
}): Promise<T[]> {
	return fetchAllPagedViewItems<T>({
		limit: opts.limit,
		defaultLimit: 1000,
		maxLimit: 5000,
		signal: opts.signal,
		fetchPage: (offset, limit) =>
			fetchSdCoachingActivityView<any>(opts.jobId, 'rows', offset, limit, opts.signal, opts.retry),
		onPage: opts.onPage
	});
}
