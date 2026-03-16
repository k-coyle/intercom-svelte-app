// src/lib/server/oncehubClient.ts
import { ONCEHUB_API_KEY, ONCEHUB_API_BASE } from '$env/static/private';
const ONCEHUB_BASE_URL = ONCEHUB_API_BASE || 'https://api.oncehub.com/v2';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RETRIES = 3;

export type OnceHubLinkRel = 'next' | 'previous';

export type OnceHubLinks = Partial<Record<OnceHubLinkRel, string>>;

export type OnceHubResult<T> = {
  ok: boolean;
  status: number;
  requestId?: string;
  links?: OnceHubLinks;
  data?: T;
  error?: {
    type?: string;
    message?: string;
    param?: string;
    raw?: unknown;
  };
};

export type FetchOnceHubOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxRetries?: number;
};

function assertConfigured() {
  if (!ONCEHUB_API_KEY) {
    throw new Error('ONCEHUB_API_KEY is not set');
  }
}

function buildUrl(path: string, query?: FetchOnceHubOptions['query']): string {
  const base = ONCEHUB_BASE_URL.endsWith('/') ? ONCEHUB_BASE_URL : `${ONCEHUB_BASE_URL}/`;
  const cleanPath = path.replace(/^\/+/, '');
  const url = new URL(cleanPath, base);

  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
    }
  }

  return url.toString();
}

function parseLinkHeader(linkHeader: string | null): OnceHubLinks | undefined {
  if (!linkHeader) return undefined;

  const links: OnceHubLinks = {};

  for (const part of linkHeader.split(',')) {
    const section = part.trim();
    const urlMatch = section.match(/<([^>]+)>/);
    const relMatch = section.match(/rel="([^"]+)"/);

    if (!urlMatch || !relMatch) continue;

    const rel = relMatch[1] as OnceHubLinkRel;
    if (rel === 'next' || rel === 'previous') {
      links[rel] = urlMatch[1];
    }
  }

  return Object.keys(links).length ? links : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeBackoffMs(attempt: number, retryAfterHeader?: string | null): number {
  // Prefer Retry-After (seconds) when present
  if (retryAfterHeader) {
    const asNum = Number(retryAfterHeader);
    if (!Number.isNaN(asNum) && asNum > 0) return asNum * 1000;
  }

  // Exponential + jitter (simple)
  const base = 500; // 0.5s
  const max = 10_000; // cap
  const exp = Math.min(max, base * 2 ** attempt);
  const jitter = Math.floor(Math.random() * 250);
  return exp + jitter;
}

export async function fetchOnceHub<T = unknown>(
  path: string,
  opts: FetchOnceHubOptions = {}
): Promise<OnceHubResult<T>> {
  assertConfigured();
  const apiKey = ONCEHUB_API_KEY;

  const method = opts.method ?? 'GET';
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;

  const url = buildUrl(path, opts.query);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        method,
        headers: {
          // OnceHub auth header name is API-Key (server-side only). See docs.
          'API-Key': apiKey,
          Accept: 'application/json',
          ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}),
          ...(opts.headers ?? {})
        },
        body: method === 'GET' ? undefined : JSON.stringify(opts.body ?? {}),
        signal: controller.signal
      });

      clearTimeout(timer);

      const requestId = res.headers.get('Request-Id') ?? undefined;
      const links = parseLinkHeader(res.headers.get('Link'));

      let payload: any = null;
      const text = await res.text();
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = text; // non-JSON edge case
      }

      if (res.ok) {
        return {
          ok: true,
          status: res.status,
          requestId,
          links,
          data: payload as T
        };
      }

      // Retry on 429 + common transient 5xx
      const shouldRetry =
        res.status === 429 || res.status === 500 || res.status === 502 || res.status === 503 || res.status === 504;

      if (shouldRetry && attempt < maxRetries) {
        const waitMs = computeBackoffMs(attempt, res.headers.get('Retry-After'));
        await sleep(waitMs);
        continue;
      }

      return {
        ok: false,
        status: res.status,
        requestId,
        links,
        error: {
          type: payload?.type,
          message: payload?.message ?? res.statusText,
          param: payload?.param,
          raw: payload
        }
      };
    } catch (err: any) {
      clearTimeout(timer);

      // Network/timeout: retry like 5xx
      if (attempt < maxRetries) {
        const waitMs = computeBackoffMs(attempt);
        await sleep(waitMs);
        continue;
      }

      return {
        ok: false,
        status: 0,
        error: {
          type: 'network_error',
          message: err?.message ?? 'Unknown network error',
          raw: err
        }
      };
    }
  }

  // Should be unreachable
  return { ok: false, status: 0, error: { type: 'unknown_error', message: 'Unreachable' } };
}
