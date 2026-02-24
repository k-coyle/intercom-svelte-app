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
  const jobId = await createCaseloadJob(
    opts.lookbackDays,
    opts.untilLookbackDays,
    opts.signal
  );
  if (opts.onJobCreated) opts.onJobCreated(jobId);

  const stepDelayMs = Math.max(0, Math.floor(opts.stepDelayMs ?? 150));
  let lastProgress: any = null;

  while (true) {
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const prog = await stepCaseloadJob(jobId, opts.signal);
    lastProgress = prog;
    if (opts.onProgress) opts.onProgress(prog);

    if (prog?.status === 'error') {
      throw new Error(String(prog?.error ?? 'Caseload job failed'));
    }
    if (prog?.status === 'cancelled') {
      throw new Error('Caseload job cancelled');
    }

    const done = !!prog?.done || prog?.status === 'complete' || prog?.phase === 'complete';
    if (done) break;

    if (stepDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, stepDelayMs));
    }
  }

  return { jobId, progress: lastProgress };
}

export async function fetchAllCaseloadViewItems<T>(opts: {
  jobId: string;
  view: 'members' | 'sessions';
  limit?: number;
  signal?: AbortSignal;
  onPage?: (page: { loaded: number; total: number | null; nextOffset: number | null }) => void;
}): Promise<T[]> {
  const limit = Math.min(5000, Math.max(1, Math.floor(opts.limit ?? 500)));
  const all: T[] = [];
  let offset = 0;

  while (true) {
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const page = await fetchCaseloadViewPage<any>(
      opts.jobId,
      opts.view,
      offset,
      limit,
      opts.signal
    );

    const items = (page.items ?? []) as T[];
    all.push(...items);

    const nextOffset =
      page.nextOffset == null ? null : Number.isFinite(Number(page.nextOffset)) ? Number(page.nextOffset) : null;
    const total = page.total == null ? null : Number(page.total);

    if (opts.onPage) {
      opts.onPage({
        loaded: all.length,
        total: Number.isFinite(total as number) ? (total as number) : null,
        nextOffset
      });
    }

    if (nextOffset == null) break;
    offset = nextOffset;
  }

  return all;
}
