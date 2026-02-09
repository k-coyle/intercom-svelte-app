// src/routes/API/explore/oncehub/sample-bookings/+server.ts
import type { RequestHandler } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { ONCEHUB_EXPLORE_TOKEN } from '$env/static/private';
import { fetchOnceHub } from '$lib/server/oncehubClient';

const DEFAULT_LIMIT = 25;
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
  // Keys whose *values* should be redacted (but we still preserve object/array shape)
  const REDACT_VALUE_KEY = /^(email|name|firstName|lastName|phone|mobile_phone|mobilePhone|address|join_url|location_description)$/i;

  // Keys that are often arrays of sensitive strings
  const REDACT_ARRAY_ELEMS_KEY = /^(test|test)$/i;

  const looksLikeEmail = (s: string) => /[^\s@]+@[^\s@]+\.[^\s@]+/.test(s);
  const looksLikePhone = (s: string) => s.replace(/\D/g, '').length >= 10;
  const looksLikeUrl = (s: string) => /^https?:\/\//i.test(s);

  const redactStringIfNeeded = (s: string) => {
    if (looksLikeEmail(s) || looksLikePhone(s) || looksLikeUrl(s)) return '[REDACTED]';
    return s;
  };

  const walk = (v: unknown, parentKey?: string): unknown => {
    if (typeof v === 'string') return redactStringIfNeeded(v);

    if (Array.isArray(v)) {
      // If this array lives under something like "attendees", redact each element but keep the array
      if (parentKey && REDACT_ARRAY_ELEMS_KEY.test(parentKey)) {
        return v.map((item) => (typeof item === 'string' ? '[REDACTED]' : walk(item)));
      }
      return v.map((item) => walk(item));
    }

    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
        // If the key is sensitive:
        // - redact leaf primitives
        // - recurse into objects/arrays to preserve schema shape
        if (REDACT_VALUE_KEY.test(k)) {
          if (child && typeof child === 'object') out[k] = walk(child, k);
          else out[k] = '[REDACTED]';
        } else {
          out[k] = walk(child, k);
        }
      }
      return out;
    }

    return v;
  };

  return walk(value);
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
    const limit = Math.min(Number(limitParam ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 50);

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

    const redacted = bookings;

    // union inventory across ALL samples
    const topLevelKeysSet = new Set<string>();
    const fieldPathsSet = new Set<string>();

    for (const item of redacted) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        Object.keys(item as Record<string, unknown>).forEach((k) => topLevelKeysSet.add(k));
      }
      collectFieldPaths(item).forEach((p) => fieldPathsSet.add(p));
    }

    const topLevelKeys = Array.from(topLevelKeysSet).sort();
    const fieldPaths = Array.from(fieldPathsSet).sort();

    // quick distincts across the sample (helps you confirm “model dimensions” fast)
    const distinctStatus = new Map<string, number>();
    const distinctEventType = new Map<string, number>();
    const distinctOwner = new Map<string, number>();

    let contactPresent = 0;

    for (const b of bookings) {
      const status = typeof b?.status === 'string' ? b.status : '(missing)';
      distinctStatus.set(status, (distinctStatus.get(status) ?? 0) + 1);

      const eventType = typeof b?.event_type === 'string' ? b.event_type : '(missing)';
      distinctEventType.set(eventType, (distinctEventType.get(eventType) ?? 0) + 1);

      const owner = typeof b?.owner === 'string' ? b.owner : '(missing)';
      distinctOwner.set(owner, (distinctOwner.get(owner) ?? 0) + 1);

      if (b?.contact) contactPresent++;
    }

    const toSortedObj = (m: Map<string, number>) =>
      Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1]));

    const payload = {
      ok: true,
      generatedAt: new Date().toISOString(),
      requestId: res.requestId,
      pagination: res.links ?? {},
      count: bookings.length,
      sample: redacted,
      fieldInventory: { topLevelKeys, fieldPaths },
      quickStats: {
        sampleSize: bookings.length,
        distinctStatus: toSortedObj(distinctStatus),
        distinctEventType: toSortedObj(distinctEventType),
        distinctOwner: toSortedObj(distinctOwner),
        contactPresentPct: bookings.length ? Math.round((contactPresent / bookings.length) * 100) : 0
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
