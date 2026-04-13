import { fetchAllPagedViewItems, runJobUntilComplete } from '$lib/client/job-runtime';
import {
	cleanupJob,
	createJob,
	fetchJobView,
	stepJob,
	type FetchJobViewRetryOptions
} from '$lib/client/job-api';

const ENDPOINT = '/API/sd/referrals/incoming';

export async function createSdIncomingReferralsJob(
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
			missingJobIdMessage: 'Create SD incoming referrals job failed: missing jobId'
		}
	);
}

export async function stepSdIncomingReferralsJob(jobId: string, signal?: AbortSignal): Promise<any> {
	return stepJob(ENDPOINT, jobId, signal);
}

export async function cleanupSdIncomingReferralsJob(jobId: string, keepalive = false): Promise<void> {
	return cleanupJob(ENDPOINT, jobId, keepalive);
}

export async function fetchSdIncomingReferralsView<T>(
	jobId: string,
	view?: 'summary' | 'rows' | 'report',
	offset?: number,
	limit?: number,
	signal?: AbortSignal,
	retry?: FetchJobViewRetryOptions
): Promise<T> {
	return fetchJobView<T>(ENDPOINT, { jobId, view, offset, limit, signal, retry });
}

export async function runSdIncomingReferralsJobUntilComplete(opts: {
	startDate: string;
	endDate: string;
	signal?: AbortSignal;
	stepDelayMs?: number;
	onJobCreated?: (jobId: string) => void;
	onProgress?: (progress: any) => void;
}): Promise<{ jobId: string; progress: any }> {
	return runJobUntilComplete({
		createJob: () => createSdIncomingReferralsJob(opts.startDate, opts.endDate, opts.signal),
		stepJob: (jobId) => stepSdIncomingReferralsJob(jobId, opts.signal),
		signal: opts.signal,
		stepDelayMs: opts.stepDelayMs,
		defaultErrorMessage: 'SD incoming referrals job failed',
		cancelledErrorMessage: 'SD incoming referrals job cancelled',
		onJobCreated: opts.onJobCreated,
		onProgress: opts.onProgress
	});
}

export async function fetchAllSdIncomingReferralsRows<T>(opts: {
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
			fetchSdIncomingReferralsView<any>(opts.jobId, 'rows', offset, limit, opts.signal, opts.retry),
		onPage: opts.onPage
	});
}
