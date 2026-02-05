// src/routes/API/engagement/caseload/+server.ts
import type { RequestHandler } from '@sveltejs/kit';
import {
  INTERCOM_ACCESS_TOKEN,
  INTERCOM_VERSION,
  INTERCOM_API_BASE
} from '$env/static/private';
import { randomUUID, createHash } from 'crypto';

const INTERCOM_BASE_URL = INTERCOM_API_BASE || 'https://api.intercom.io';
const INTERCOM_API_VERSION = INTERCOM_VERSION || '2.10';

const SECONDS_PER_DAY = 24 * 60 * 60;
const MAX_RETRIES = 3;

// ---- Strict per-request step budget ----
const STEP_BUDGET_MS = 20_000;
const STEP_SAFETY_MS = 1_250;

// Don’t start a new Intercom request if there’s less than this much time left in the step
const MIN_TIME_TO_START_REQUEST_MS = 4_500;

// ---- TTLs (in-memory, per job/session) ----
const JOB_TTL_MS = 10 * 60 * 1000;
const ADMIN_CACHE_TTL_MS = 10 * 60 * 1000;
const CONTACT_CACHE_TTL_MS = 60 * 60 * 1000;

// ---- Intercom constraints ----
const CONTACTS_IN_MAX = 50; // Intercom enforces max 50 elements for IN operator
// Use a conservative chunk size to stay well under common Intercom validation limits.
// (IN supports up to 50, but smaller chunks can be more reliable across instances.)
const CONTACT_CHUNK_SIZE = 15;
// Composite query max ~15 filters; avoid OR-of-equals entirely.

// Conversation attribute key for channel
const CHANNEL_ATTR_KEY = 'Channel';

// Channels that count as sessions
const SESSION_CHANNELS = ['Phone', 'Video Conference', 'Email', 'Chat'] as const;
type SessionChannel = (typeof SESSION_CHANNELS)[number];

// Contact attribute key for client (adjust if needed)
const CLIENT_ATTR_KEY = 'Employer';

// ---------- Types ----------

interface SessionRow {
  memberId: string;
  coachId: string | null;
  channel: SessionChannel;
  time: number; // unix seconds
}

interface MemberBuckets {
  bucket_1: boolean;
  bucket_2: boolean;
  bucket_3: boolean;
  bucket_4: boolean;
}

interface CaseloadMemberRow {
  memberId: string;
  memberName: string | null;
  memberEmail: string | null;
  client: string | null;
  coachIds: string[];
  coachNames: string[];
  channelsUsed: SessionChannel[];
  channelCombo: string;
  lastSessionAt: number;
  daysSinceLastSession: number;
  buckets: MemberBuckets;
}

interface CaseloadSummary {
  bucket_1: number;
  bucket_2: number;
  bucket_3: number;
  bucket_4: number;
}

interface AdminInfo {
  id: string;
  name: string | null;
  email: string | null;
}

type JobStatus = 'queued' | 'running' | 'complete' | 'error' | 'cancelled';
type JobPhase = 'conversations' | 'contacts' | 'finalize' | 'complete';

interface MemberAgg {
  lastSessionAt: number;
  channels: Set<SessionChannel>;
  coachIds: Set<string>;
}

interface JobContactCacheEntry {
  expiresAtMs: number;
  contact: any;
}

interface CaseloadJobState {
  id: string;

  lookbackDays: number;
  sinceUnix: number;
  untilUnix?: number;
  untilLookbackDays?: number;

  status: JobStatus;
  phase: JobPhase;

  createdAtMs: number;
  updatedAtMs: number;

  error?: string;

  // conversations/search cursor
  startingAfter?: string;

  // progress
  pagesFetched: number;
  conversationsFetched: number;
  sessionsCount: number;

  // aggregation
  memberIds: Set<string>;
  memberAgg: Map<string, MemberAgg>;
  sessions: SessionRow[];

  // per-job caches
  adminCache: {
    fetchedAtMs: number;
    map: Map<string, AdminInfo>;
  } | null;

  contactCache: Map<string, JobContactCacheEntry>;

  // abort handling
  consecutiveAbortErrors: number;

  // finalized
  generatedAt?: string;
  totalMembers?: number;
  summary?: CaseloadSummary;
  members?: CaseloadMemberRow[];
}

// ---------- In-memory store ----------
const jobs = new Map<string, CaseloadJobState>();

// ---------- Audit logging ----------
// Goal: human-readable, low-noise logs by default.
// Set CASELOAD_LOG_LEVEL=debug to emit per-request/per-page details.
type LogLevel = 'quiet' | 'info' | 'debug';
const LOG_LEVEL: LogLevel = (process.env.CASELOAD_LOG_LEVEL as LogLevel) || 'info';
const DEBUG = LOG_LEVEL === 'debug';
const QUIET = LOG_LEVEL === 'quiet';

function hashId(id: string) {
  try {
    return createHash('sha256').update(id).digest('hex').slice(0, 8);
  } catch {
    return 'unknown';
  }
}

function audit(
  jobId: string,
  event: string,
  data: Record<string, any> = {},
  level: 'info' | 'debug' | 'warn' = 'info'
) {
  if (QUIET) return;
  if (!DEBUG && level === 'debug') return;

  // Keep log lines compact and readable (and avoid PHI).
  const base = [`CONSUL_AUDIT`, `job=${jobId}`, `event=${event}`];

  // Only print a small set of common fields at info level.
  const fields: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue;
    // prevent huge objects from clogging logs
    if (typeof v === 'object') continue;
    fields.push(`${k}=${String(v)}`);
  }

  console.info([...base, ...fields].join(' '));

  // In debug, also emit the full JSON payload for deep troubleshooting.
  if (DEBUG) {
    console.info(
      'CONSUL_AUDIT_JSON ' +
        JSON.stringify({
          ts: new Date().toISOString(),
          service: 'engagement-caseload',
          jobId,
          event,
          ...data
        })
    );
  }
}



// ---------- Helpers ----------
function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanExpiredJobs(nowMs: number) {
  for (const [id, job] of jobs.entries()) {
    if (nowMs - job.updatedAtMs > JOB_TTL_MS) {
      audit(id, 'job_expired', { ageMs: nowMs - job.updatedAtMs });
      jobs.delete(id);
    }
  }
}

function computeBuckets(daysSince: number): MemberBuckets {
  return {
    bucket_1: daysSince <= 7,
    bucket_2: daysSince > 7 && daysSince <= 28,
    bucket_3: daysSince > 28 && daysSince <= 56,
    bucket_4: daysSince > 56
  };
}

function getCachedContact(job: CaseloadJobState, id: string): any | null {
  const entry = job.contactCache.get(id);
  if (!entry) return null;
  if (Date.now() > entry.expiresAtMs) {
    job.contactCache.delete(id);
    return null;
  }
  return entry.contact;
}

function setCachedContact(job: CaseloadJobState, contact: any) {
  const id = String(contact?.id ?? '');
  if (!id) return;
  job.contactCache.set(id, {
    expiresAtMs: Date.now() + CONTACT_CACHE_TTL_MS,
    contact
  });
}

function setNotFoundContact(job: CaseloadJobState, id: string) {
  const safeId = String(id ?? '');
  if (!safeId) return;

  // Store a placeholder so we don't re-request this ID forever.
  job.contactCache.set(safeId, {
    expiresAtMs: Date.now() + CONTACT_CACHE_TTL_MS,
    contact: {
      id: safeId,
      name: null,
      email: null,
      custom_attributes: {},
      _notFound: true
    }
  });
}

function timeLeftMs(deadlineMs: number) {
  return deadlineMs - Date.now();
}

function isAbortError(e: any) {
  // Node fetch + AbortController typically throws DOMException with name 'AbortError'
  return e?.name === 'AbortError' || String(e?.message ?? '').toLowerCase().includes('aborted');
}

// ---------- Intercom request ----------
async function intercomRequest(
  path: string,
  init: RequestInit = {},
  opts: {
    jobId?: string;
    tag?: string;
    deadlineMs?: number;
    timeoutMs?: number;
    attempt?: number;
  } = {}
): Promise<any> {
  if (!INTERCOM_ACCESS_TOKEN) {
    throw new Error('INTERCOM_ACCESS_TOKEN is not set');
  }

  const attempt = opts.attempt ?? 1;

  // Compute timeout based on remaining step time if provided
  const defaultTimeout = 18_000; // was too low at 12s for large windows
  const maxTimeout = 25_000;
  const minTimeout = 4_000;

  let timeoutMs = opts.timeoutMs ?? defaultTimeout;
  if (opts.deadlineMs) {
    // Leave a tiny buffer so the handler can still respond
    timeoutMs = Math.min(timeoutMs, Math.max(minTimeout, timeLeftMs(opts.deadlineMs) - 500));
  }
  timeoutMs = Math.min(maxTimeout, Math.max(minTimeout, timeoutMs));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const started = Date.now();
  try {
    const res = await fetch(`${INTERCOM_BASE_URL}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${INTERCOM_ACCESS_TOKEN}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Intercom-Version': INTERCOM_API_VERSION,
        ...(init.headers ?? {})
      }
    });

    const ms = Date.now() - started;

    if (opts.jobId && opts.tag) {
      if (DEBUG) {
        audit(opts.jobId, 'intercom_response', { tag: opts.tag, path, status: res.status, ms }, 'debug');
      } else if (ms >= 5000) {
        audit(opts.jobId, 'intercom_slow', { tag: opts.tag, path, status: res.status, ms }, 'warn');
      }
    }

    if (res.status === 429 && attempt < MAX_RETRIES) {
      const retryAfterHeader = res.headers.get('Retry-After');
      const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : NaN;
      const delaySeconds = Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : 2 ** attempt;

      if (opts.jobId) {
        audit(opts.jobId, 'intercom_rate_limited', {
          path,
          tag: opts.tag ?? null,
          attempt,
          delaySeconds
        });
      }

      await sleep(delaySeconds * 1000);
      return intercomRequest(path, init, { ...opts, attempt: attempt + 1 });
    }

    if (!res.ok) {
      const text = await res.text();
      // Try to extract request_id for auditing
      let requestId: string | null = null;
      try {
        const j = JSON.parse(text);
        requestId = j?.request_id ?? null;
      } catch {
        // ignore
      }
      if (opts.jobId) {
        audit(opts.jobId, 'intercom_error', {
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
      if (opts.jobId) {
        audit(opts.jobId, 'intercom_abort', {
          path,
          tag: opts.tag ?? null,
          timeoutMs,
          ms
        });
      }
      // Surface a consistent abort error message
      const err = new Error(`Intercom request aborted on ${path} after ${timeoutMs}ms`);
      // Preserve AbortError classification for caller logic
      (err as any).name = 'AbortError';
      throw err;
    }

    if (opts.jobId) {
      audit(opts.jobId, 'intercom_exception', {
        path,
        tag: opts.tag ?? null,
        ms,
        message: e?.message ?? String(e)
      });
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Intercom paging ----------
async function fetchConversationsSearchPage(
  job: CaseloadJobState,
  deadlineMs: number
): Promise<{ conversations: any[]; nextCursor?: string }> {
  const filters: any[] = [
    { field: 'state', operator: '=', value: 'closed' },
    { field: 'updated_at', operator: '>', value: job.sinceUnix }
  ];
  if (typeof job.untilUnix === 'number') {
    filters.push({ field: 'updated_at', operator: '<', value: job.untilUnix });
  }

  const body: any = {
    query: { operator: 'AND', value: filters },
    pagination: { per_page: 150 }
  };

  if (job.startingAfter) body.pagination.starting_after = job.startingAfter;

  const data = await intercomRequest('/conversations/search', {
    method: 'POST',
    body: JSON.stringify(body)
  }, {
    jobId: job.id,
    tag: 'conversations.search',
    deadlineMs
  });

  const conversations = data.conversations ?? data.data ?? [];
  const nextCursor: string | undefined = data.pages?.next?.starting_after;

  return { conversations, nextCursor };
}

async function fetchAdminsCached(job: CaseloadJobState, deadlineMs?: number): Promise<Map<string, AdminInfo>> {
  const now = Date.now();
  if (job.adminCache && now - job.adminCache.fetchedAtMs < ADMIN_CACHE_TTL_MS) {
    return job.adminCache.map;
  }

  const data = await intercomRequest('/admins', { method: 'GET' }, {
    jobId: job.id,
    tag: 'admins.list',
    deadlineMs
  });

  const admins = data.admins ?? data.data ?? [];
  const map = new Map<string, AdminInfo>();

  for (const a of admins) {
    const id = String(a.id);
    map.set(id, { id, name: a.name ?? null, email: a.email ?? null });
  }

  job.adminCache = { fetchedAtMs: now, map };
  audit(job.id, 'admins_cached', { count: map.size });

  return map;
}

/**
 * Batch hydrate contacts using /contacts/search with id IN [...] (max 50 values).
 * Notes:
 * - Intercom IN operator requires array length <= 50.
 * - Avoid composite OR queries entirely (composite query max is 15 elements).
 * - If Intercom returns 200 but omits some IDs (deleted/merged leads/users),
 *   we store a placeholder so we don't loop forever.
 */
async function hydrateContactsByIds(
  job: CaseloadJobState,
  ids: string[],
  deadlineMs: number
): Promise<{ fetched: number; attempted: number; remaining: number; notFound: number }> {
  const unique = [...new Set(ids)].filter(Boolean).map(String);

  const missing = unique.filter((id) => !getCachedContact(job, id));
  if (missing.length === 0) return { fetched: 0, attempted: 0, remaining: 0, notFound: 0 };

  let fetched = 0;
  let attempted = 0;
  let notFound = 0;

  for (let i = 0; i < missing.length; i += CONTACT_CHUNK_SIZE) {
    // Don't start a new request if we're too close to the step deadline.
    if (timeLeftMs(deadlineMs) < MIN_TIME_TO_START_REQUEST_MS) break;

    const chunk = missing.slice(i, i + CONTACT_CHUNK_SIZE).map(String);
    if (chunk.length === 0) continue;

    attempted += chunk.length;

    audit(job.id, 'contacts_search_plan', { mode: 'IN', chunkSize: chunk.length }, 'debug');

    const body = {
      query: { field: 'id', operator: 'IN', value: chunk },
      pagination: { per_page: 150 }
    };

    const data = await intercomRequest(
      '/contacts/search',
      { method: 'POST', body: JSON.stringify(body) },
      { jobId: job.id, tag: 'contacts.search', deadlineMs }
    );

    const contacts = (data.data ?? data.contacts ?? []) as any[];
    const returnedIds = new Set<string>(contacts.map((c) => String(c?.id ?? '')).filter(Boolean));

    for (const c of contacts) {
      setCachedContact(job, c);
      fetched += 1;
    }

    // Mark any IDs not returned as "not found" to avoid infinite loops.
    let notFoundThisChunk = 0;
    for (const id of chunk) {
      if (!returnedIds.has(id)) {
        setNotFoundContact(job, id);
        notFound += 1;
        notFoundThisChunk += 1;
      }
    }

    // Only log chunky details when something unusual happened or in debug.
    if (notFoundThisChunk > 0) {
      audit(job.id, 'contacts_not_found', { count: notFoundThisChunk }, 'warn');
      // In debug, include a hashed sample so you can correlate without leaking identifiers.
      if (DEBUG) {
        const sample = chunk
          .filter((id) => !returnedIds.has(id))
          .slice(0, 5)
          .map((id) => hashId(id))
          .join(',');
        audit(job.id, 'contacts_not_found_sample', { hashes: sample }, 'debug');
      }
    }

    if (DEBUG) {
      audit(job.id, 'contacts_chunk', {
        chunkSize: chunk.length,
        fetchedThisChunk: contacts.length,
        notFoundThisChunk
      }, 'debug');
    }
  }

  // compute remaining missing (ignores IDs we marked as notFound because they're cached as placeholders)
  let remaining = 0;
  for (const id of job.memberIds) {
    if (!getCachedContact(job, id)) remaining += 1;
  }

  return { fetched, attempted, remaining, notFound };
}


// ---------- Job logic ----------
function createJob(lookbackDays: number, untilLookbackDays?: number): CaseloadJobState {
  const nowUnix = Math.floor(Date.now() / 1000);
  const sinceUnix = nowUnix - lookbackDays * SECONDS_PER_DAY;
  const untilUnix =
    typeof untilLookbackDays === 'number' && untilLookbackDays > 0 && untilLookbackDays < lookbackDays
      ? nowUnix - untilLookbackDays * SECONDS_PER_DAY
      : undefined;
  const id = randomUUID();
  const nowMs = Date.now();

  const job: CaseloadJobState = {
    id,
    lookbackDays,
    sinceUnix,
    untilUnix,
    untilLookbackDays,
    status: 'queued',
    phase: 'conversations',
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    pagesFetched: 0,
    conversationsFetched: 0,
    sessionsCount: 0,
    memberIds: new Set(),
    memberAgg: new Map(),
    sessions: [],
    adminCache: null,
    contactCache: new Map(),
    consecutiveAbortErrors: 0
  };

  jobs.set(id, job);

  audit(id, 'job_create', { lookbackDays, sinceUnix, untilLookbackDays: untilLookbackDays ?? null, untilUnix: untilUnix ?? null });

  return job;
}

function upsertMemberAgg(job: CaseloadJobState, s: SessionRow) {
  let agg = job.memberAgg.get(s.memberId);
  if (!agg) {
    agg = { lastSessionAt: 0, channels: new Set(), coachIds: new Set() };
    job.memberAgg.set(s.memberId, agg);
  }
  if (s.time > agg.lastSessionAt) agg.lastSessionAt = s.time;
  agg.channels.add(s.channel);
  if (s.coachId) agg.coachIds.add(s.coachId);
  job.memberIds.add(s.memberId);
}

function parseSessionFromConversation(conv: any): SessionRow | null {
  const attrs = conv.custom_attributes || {};
  const channelValue = attrs[CHANNEL_ATTR_KEY] as string | undefined;
  if (!channelValue) return null;

  if (!SESSION_CHANNELS.includes(channelValue as SessionChannel)) return null;
  const channel = channelValue as SessionChannel;

  const contactsList = conv.contacts?.contacts || [];
  if (!contactsList.length) return null;

  const memberId = String(contactsList[0].id);

  const stats = conv.statistics || {};
  const sessionTime: number | undefined =
    stats.last_close_at ||
    stats.last_admin_reply_at ||
    conv.updated_at ||
    conv.created_at;

  if (!sessionTime) return null;

  const coachId =
    conv.admin_assignee_id != null ? String(conv.admin_assignee_id) : null;

  return { memberId, coachId, channel, time: sessionTime };
}

async function stepJob(job: CaseloadJobState): Promise<any> {
  const stepStart = Date.now();
  const deadlineMs = stepStart + STEP_BUDGET_MS - STEP_SAFETY_MS;

  job.status = 'running';
  job.updatedAtMs = Date.now();

  audit(job.id, 'job_step_start', {
    phase: job.phase,
    timeBudgetMs: STEP_BUDGET_MS
  });

  try {
    // Warm admins cache (cheap)
    if (timeLeftMs(deadlineMs) >= MIN_TIME_TO_START_REQUEST_MS) {
      await fetchAdminsCached(job, deadlineMs);
    }

    // Phase 1: conversations
    if (job.phase === 'conversations') {
      while (timeLeftMs(deadlineMs) >= MIN_TIME_TO_START_REQUEST_MS) {
        try {
          const { conversations, nextCursor } = await fetchConversationsSearchPage(job, deadlineMs);

          job.consecutiveAbortErrors = 0;

          job.pagesFetched += 1;
          job.conversationsFetched += conversations.length;

          let sessionsAdded = 0;
          for (const conv of conversations) {
            const s = parseSessionFromConversation(conv);
            if (!s) continue;
            job.sessions.push(s);
            job.sessionsCount += 1;
            sessionsAdded += 1;
            upsertMemberAgg(job, s);
          }

          audit(job.id, 'conversations_page', {
            page: job.pagesFetched,
            conversations: conversations.length,
            sessionsAdded,
            nextCursor: nextCursor ? 'present' : null
          }, 'debug');

          job.startingAfter = nextCursor;

          // Finished paging
          if (!nextCursor) {
            job.phase = 'contacts';
            audit(job.id, 'phase_advance', { to: 'contacts' });
            break;
          }

          // Safety: avoid spin on empty pages with cursor
          if (conversations.length === 0 && nextCursor) break;
        } catch (e: any) {
          if (isAbortError(e)) {
            job.consecutiveAbortErrors += 1;
            audit(job.id, 'step_abort_soft', {
              phase: job.phase,
              consecutiveAbortErrors: job.consecutiveAbortErrors
            });

            // If we keep aborting repeatedly, fail the job (signals a real network/path issue)
            if (job.consecutiveAbortErrors >= 3) {
              throw e;
            }

            // Otherwise end this step early; next step will continue
            break;
          }
          throw e;
        }
      }
    }

    // Phase 2: contacts (batched, <=50 IN)
    if (job.phase === 'contacts') {
      const ids = Array.from(job.memberIds);

      try {
        const result = await hydrateContactsByIds(job, ids, deadlineMs);
        job.consecutiveAbortErrors = 0;

        audit(job.id, 'contacts_hydrate', {
          uniqueMembers: job.memberIds.size,
          attempted: result.attempted,
          fetched: result.fetched,
          remaining: result.remaining,
          notFound: result.notFound
        });

        if (result.remaining === 0) {
          job.phase = 'finalize';
          audit(job.id, 'phase_advance', { to: 'finalize' });
        }
      } catch (e: any) {
        if (isAbortError(e)) {
          job.consecutiveAbortErrors += 1;
          audit(job.id, 'step_abort_soft', {
            phase: job.phase,
            consecutiveAbortErrors: job.consecutiveAbortErrors
          });

          if (job.consecutiveAbortErrors >= 3) {
            throw e;
          }
          // end step early
        } else {
          throw e;
        }
      }
    }

    // Phase 3: finalize
    if (job.phase === 'finalize') {
      const nowUnix = Math.floor(Date.now() / 1000);
      const adminMap = await fetchAdminsCached(job, deadlineMs);

      const members: CaseloadMemberRow[] = [];

      for (const [memberId, agg] of job.memberAgg.entries()) {
        const contact = getCachedContact(job, memberId) || {};
        const memberName = contact.name ?? null;
        const memberEmail = contact.email ?? null;
        const attrs = contact.custom_attributes || {};
        const client = (attrs[CLIENT_ATTR_KEY] as string) ?? null;

        const lastSessionAt = agg.lastSessionAt || 0;
        if (!lastSessionAt) continue;

        const daysSinceLastSession = (nowUnix - lastSessionAt) / SECONDS_PER_DAY;

        const channelsUsed = Array.from(agg.channels).sort();
        const channelCombo = channelsUsed.join(' + ') || '(none)';

        const coachIds = Array.from(agg.coachIds).sort();
        const coachNames = coachIds.map((id) => adminMap.get(id)?.name ?? id);

        members.push({
          memberId,
          memberName,
          memberEmail,
          client,
          coachIds,
          coachNames,
          channelsUsed,
          channelCombo,
          lastSessionAt,
          daysSinceLastSession,
          buckets: computeBuckets(daysSinceLastSession)
        });
      }

      const summary: CaseloadSummary = {
        bucket_1: 0,
        bucket_2: 0,
        bucket_3: 0,
        bucket_4: 0
      };

      for (const m of members) {
        if (m.buckets.bucket_1) summary.bucket_1 += 1;
        if (m.buckets.bucket_2) summary.bucket_2 += 1;
        if (m.buckets.bucket_3) summary.bucket_3 += 1;
        if (m.buckets.bucket_4) summary.bucket_4 += 1;
      }

      job.members = members;
      job.summary = summary;
      job.totalMembers = members.length;
      job.generatedAt = new Date(nowUnix * 1000).toISOString();

      job.phase = 'complete';
      job.status = 'complete';

      audit(job.id, 'job_complete', {
        totalMembers: job.totalMembers,
        sessionsCount: job.sessionsCount,
        pagesFetched: job.pagesFetched,
        conversationsFetched: job.conversationsFetched
      });
    }

    job.updatedAtMs = Date.now();

    // progress response
    let missingContacts = 0;
    for (const id of job.memberIds) {
      if (!getCachedContact(job, id)) missingContacts += 1;
    }

    const stepMs = Date.now() - stepStart;
    audit(job.id, 'job_step_end', {
      phase: job.phase,
      status: job.status,
      stepMs
    });

    return {
      jobId: job.id,
      status: job.status,
      phase: job.phase,
      done: job.status === 'complete',
      lookbackDays: job.lookbackDays,
      sinceUnix: job.sinceUnix,
      progress: {
        pagesFetched: job.pagesFetched,
        conversationsFetched: job.conversationsFetched,
        sessionsCount: job.sessionsCount,
        uniqueMembers: job.memberIds.size,
        missingContacts
      },
      cursor: job.startingAfter ?? null,
      updatedAt: new Date(job.updatedAtMs).toISOString()
    };
  } catch (err: any) {
    job.status = 'error';
    job.phase = 'complete';
    job.error = err?.message ?? String(err);
    job.updatedAtMs = Date.now();

    audit(job.id, 'job_error', {
      message: job.error
    });

    return {
      jobId: job.id,
      status: job.status,
      phase: job.phase,
      done: true,
      error: job.error
    };
  }
}

// ---------- Result paging ----------
async function buildSessionDetailsSlice(
  job: CaseloadJobState,
  offset: number,
  limit: number
): Promise<{ items: any[]; nextOffset: number | null; total: number }> {
  const adminMap = await fetchAdminsCached(job);
  const nowUnix = Math.floor(Date.now() / 1000);

  const total = job.sessions.length;
  const slice = job.sessions.slice(offset, offset + limit);

  const items = slice.map((s) => {
    const contact = getCachedContact(job, s.memberId) || {};
    const memberName = contact.name ?? null;
    const memberEmail = contact.email ?? null;
    const attrs = contact.custom_attributes || {};
    const client = (attrs[CLIENT_ATTR_KEY] as string) ?? null;

    const coachName =
      s.coachId != null ? adminMap.get(s.coachId)?.name ?? null : null;

    const daysSince = (nowUnix - s.time) / SECONDS_PER_DAY;

    return {
      memberId: s.memberId,
      memberName,
      memberEmail,
      client,
      coachId: s.coachId,
      coachName,
      channel: s.channel,
      time: s.time,
      daysSince
    };
  });

  const nextOffset = offset + limit < total ? offset + limit : null;
  return { items, nextOffset, total };
}

// ---------- Handlers ----------
export const POST: RequestHandler = async ({ request }) => {
  cleanExpiredJobs(Date.now());

  let body: any = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const op = String(body.op ?? 'create');
  if (op === 'create') {
    const parsed = Number(body.lookbackDays);
    if (Number.isNaN(parsed) || parsed <= 0) {
      return new Response(
        JSON.stringify({
          error: 'Invalid lookbackDays',
          details: 'lookbackDays must be a positive number of days (1–365).'
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const lookbackDays = Math.min(parsed, 365);

    // Optional: bound the upper end of the window so the client can fetch *only* the incremental delta
    // when increasing lookbackDays (e.g., fetch updated_at between now-lookbackDays and now-untilLookbackDays).
    const untilRaw = body.untilLookbackDays;
    const untilLookbackDays = untilRaw == null ? undefined : Number(untilRaw);
    if (untilLookbackDays != null) {
      if (Number.isNaN(untilLookbackDays) || untilLookbackDays <= 0) {
        return new Response(
          JSON.stringify({
            error: 'Invalid untilLookbackDays',
            details: 'untilLookbackDays must be a positive number.'
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    const job = createJob(lookbackDays, untilLookbackDays);

    return new Response(
      JSON.stringify({
        jobId: job.id,
        status: job.status,
        phase: job.phase,
        lookbackDays: job.lookbackDays,
        sinceUnix: job.sinceUnix,
        untilUnix: job.untilUnix ?? null
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (op === 'step') {
    const jobId = String(body.jobId ?? '');
    if (!jobId) {
      return new Response(JSON.stringify({ error: 'Missing jobId' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const job = jobs.get(jobId);
    if (!job) {
      return new Response(JSON.stringify({ error: 'Job not found', jobId }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (job.status === 'complete' || job.status === 'error' || job.status === 'cancelled') {
      return new Response(
        JSON.stringify({
          jobId: job.id,
          status: job.status,
          phase: job.phase,
          done: true,
          error: job.error ?? null
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    const progress = await stepJob(job);
    return new Response(JSON.stringify(progress), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (op === 'cleanup') {
    const jobId = String(body.jobId ?? '');
    if (!jobId) {
      return new Response(JSON.stringify({ error: 'Missing jobId' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const existed = jobs.delete(jobId);
    audit(jobId, 'job_cleanup', { deleted: existed });

    return new Response(JSON.stringify({ jobId, deleted: existed }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (op === 'cancel') {
    const jobId = String(body.jobId ?? '');
    const job = jobId ? jobs.get(jobId) : null;
    if (!job) {
      return new Response(JSON.stringify({ error: 'Job not found', jobId }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    job.status = 'cancelled';
    job.phase = 'complete';
    job.updatedAtMs = Date.now();

    audit(jobId, 'job_cancelled');

    return new Response(JSON.stringify({ jobId: job.id, status: job.status, done: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  return new Response(
    JSON.stringify({
      error: 'Unknown op',
      details: 'Supported ops: create, step, cancel, cleanup'
    }),
    { status: 400, headers: { 'Content-Type': 'application/json' } }
  );
};

export const GET: RequestHandler = async ({ url }) => {
  cleanExpiredJobs(Date.now());

  const jobId = url.searchParams.get('jobId') ?? '';
  if (!jobId) {
    return new Response(
      JSON.stringify({
        error: 'Missing jobId',
        usage:
          'GET ?jobId=... (status) or ?jobId=...&view=summary|members|sessions&offset=0&limit=500'
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const job = jobs.get(jobId);
  if (!job) {
    return new Response(JSON.stringify({ error: 'Job not found', jobId }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const view = url.searchParams.get('view');

  if (!view) {
    let missingContacts = 0;
    for (const id of job.memberIds) {
      if (!getCachedContact(job, id)) missingContacts += 1;
    }

    return new Response(
      JSON.stringify({
        jobId: job.id,
        status: job.status,
        phase: job.phase,
        done: job.status === 'complete' || job.status === 'error' || job.status === 'cancelled',
        lookbackDays: job.lookbackDays,
        sinceUnix: job.sinceUnix,
        cursor: job.startingAfter ?? null,
        progress: {
          pagesFetched: job.pagesFetched,
          conversationsFetched: job.conversationsFetched,
          sessionsCount: job.sessionsCount,
          uniqueMembers: job.memberIds.size,
          missingContacts
        },
        error: job.error ?? null,
        updatedAt: new Date(job.updatedAtMs).toISOString()
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (job.status !== 'complete') {
    return new Response(
      JSON.stringify({
        error: 'Job not complete',
        status: job.status,
        phase: job.phase
      }),
      { status: 409, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (view === 'summary') {
    return new Response(
      JSON.stringify({
        lookbackDays: job.lookbackDays,
        generatedAt: job.generatedAt,
        totalMembers: job.totalMembers ?? 0,
        summary: job.summary ?? null,
        counts: {
          members: job.members?.length ?? 0,
          sessions: job.sessions.length
        }
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0));
  const limit = Math.min(5000, Math.max(1, Number(url.searchParams.get('limit') ?? 500)));

  if (view === 'members') {
    const members = job.members ?? [];
    const items = members.slice(offset, offset + limit);
    const nextOffset = offset + limit < members.length ? offset + limit : null;

    return new Response(JSON.stringify({ items, nextOffset, total: members.length }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (view === 'sessions') {
    const { items, nextOffset, total } = await buildSessionDetailsSlice(job, offset, limit);
    return new Response(JSON.stringify({ items, nextOffset, total }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  return new Response(
    JSON.stringify({
      error: 'Unknown view',
      details: 'Supported views: summary, members, sessions'
    }),
    { status: 400, headers: { 'Content-Type': 'application/json' } }
  );
};
