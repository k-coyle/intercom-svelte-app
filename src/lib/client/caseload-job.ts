import { fetchAllPagedViewItems, runJobUntilComplete } from '$lib/client/job-runtime';
import { createJob, fetchJobView, cleanupJob, stepJob } from '$lib/client/job-api';

const CASELOAD_ENDPOINT = '/API/engagement/caseload';

export type CaseloadCreateResponse = {
  jobId: string;
  status?: string;
  phase?: string;
};

export async function createCaseloadJob(
  lookbackDays: number,
  untilLookbackDays?: number | null,
  signal?: AbortSignal
): Promise<string> {
  const body: Record<string, unknown> = { op: 'create', lookbackDays };
  if (untilLookbackDays != null && untilLookbackDays > 0) {
    body.untilLookbackDays = untilLookbackDays;
  }

  return createJob(CASELOAD_ENDPOINT, body, {
    signal,
    missingJobIdMessage: 'Create job failed: missing jobId'
  });
}

export async function stepCaseloadJob(
  jobId: string,
  signal?: AbortSignal
): Promise<any> {
  return stepJob(CASELOAD_ENDPOINT, jobId, signal);
}

export async function cleanupCaseloadJob(
  jobId: string,
  keepalive = false
): Promise<void> {
  return cleanupJob(CASELOAD_ENDPOINT, jobId, keepalive);
}

export function beaconCleanupCaseloadJob(jobId: string): boolean {
  if (!jobId) return false;
  if (typeof navigator === 'undefined') return false;

  try {
    const payload = JSON.stringify({ op: 'cleanup', jobId });
    return navigator.sendBeacon(CASELOAD_ENDPOINT, payload);
  } catch {
    return false;
  }
}

export async function fetchCaseloadViewPage<T>(
  jobId: string,
  view: 'summary' | 'members' | 'sessions',
  offset?: number,
  limit?: number,
  signal?: AbortSignal
): Promise<T> {
  return fetchJobView<T>(CASELOAD_ENDPOINT, { jobId, view, offset, limit, signal });
}

export async function runCaseloadJobUntilComplete(opts: {
  lookbackDays: number;
  untilLookbackDays?: number | null;
  signal?: AbortSignal;
  stepDelayMs?: number;
  onJobCreated?: (jobId: string) => void;
  onProgress?: (progress: any) => void;
}): Promise<{ jobId: string; progress: any }> {
  return runJobUntilComplete({
    createJob: () => createCaseloadJob(opts.lookbackDays, opts.untilLookbackDays, opts.signal),
    stepJob: (jobId) => stepCaseloadJob(jobId, opts.signal),
    signal: opts.signal,
    stepDelayMs: opts.stepDelayMs,
    defaultErrorMessage: 'Caseload job failed',
    cancelledErrorMessage: 'Caseload job cancelled',
    onJobCreated: opts.onJobCreated,
    onProgress: opts.onProgress
  });
}

export async function fetchAllCaseloadViewItems<T>(opts: {
  jobId: string;
  view: 'members' | 'sessions';
  limit?: number;
  signal?: AbortSignal;
  onPage?: (page: { loaded: number; total: number | null; nextOffset: number | null }) => void;
}): Promise<T[]> {
  return fetchAllPagedViewItems<T>({
    limit: opts.limit,
    defaultLimit: 500,
    maxLimit: 5000,
    signal: opts.signal,
    fetchPage: (offset, limit) =>
      fetchCaseloadViewPage<any>(opts.jobId, opts.view, offset, limit, opts.signal),
    onPage: opts.onPage
  });
}
