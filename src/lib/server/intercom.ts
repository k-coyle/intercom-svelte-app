import {
  INTERCOM_ACCESS_TOKEN,
  INTERCOM_VERSION,
  INTERCOM_API_BASE
} from '$env/static/private';

const INTERCOM_BASE_URL = INTERCOM_API_BASE || 'https://api.intercom.io';
const INTERCOM_API_VERSION = INTERCOM_VERSION || '2.10';

export const INTERCOM_MAX_PER_PAGE = 150;

const DEFAULT_TIMEOUT_MS = 18_000;
const DEFAULT_MIN_TIMEOUT_MS = 4_000;
const DEFAULT_MAX_TIMEOUT_MS = 25_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_DEADLINE_BUFFER_MS = 500;
const DEFAULT_SLOW_THRESHOLD_MS = 5_000;

export type IntercomLogFn = (event: string, data: Record<string, any>) => void;

export type IntercomRequestOptions = {
  timeoutMs?: number;
  deadlineMs?: number;
  minTimeoutMs?: number;
  maxTimeoutMs?: number;
  maxRetries?: number;
  slowThresholdMs?: number;
  deadlineBufferMs?: number;
  tag?: string;
  log?: IntercomLogFn;
  logAll?: boolean;
};

export type IntercomPaginationInfo = {
  page: number;
  items: number;
  totalCount?: number;
  nextCursor: string | null;
};

export type IntercomPaginateOptions<T> = {
  path: string;
  body: Record<string, any>;
  perPage?: number;
  extractItems: (data: any) => T[];
  getNextCursor?: (data: any) => string | undefined;
  onPage?: (info: IntercomPaginationInfo) => void;
  requestOptions?: IntercomRequestOptions;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timeLeftMs(deadlineMs: number) {
  return deadlineMs - Date.now();
}

function isAbortError(e: any) {
  return e?.name === 'AbortError' || String(e?.message ?? '').toLowerCase().includes('aborted');
}

function computeTimeoutMs(opts: IntercomRequestOptions): number {
  const minTimeoutMs = opts.minTimeoutMs ?? DEFAULT_MIN_TIMEOUT_MS;
  const maxTimeoutMs = opts.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS;
  const deadlineBufferMs = opts.deadlineBufferMs ?? DEFAULT_DEADLINE_BUFFER_MS;

  let timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (opts.deadlineMs) {
    timeoutMs = Math.min(timeoutMs, Math.max(minTimeoutMs, timeLeftMs(opts.deadlineMs) - deadlineBufferMs));
  }

  return Math.min(maxTimeoutMs, Math.max(minTimeoutMs, timeoutMs));
}

function withTimeoutSignal(init: RequestInit, timeoutMs: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let signal: AbortSignal = controller.signal;
  if (init.signal) {
    const anySignal = (AbortSignal as any)?.any;
    if (typeof anySignal === 'function') {
      signal = anySignal([init.signal, controller.signal]);
    } else if (init.signal.aborted) {
      controller.abort();
    }
  }

  return {
    signal,
    cancel: () => clearTimeout(timer)
  };
}

async function parseRequestId(text: string): Promise<string | null> {
  try {
    const j = JSON.parse(text);
    return j?.request_id ?? null;
  } catch {
    return null;
  }
}

export function coerceIntercomPerPage(
  perPage?: number,
  max = INTERCOM_MAX_PER_PAGE,
  fallback = INTERCOM_MAX_PER_PAGE
): number {
  if (!perPage || !Number.isFinite(perPage)) return fallback;
  if (perPage <= 0) return fallback;
  return Math.min(Math.floor(perPage), max);
}

export function extractIntercomContacts(data: any): any[] {
  return data.data ?? data.contacts ?? [];
}

export function extractIntercomConversations(data: any): any[] {
  return data.conversations ?? data.data ?? [];
}

function getTotalCount(data: any): number | undefined {
  const raw = data?.total_count ?? data?.total;
  if (typeof raw === 'number') return raw;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function getNextCursor(data: any): string | undefined {
  return data?.pages?.next?.starting_after;
}

export async function intercomPaginate<T>(
  opts: IntercomPaginateOptions<T>
): Promise<T[]> {
  const perPage = coerceIntercomPerPage(opts.perPage);
  const all: T[] = [];
  let page = 1;
  let startingAfter: string | undefined;

  while (true) {
    const payload: any = {
      ...opts.body,
      pagination: {
        per_page: perPage
      }
    };

    if (startingAfter) {
      payload.pagination.starting_after = startingAfter;
    }

    const data = await intercomRequest(
      opts.path,
      {
        method: 'POST',
        body: JSON.stringify(payload)
      },
      opts.requestOptions
    );

    const items = opts.extractItems(data);
    all.push(...items);

    const nextCursor = (opts.getNextCursor ?? getNextCursor)(data);
    if (opts.onPage) {
      opts.onPage({
        page,
        items: items.length,
        totalCount: getTotalCount(data),
        nextCursor: nextCursor ?? null
      });
    }

    if (!nextCursor) break;

    startingAfter = nextCursor;
    page += 1;
  }

  return all;
}

export async function fetchContactsByIds(
  contactIds: string[],
  opts: {
    concurrency?: number;
    requestOptions?: IntercomRequestOptions;
    onError?: (contactId: string, error: unknown) => void;
  } = {}
): Promise<Map<string, any>> {
  const result = new Map<string, any>();
  const ids = [...new Set(contactIds)].filter(Boolean).map(String);

  if (ids.length === 0) return result;

  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 10));
  let index = 0;

  async function worker() {
    while (index < ids.length) {
      const id = ids[index];
      index += 1;

      try {
        const contact = await intercomRequest(`/contacts/${id}`, {}, opts.requestOptions);
        result.set(id, contact);
      } catch (err) {
        if (opts.onError) opts.onError(id, err);
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, ids.length) },
    () => worker()
  );
  await Promise.all(workers);

  return result;
}

export async function intercomRequest(
  path: string,
  init: RequestInit = {},
  opts: IntercomRequestOptions = {}
): Promise<any> {
  if (!INTERCOM_ACCESS_TOKEN) {
    throw new Error('INTERCOM_ACCESS_TOKEN is not set');
  }

  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const slowThresholdMs = opts.slowThresholdMs ?? DEFAULT_SLOW_THRESHOLD_MS;

  let attempt = 1;

  while (true) {
    const timeoutMs = computeTimeoutMs(opts);
    const { signal, cancel } = withTimeoutSignal(init, timeoutMs);
    const started = Date.now();

    try {
      const res = await fetch(`${INTERCOM_BASE_URL}${path}`, {
        ...init,
        signal,
        headers: {
          Authorization: `Bearer ${INTERCOM_ACCESS_TOKEN}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Intercom-Version': INTERCOM_API_VERSION,
          ...(init.headers ?? {})
        }
      });

      const ms = Date.now() - started;

      if (opts.log && (opts.logAll || ms >= slowThresholdMs)) {
        opts.log('intercom_response', {
          path,
          tag: opts.tag ?? null,
          status: res.status,
          ms,
          attempt
        });
      }

      if (res.status === 429 && attempt < maxRetries) {
        const retryAfterHeader = res.headers.get('Retry-After');
        const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : NaN;
        const delaySeconds = Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : 2 ** attempt;

        if (opts.log) {
          opts.log('intercom_rate_limited', {
            path,
            tag: opts.tag ?? null,
            attempt,
            delaySeconds
          });
        }

        await sleep(delaySeconds * 1000);
        attempt += 1;
        continue;
      }

      if (!res.ok) {
        const text = await res.text();
        const requestId = await parseRequestId(text);

        if (opts.log) {
          opts.log('intercom_error', {
            path,
            tag: opts.tag ?? null,
            status: res.status,
            requestId
          });
        }

        throw new Error(`Intercom ${res.status} ${res.statusText} on ${path}: ${text}`);
      }

      return res.json();
    } catch (e: any) {
      const ms = Date.now() - started;

      if (isAbortError(e)) {
        if (opts.log) {
          opts.log('intercom_abort', {
            path,
            tag: opts.tag ?? null,
            timeoutMs,
            ms
          });
        }

        const err = new Error(`Intercom request aborted on ${path} after ${timeoutMs}ms`);
        (err as any).name = 'AbortError';
        throw err;
      }

      if (opts.log) {
        opts.log('intercom_exception', {
          path,
          tag: opts.tag ?? null,
          ms,
          message: e?.message ?? String(e)
        });
      }

      throw e;
    } finally {
      cancel();
    }
  }
}
