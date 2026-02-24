import { fetchJson } from '$lib/client/report-utils';
import { fetchAllPagedViewItems, runJobUntilComplete } from '$lib/client/job-runtime';

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

  const data = await fetchJson<CaseloadCreateResponse>(CASELOAD_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  });

  const jobId = String(data?.jobId ?? '');
  if (!jobId) throw new Error('Create job failed: missing jobId');
  return jobId;
}

export async function stepCaseloadJob(
  jobId: string,
  signal?: AbortSignal
): Promise<any> {
  return fetchJson<any>(CASELOAD_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: 'step', jobId }),
    signal
  });
}

export async function cleanupCaseloadJob(
  jobId: string,
  keepalive = false
): Promise<void> {
  try {
    await fetchJson(CASELOAD_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'cleanup', jobId }),
      keepalive
    });
  } catch {
    // Best-effort cleanup.
  }
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
  const params = new URLSearchParams({
    jobId,
    view
  });

  if (offset != null) params.set('offset', String(offset));
  if (limit != null) params.set('limit', String(limit));

  return fetchJson<T>(`${CASELOAD_ENDPOINT}?${params.toString()}`, { signal });
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
