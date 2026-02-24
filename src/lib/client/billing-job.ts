import { fetchAllPagedViewItems, runJobUntilComplete } from '$lib/client/job-runtime';
import { cancelJob, cleanupJob, createJob, fetchJobView, stepJob } from '$lib/client/job-api';

const BILLING_ENDPOINT = '/API/engagement/billing';

export async function createBillingJob(
	monthYearLabel?: string,
	signal?: AbortSignal
): Promise<string> {
	const body: Record<string, unknown> = { op: 'create' };
	if (monthYearLabel && monthYearLabel.trim()) {
		body.monthYearLabel = monthYearLabel.trim();
	}

	return createJob(BILLING_ENDPOINT, body, {
		signal,
		missingJobIdMessage: 'Create billing job failed: missing jobId'
	});
}

export async function stepBillingJob(jobId: string, signal?: AbortSignal): Promise<any> {
	return stepJob(BILLING_ENDPOINT, jobId, signal);
}

export async function cancelBillingJob(jobId: string): Promise<any> {
	return cancelJob(BILLING_ENDPOINT, jobId);
}

export async function cleanupBillingJob(jobId: string, keepalive = false): Promise<void> {
	return cleanupJob(BILLING_ENDPOINT, jobId, keepalive);
}

export async function fetchBillingView<T>(
	jobId: string,
	view?: 'summary' | 'rows' | 'report',
	offset?: number,
	limit?: number,
	signal?: AbortSignal
): Promise<T> {
	return fetchJobView<T>(BILLING_ENDPOINT, { jobId, view, offset, limit, signal });
}

export async function runBillingJobUntilComplete(opts: {
	monthYearLabel?: string;
	signal?: AbortSignal;
	stepDelayMs?: number;
	onJobCreated?: (jobId: string) => void;
	onProgress?: (progress: any) => void;
}): Promise<{ jobId: string; progress: any }> {
	return runJobUntilComplete({
		createJob: () => createBillingJob(opts.monthYearLabel, opts.signal),
		stepJob: (jobId) => stepBillingJob(jobId, opts.signal),
		signal: opts.signal,
		stepDelayMs: opts.stepDelayMs,
		defaultErrorMessage: 'Billing job failed',
		cancelledErrorMessage: 'Billing job cancelled',
		onJobCreated: opts.onJobCreated,
		onProgress: opts.onProgress
	});
}

export async function fetchAllBillingRows<T>(opts: {
	jobId: string;
	limit?: number;
	signal?: AbortSignal;
	onPage?: (page: { loaded: number; total: number | null; nextOffset: number | null }) => void;
}): Promise<T[]> {
	return fetchAllPagedViewItems<T>({
		limit: opts.limit,
		defaultLimit: 750,
		maxLimit: 5000,
		signal: opts.signal,
		fetchPage: (offset, limit) =>
			fetchBillingView<any>(opts.jobId, 'rows', offset, limit, opts.signal),
		onPage: opts.onPage
	});
}
