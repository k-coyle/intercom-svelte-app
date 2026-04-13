import { fetchAllPagedViewItems, runJobUntilComplete } from '$lib/client/job-runtime';
import {
	cleanupJob,
	createJob,
	fetchJobView,
	stepJob,
	type FetchJobViewRetryOptions
} from '$lib/client/job-api';

const ENDPOINT = '/API/sd/referrals/outgoing';

export async function createSdOutgoingReferralsJob(
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
			missingJobIdMessage: 'Create SD outgoing referrals job failed: missing jobId'
		}
	);
}

export async function stepSdOutgoingReferralsJob(jobId: string, signal?: AbortSignal): Promise<any> {
	return stepJob(ENDPOINT, jobId, signal);
}

export async function cleanupSdOutgoingReferralsJob(jobId: string, keepalive = false): Promise<void> {
	return cleanupJob(ENDPOINT, jobId, keepalive);
}

export async function fetchSdOutgoingReferralsView<T>(
	jobId: string,
	view?: 'summary' | 'rows' | 'report',
	offset?: number,
	limit?: number,
	signal?: AbortSignal,
	retry?: FetchJobViewRetryOptions
): Promise<T> {
	return fetchJobView<T>(ENDPOINT, { jobId, view, offset, limit, signal, retry });
}

export async function runSdOutgoingReferralsJobUntilComplete(opts: {
	startDate: string;
	endDate: string;
	signal?: AbortSignal;
	stepDelayMs?: number;
	onJobCreated?: (jobId: string) => void;
	onProgress?: (progress: any) => void;
}): Promise<{ jobId: string; progress: any }> {
	return runJobUntilComplete({
		createJob: () => createSdOutgoingReferralsJob(opts.startDate, opts.endDate, opts.signal),
		stepJob: (jobId) => stepSdOutgoingReferralsJob(jobId, opts.signal),
		signal: opts.signal,
		stepDelayMs: opts.stepDelayMs,
		defaultErrorMessage: 'SD outgoing referrals job failed',
		cancelledErrorMessage: 'SD outgoing referrals job cancelled',
		onJobCreated: opts.onJobCreated,
		onProgress: opts.onProgress
	});
}

export async function fetchAllSdOutgoingReferralsRows<T>(opts: {
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
			fetchSdOutgoingReferralsView<any>(opts.jobId, 'rows', offset, limit, opts.signal, opts.retry),
		onPage: opts.onPage
	});
}
