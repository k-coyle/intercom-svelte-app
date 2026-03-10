import { fetchAllPagedViewItems, runJobUntilComplete } from '$lib/client/job-runtime';
import { cleanupJob, createJob, fetchJobView, stepJob } from '$lib/client/job-api';

const ENDPOINT = '/API/sd/scheduling';
export type SdSchedulingDateBasis = 'session' | 'created';

export async function createSdSchedulingJob(
	startDate: string,
	endDate: string,
	dateBasis: SdSchedulingDateBasis = 'session',
	signal?: AbortSignal
): Promise<string> {
	return createJob(
		ENDPOINT,
		{
			op: 'create',
			startDate,
			endDate,
			dateBasis
		},
		{
			signal,
			missingJobIdMessage: 'Create SD scheduling job failed: missing jobId'
		}
	);
}

export async function stepSdSchedulingJob(jobId: string, signal?: AbortSignal): Promise<any> {
	return stepJob(ENDPOINT, jobId, signal);
}

export async function cleanupSdSchedulingJob(jobId: string, keepalive = false): Promise<void> {
	return cleanupJob(ENDPOINT, jobId, keepalive);
}

export async function fetchSdSchedulingView<T>(
	jobId: string,
	view?: 'summary' | 'rows' | 'report',
	offset?: number,
	limit?: number,
	signal?: AbortSignal
): Promise<T> {
	return fetchJobView<T>(ENDPOINT, { jobId, view, offset, limit, signal });
}

export async function runSdSchedulingJobUntilComplete(opts: {
	startDate: string;
	endDate: string;
	dateBasis?: SdSchedulingDateBasis;
	signal?: AbortSignal;
	stepDelayMs?: number;
	onJobCreated?: (jobId: string) => void;
	onProgress?: (progress: any) => void;
}): Promise<{ jobId: string; progress: any }> {
	return runJobUntilComplete({
		createJob: () =>
			createSdSchedulingJob(opts.startDate, opts.endDate, opts.dateBasis ?? 'session', opts.signal),
		stepJob: (jobId) => stepSdSchedulingJob(jobId, opts.signal),
		signal: opts.signal,
		stepDelayMs: opts.stepDelayMs,
		defaultErrorMessage: 'SD scheduling job failed',
		cancelledErrorMessage: 'SD scheduling job cancelled',
		onJobCreated: opts.onJobCreated,
		onProgress: opts.onProgress
	});
}

export async function fetchAllSdSchedulingRows<T>(opts: {
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
		fetchPage: (offset, limit) => fetchSdSchedulingView<any>(opts.jobId, 'rows', offset, limit, opts.signal),
		onPage: opts.onPage
	});
}
