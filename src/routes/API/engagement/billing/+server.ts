// src/routes/API/engagement/billing/+server.ts
import type { RequestHandler } from '@sveltejs/kit';
import {
  fetchContactsByIds,
  intercomRequest,
  INTERCOM_MAX_PER_PAGE
} from '$lib/server/intercom';
import {
  INTERCOM_ATTR_CHANNEL,
  INTERCOM_ATTR_EMPLOYER,
  INTERCOM_ATTR_ENROLLED_DATE
} from '$lib/server/intercom-attrs';

const SECONDS_PER_DAY = 24 * 60 * 60;

// Attribute keys
const ENROLLED_ATTR_KEY = INTERCOM_ATTR_ENROLLED_DATE;
const EMPLOYER_ATTR_KEY = INTERCOM_ATTR_EMPLOYER;
const CHANNEL_ATTR_KEY = INTERCOM_ATTR_CHANNEL;

// Engagement definition
const ENGAGED_DAYS = 57; // "<57 days ago"
const ENGAGED_TAIL_DAYS = ENGAGED_DAYS - 1; // 56
const REPORT_TZ = 'America/New_York';

// Channels that count as billing "qualifying sessions"
const SESSION_CHANNELS = ['Phone', 'Video Conference'] as const;
type SessionChannel = (typeof SESSION_CHANNELS)[number];

// Job/runtime controls
const STEP_BUDGET_MS = 20_000;
const STEP_SAFETY_MS = 1_250;
const MIN_TIME_TO_START_REQUEST_MS = 4_500;
const JOB_TTL_MS = 10 * 60 * 1000;

const CONVERSATIONS_PER_PAGE = Math.min(100, INTERCOM_MAX_PER_PAGE);
const CONTACTS_PER_PAGE = INTERCOM_MAX_PER_PAGE;
const CONTACT_FETCH_BATCH_SIZE = 20;
const CONTACT_FETCH_CONCURRENCY = 5;

interface BillingRow {
  memberId: string;
  memberName: string | null;
  memberEmail: string | null;
  employer: string | null;
  registrationAt: number | null; // Enrolled Date
  lastSessionAt: number | null; // unix seconds
  isNewParticipant: boolean;
  engagedDuringMonth: boolean;
}

interface BillingReport {
  year: number;
  month: number; // 1-12
  monthYearLabel: string; // e.g. "2025-09"
  monthStart: string; // ISO
  monthEnd: string; // ISO
  generatedAt: string;
  totalRows: number;
  rows: BillingRow[];
}

type JobStatus = 'queued' | 'running' | 'complete' | 'error' | 'cancelled';
type JobPhase = 'conversations' | 'participants' | 'hydrate' | 'finalize' | 'complete';

interface BillingJobState {
  id: string;
  monthYearLabel: string;

  year: number;
  month: number;
  monthStartUnix: number;
  monthEndUnix: number;
  monthStartISO: string;
  monthEndISO: string;
  engagedTailWindowStartUnix: number;

  status: JobStatus;
  phase: JobPhase;

  createdAtMs: number;
  updatedAtMs: number;
  error?: string;

  // cursors
  conversationsStartingAfter?: string;
  participantsStartingAfter?: string;

  // progress
  conversationPagesFetched: number;
  conversationsFetched: number;
  conversationsProcessed: number;

  participantPagesFetched: number;
  participantsFetched: number;

  contactsFetched: number;
  missingContacts: number;

  // data accumulators
  lastSessionByMember: Map<string, number>;
  newParticipantIds: Set<string>;
  engagedIds: Set<string>;

  unionIds: string[];
  hydrateIndex: number;
  contactDetails: Map<string, any>;

  // final output
  report?: BillingReport;
}

const jobs = new Map<string, BillingJobState>();

function makeJobId() {
  return `billing-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function timeLeftMs(deadlineMs: number) {
  return deadlineMs - Date.now();
}

function cleanExpiredJobs(nowMs: number) {
  for (const [id, job] of jobs.entries()) {
    if (nowMs - job.updatedAtMs > JOB_TTL_MS) {
      jobs.delete(id);
    }
  }
}

function isAbortError(e: any) {
  return e?.name === 'AbortError' || String(e?.message ?? '').toLowerCase().includes('aborted');
}

async function intercomRequestWithDeadline(
  path: string,
  init: RequestInit,
  deadlineMs: number
): Promise<any> {
  return intercomRequest(path, init, {
    deadlineMs,
    maxRetries: 3,
    slowThresholdMs: 5_000
  });
}

function getTzOffsetMinutes(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });

  const parts = dtf.formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);

  const y = get('year');
  const m = get('month');
  const d = get('day');
  const hh = get('hour');
  const mm = get('minute');
  const ss = get('second');

  const asIfUtc = Date.UTC(y, m - 1, d, hh, mm, ss);
  return Math.round((asIfUtc - date.getTime()) / 60000);
}

function zonedTimeToUtcUnix(
  year: number,
  monthIndex0: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string
): number {
  const guessUtcMs = Date.UTC(year, monthIndex0, day, hour, minute, second);
  const offsetMin = getTzOffsetMinutes(new Date(guessUtcMs), timeZone);
  const utcMs = guessUtcMs - offsetMin * 60_000;
  return Math.floor(utcMs / 1000);
}

function computeMonthWindowNY(monthYearLabel: string): {
  year: number;
  month: number;
  monthStartUnix: number;
  monthEndUnix: number;
  monthStartISO: string;
  monthEndISO: string;
} {
  const m = /^(\d{4})-(\d{2})$/.exec(monthYearLabel);
  if (!m) throw new Error(`Invalid monthYearLabel: ${monthYearLabel} (expected YYYY-MM)`);

  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw new Error(`Invalid month: ${month}`);

  const monthIndex0 = month - 1;
  const monthStartUnix = zonedTimeToUtcUnix(year, monthIndex0, 1, 0, 0, 0, REPORT_TZ);

  const nextYear = month === 12 ? year + 1 : year;
  const nextMonthIndex0 = month === 12 ? 0 : monthIndex0 + 1;
  const monthEndUnix = zonedTimeToUtcUnix(nextYear, nextMonthIndex0, 1, 0, 0, 0, REPORT_TZ);

  return {
    year,
    month,
    monthStartUnix,
    monthEndUnix,
    monthStartISO: new Date(monthStartUnix * 1000).toISOString(),
    monthEndISO: new Date(monthEndUnix * 1000).toISOString()
  };
}

function createJob(monthYearLabel: string): BillingJobState {
  const {
    year,
    month,
    monthStartUnix,
    monthEndUnix,
    monthStartISO,
    monthEndISO
  } = computeMonthWindowNY(monthYearLabel);

  const engagedTailWindowStartUnix = monthStartUnix - ENGAGED_TAIL_DAYS * SECONDS_PER_DAY;

  const nowMs = Date.now();
  const job: BillingJobState = {
    id: makeJobId(),
    monthYearLabel,

    year,
    month,
    monthStartUnix,
    monthEndUnix,
    monthStartISO,
    monthEndISO,
    engagedTailWindowStartUnix,

    status: 'queued',
    phase: 'conversations',

    createdAtMs: nowMs,
    updatedAtMs: nowMs,

    conversationPagesFetched: 0,
    conversationsFetched: 0,
    conversationsProcessed: 0,

    participantPagesFetched: 0,
    participantsFetched: 0,

    contactsFetched: 0,
    missingContacts: 0,

    lastSessionByMember: new Map(),
    newParticipantIds: new Set(),
    engagedIds: new Set(),

    unionIds: [],
    hydrateIndex: 0,
    contactDetails: new Map()
  };

  jobs.set(job.id, job);

  return job;
}

async function fetchConversationsPage(
  job: BillingJobState,
  deadlineMs: number
): Promise<{ conversations: any[]; nextCursor?: string }> {
  const body: any = {
    query: {
      operator: 'AND',
      value: [
        { field: 'state', operator: '=', value: 'closed' },
        { field: 'created_at', operator: '>', value: job.engagedTailWindowStartUnix },
        { field: 'created_at', operator: '<=', value: job.monthEndUnix - 1 }
      ]
    },
    pagination: {
      per_page: CONVERSATIONS_PER_PAGE
    }
  };

  if (job.conversationsStartingAfter) {
    body.pagination.starting_after = job.conversationsStartingAfter;
  }

  const data = await intercomRequestWithDeadline(
    '/conversations/search',
    {
      method: 'POST',
      body: JSON.stringify(body)
    },
    deadlineMs
  );

  const conversations = data.conversations ?? data.data ?? [];
  const nextCursor: string | undefined = data.pages?.next?.starting_after;

  return { conversations, nextCursor };
}

function processConversations(job: BillingJobState, conversations: any[]) {
  for (const conv of conversations) {
    try {
      const attrs = conv.custom_attributes || {};
      const channelValue = attrs[CHANNEL_ATTR_KEY] as string | undefined;
      if (!channelValue) continue;

      if (!SESSION_CHANNELS.includes(channelValue as SessionChannel)) continue;

      const contactsList = conv.contacts?.contacts || [];
      if (!contactsList.length) continue;

      const memberId = String(contactsList[0].id);

      const stats = conv.statistics || {};
      const sessionTime: number | undefined =
        stats.last_close_at || stats.last_admin_reply_at || conv.created_at || conv.created_at;

      if (!sessionTime) continue;

      if (sessionTime < job.engagedTailWindowStartUnix || sessionTime >= job.monthEndUnix) {
        continue;
      }

      const prev = job.lastSessionByMember.get(memberId) ?? 0;
      if (sessionTime > prev) {
        job.lastSessionByMember.set(memberId, sessionTime);
      }

      job.conversationsProcessed += 1;
    } catch {
      // Skip malformed conversations.
    }
  }
}

async function fetchParticipantsPage(
  job: BillingJobState,
  deadlineMs: number
): Promise<{ contacts: any[]; nextCursor?: string }> {
  const body: any = {
    query: {
      operator: 'AND',
      value: [
        { field: 'role', operator: '=', value: 'user' },
        {
          field: `custom_attributes.${ENROLLED_ATTR_KEY}`,
          operator: '>',
          value: job.monthStartUnix - 1
        },
        {
          field: `custom_attributes.${ENROLLED_ATTR_KEY}`,
          operator: '<',
          value: job.monthEndUnix
        }
      ]
    },
    pagination: {
      per_page: CONTACTS_PER_PAGE
    }
  };

  if (job.participantsStartingAfter) {
    body.pagination.starting_after = job.participantsStartingAfter;
  }

  const data = await intercomRequestWithDeadline(
    '/contacts/search',
    {
      method: 'POST',
      body: JSON.stringify(body)
    },
    deadlineMs
  );

  const contacts = data.data ?? data.contacts ?? [];
  const nextCursor: string | undefined = data.pages?.next?.starting_after;

  return { contacts, nextCursor };
}

function ensureUnionIds(job: BillingJobState) {
  if (job.unionIds.length > 0) return;

  const engagedLowerBound = job.monthStartUnix - ENGAGED_TAIL_DAYS * SECONDS_PER_DAY;
  for (const [memberId, lastSessionAt] of job.lastSessionByMember.entries()) {
    if (lastSessionAt >= engagedLowerBound && lastSessionAt < job.monthEndUnix) {
      job.engagedIds.add(memberId);
    }
  }

  const union = new Set<string>();
  for (const id of job.newParticipantIds) union.add(id);
  for (const id of job.engagedIds) union.add(id);

  job.unionIds = Array.from(union);
  job.hydrateIndex = 0;
}

async function hydrateContactsStep(job: BillingJobState, deadlineMs: number) {
  ensureUnionIds(job);

  while (
    timeLeftMs(deadlineMs) >= MIN_TIME_TO_START_REQUEST_MS &&
    job.hydrateIndex < job.unionIds.length
  ) {
    const batch = job.unionIds.slice(job.hydrateIndex, job.hydrateIndex + CONTACT_FETCH_BATCH_SIZE);
    if (!batch.length) break;

    const fetched = await fetchContactsByIds(batch, {
      concurrency: CONTACT_FETCH_CONCURRENCY,
      requestOptions: { deadlineMs, maxRetries: 3 },
      onError: (id, err) => {
        const message = (err as any)?.message ?? String(err);
        console.error(`Billing: error fetching contact ${id}:`, message);
      }
    });

    for (const [id, contact] of fetched.entries()) {
      job.contactDetails.set(id, contact);
    }

    job.contactsFetched += fetched.size;
    job.missingContacts += Math.max(0, batch.length - fetched.size);
    job.hydrateIndex += batch.length;
  }

  if (job.hydrateIndex >= job.unionIds.length) {
    job.phase = 'finalize';
  }
}

function toUnixOrNull(raw: any): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
  }
  return null;
}

function finalizeReport(job: BillingJobState) {
  ensureUnionIds(job);

  const engagedLowerBound = job.monthStartUnix - ENGAGED_TAIL_DAYS * SECONDS_PER_DAY;
  const rows: BillingRow[] = [];

  for (const memberId of job.unionIds) {
    const contact = job.contactDetails.get(memberId);
    if (!contact) {
      continue;
    }

    const attrs = contact.custom_attributes || {};

    const registrationAt = toUnixOrNull(attrs[ENROLLED_ATTR_KEY]);
    const isNewParticipant =
      registrationAt !== null &&
      registrationAt >= job.monthStartUnix &&
      registrationAt < job.monthEndUnix;

    const lastSessionAt = job.lastSessionByMember.get(memberId) ?? null;
    const engagedDuringMonth =
      lastSessionAt !== null &&
      lastSessionAt >= engagedLowerBound &&
      lastSessionAt < job.monthEndUnix;

    const employerRaw = attrs[EMPLOYER_ATTR_KEY];
    const employer =
      typeof employerRaw === 'string'
        ? employerRaw
        : employerRaw != null
        ? String(employerRaw)
        : null;

    rows.push({
      memberId,
      memberName: contact.name ?? null,
      memberEmail: contact.email ?? null,
      employer,
      registrationAt,
      lastSessionAt,
      isNewParticipant,
      engagedDuringMonth
    });
  }

  rows.sort((a, b) => {
    const ae = a.employer ?? '';
    const be = b.employer ?? '';
    if (ae !== be) return ae.localeCompare(be);

    const an = a.memberName ?? '';
    const bn = b.memberName ?? '';
    if (an !== bn) return an.localeCompare(bn);

    return a.memberId.localeCompare(b.memberId);
  });

  job.report = {
    year: job.year,
    month: job.month,
    monthYearLabel: job.monthYearLabel,
    monthStart: job.monthStartISO,
    monthEnd: job.monthEndISO,
    generatedAt: new Date().toISOString(),
    totalRows: rows.length,
    rows
  };

  job.phase = 'complete';
  job.status = 'complete';
}

function buildProgress(job: BillingJobState) {
  return {
    conversationPagesFetched: job.conversationPagesFetched,
    conversationsFetched: job.conversationsFetched,
    conversationsProcessed: job.conversationsProcessed,
    participantPagesFetched: job.participantPagesFetched,
    participantsFetched: job.participantsFetched,
    membersWithSessions: job.lastSessionByMember.size,
    newParticipants: job.newParticipantIds.size,
    engagedParticipants: job.engagedIds.size,
    unionMembers: job.unionIds.length,
    contactsFetched: job.contactsFetched,
    missingContacts: job.missingContacts,
    contactsRemaining:
      job.unionIds.length > 0 ? Math.max(0, job.unionIds.length - job.hydrateIndex) : null
  };
}

async function stepJob(job: BillingJobState): Promise<any> {
  const stepStart = Date.now();
  const deadlineMs = stepStart + STEP_BUDGET_MS - STEP_SAFETY_MS;

  job.status = 'running';
  job.updatedAtMs = Date.now();

  try {
    if (job.phase === 'conversations') {
      while (timeLeftMs(deadlineMs) >= MIN_TIME_TO_START_REQUEST_MS) {
        const { conversations, nextCursor } = await fetchConversationsPage(job, deadlineMs);

        job.conversationPagesFetched += 1;
        job.conversationsFetched += conversations.length;
        processConversations(job, conversations);

        job.conversationsStartingAfter = nextCursor;
        if (!nextCursor) {
          job.phase = 'participants';
          break;
        }

        if (conversations.length === 0 && nextCursor) {
          break;
        }
      }
    }

    if (job.phase === 'participants') {
      while (timeLeftMs(deadlineMs) >= MIN_TIME_TO_START_REQUEST_MS) {
        const { contacts, nextCursor } = await fetchParticipantsPage(job, deadlineMs);

        job.participantPagesFetched += 1;
        job.participantsFetched += contacts.length;

        for (const c of contacts) {
          if (c?.id != null) {
            job.newParticipantIds.add(String(c.id));
          }
        }

        job.participantsStartingAfter = nextCursor;

        if (!nextCursor) {
          ensureUnionIds(job);
          job.phase = 'hydrate';
          break;
        }

        if (contacts.length === 0 && nextCursor) {
          break;
        }
      }
    }

    if (job.phase === 'hydrate') {
      await hydrateContactsStep(job, deadlineMs);
    }

    if (job.phase === 'finalize') {
      finalizeReport(job);
    }

    job.updatedAtMs = Date.now();

    return {
      jobId: job.id,
      status: job.status,
      phase: job.phase,
      done: job.phase === 'complete',
      monthYearLabel: job.monthYearLabel,
      progress: buildProgress(job),
      updatedAt: new Date(job.updatedAtMs).toISOString()
    };
  } catch (err: any) {
    if (isAbortError(err)) {
      job.updatedAtMs = Date.now();
      return {
        jobId: job.id,
        status: job.status,
        phase: job.phase,
        done: false,
        monthYearLabel: job.monthYearLabel,
        progress: buildProgress(job),
        updatedAt: new Date(job.updatedAtMs).toISOString()
      };
    }

    job.status = 'error';
    job.phase = 'complete';
    job.error = err?.message ?? String(err);
    job.updatedAtMs = Date.now();

    return {
      jobId: job.id,
      status: job.status,
      phase: job.phase,
      done: true,
      error: job.error,
      monthYearLabel: job.monthYearLabel
    };
  }
}

export const POST: RequestHandler = async ({ request }) => {
  cleanExpiredJobs(Date.now());

  let body: any = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const op = String(body?.op ?? 'create');

  if (op === 'create') {
    const monthYearLabel = String(body?.monthYearLabel ?? '').trim();
    if (!monthYearLabel) {
      return new Response(
        JSON.stringify({ error: 'monthYearLabel is required (YYYY-MM)' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    try {
      const job = createJob(monthYearLabel);
      return new Response(
        JSON.stringify({
          jobId: job.id,
          status: job.status,
          phase: job.phase,
          monthYearLabel: job.monthYearLabel,
          monthStart: job.monthStartISO,
          monthEnd: job.monthEndISO
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    } catch (e: any) {
      return new Response(
        JSON.stringify({ error: e?.message ?? String(e) }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  if (op === 'step') {
    const jobId = String(body?.jobId ?? '');
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
          error: job.error ?? null,
          monthYearLabel: job.monthYearLabel,
          progress: buildProgress(job)
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
    const jobId = String(body?.jobId ?? '');
    if (!jobId) {
      return new Response(JSON.stringify({ error: 'Missing jobId' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const deleted = jobs.delete(jobId);
    return new Response(JSON.stringify({ jobId, deleted }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (op === 'cancel') {
    const jobId = String(body?.jobId ?? '');
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
        usage: 'GET ?jobId=... (status) or ?jobId=...&view=summary|rows|report&offset=0&limit=500'
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
  const done = job.status === 'complete' || job.status === 'error' || job.status === 'cancelled';

  if (!view) {
    return new Response(
      JSON.stringify({
        jobId: job.id,
        status: job.status,
        phase: job.phase,
        done,
        monthYearLabel: job.monthYearLabel,
        progress: buildProgress(job),
        error: job.error ?? null,
        updatedAt: new Date(job.updatedAtMs).toISOString()
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (job.status !== 'complete' || !job.report) {
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
        year: job.report.year,
        month: job.report.month,
        monthYearLabel: job.report.monthYearLabel,
        monthStart: job.report.monthStart,
        monthEnd: job.report.monthEnd,
        generatedAt: job.report.generatedAt,
        totalRows: job.report.totalRows
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (view === 'rows') {
    const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0));
    const limit = Math.min(5000, Math.max(1, Number(url.searchParams.get('limit') ?? 500)));

    const items = job.report.rows.slice(offset, offset + limit);
    const nextOffset = offset + limit < job.report.rows.length ? offset + limit : null;

    return new Response(JSON.stringify({ items, nextOffset, total: job.report.rows.length }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (view === 'report') {
    return new Response(JSON.stringify(job.report), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  return new Response(
    JSON.stringify({
      error: 'Unknown view',
      details: 'Supported views: summary, rows, report'
    }),
    { status: 400, headers: { 'Content-Type': 'application/json' } }
  );
};
