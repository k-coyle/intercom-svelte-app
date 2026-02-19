import {
  INTERCOM_ACCESS_TOKEN,
  INTERCOM_VERSION,
  INTERCOM_API_BASE
} from '$env/static/private';

const INTERCOM_BASE_URL = INTERCOM_API_BASE || 'https://api.intercom.io';
const INTERCOM_API_VERSION = INTERCOM_VERSION || '2.10';

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
