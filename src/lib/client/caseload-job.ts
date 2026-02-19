import { fetchJson } from '$lib/client/report-utils';

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
