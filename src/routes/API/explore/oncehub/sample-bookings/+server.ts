// src/routes/API/explore/oncehub/sample-bookings/+server.ts
import type { RequestHandler } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { ONCEHUB_EXPLORE_TOKEN } from '$env/static/private';
import { fetchOnceHub } from '$lib/server/oncehubClient';

const DEFAULT_LIMIT = 10;
const MAX_INVENTORY_DEPTH = 6;

function requireExploreAuth(request: Request) {
  // Dev-only bypass is convenient; remove when you deploy.
  if (dev) return;

  // Simple shared-secret guardrail (recommended for these exploration endpoints)
  if (!ONCEHUB_EXPLORE_TOKEN) {
    throw new Error('ONCEHUB_EXPLORE_TOKEN is not set (required outside dev)');
  }

  const token = request.headers.get('x-explore-token');
  if (!token || token !== ONCEHUB_EXPLORE_TOKEN) {
    const err: any = new Error('Forbidden');
    err.status = 403;
    throw err;
  }
}

function redactPII(value: unknown): unknown {
  // Conservative heuristic redaction: mask common PII-like keys.
  // Adjust as you learn the actual OnceHub payload field names.
  const SENSITIVE_KEY = /(email|name|phone|mobile|address|firstName|lastName)/i;

  if (Array.isArray(value)) return value.map(redactPII);

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(k)) {
        out[k] = v == null ? v : '[REDACTED]';
      } else {
        out[k] = redactPII(v);
      }
    }
    return out;
  }

  return value;
}

function collectFieldPaths(obj: unknown, depth = 0, prefix = ''): string[] {
  if (!obj || typeof obj !== 'object') return [];
  if (depth >= MAX_INVENTORY_DEPTH) return [];

  const paths: string[] = [];

  if (Array.isArray(obj)) {
    // For arrays, inspect the first element only to avoid huge inventories
    if (obj.length > 0) {
      paths.push(...collectFieldPaths(obj[0], depth + 1, `${prefix}[]`));
    }
    return paths;
  }

  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const p = prefix ? `${prefix}.${k}` : k;
    paths.push(p);

    if (v && typeof v === 'object') {
      paths.push(...collectFieldPaths(v, depth + 1, p));
    }
  }

  return paths;
}

export const GET: RequestHandler = async ({ request, url }) => {
  try {
    requireExploreAuth(request);

    const limitParam = url.searchParams.get('limit');
    const limit = Math.min(Number(limitParam ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 25);

    // List recent bookings. Pagination + base URL behavior is handled in oncehubClient.
    // OnceHub list endpoints support `limit` and cursor pagination; see docs.
    const res = await fetchOnceHub<any>('/bookings', { query: { limit } });

    if (!res.ok) {
      return new Response(
        JSON.stringify({
          ok: false,
          status: res.status,
          requestId: res.requestId,
          error: res.error
        }),
        { status: res.status || 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // OnceHub list envelopes may be `data: [...]` or plain arrays depending on endpoint/version.
    const raw = res.data;
    const bookings: any[] = Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : [];

    const redacted = bookings.map(redactPII);
    const fieldPaths = bookings.length ? collectFieldPaths(redacted[0]) : [];

    const payload = {
      ok: true,
      generatedAt: new Date().toISOString(),
      requestId: res.requestId,
      pagination: res.links ?? {},
      count: bookings.length,
      sample: redacted,
      fieldInventory: {
        topLevelKeys: bookings.length ? Object.keys((redacted[0] ?? {}) as Record<string, unknown>) : [],
        fieldPaths
      }
    };

    return new Response(JSON.stringify(payload), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (e: any) {
    const status = e?.status || 500;
    return new Response(
      JSON.stringify({
        ok: false,
        status,
        error: { message: e?.message ?? 'Unknown error' }
      }),
      { status, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
