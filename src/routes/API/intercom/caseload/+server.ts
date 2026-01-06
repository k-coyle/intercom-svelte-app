// src/routes/API/intercom/caseload/+server.ts
import type { RequestHandler } from '@sveltejs/kit';
import {
  INTERCOM_ACCESS_TOKEN,
  INTERCOM_VERSION,
  INTERCOM_API_BASE
} from '$env/static/private';

const INTERCOM_BASE_URL = INTERCOM_API_BASE || 'https://api.intercom.io';
const INTERCOM_API_VERSION = INTERCOM_VERSION || '2.10';

const SECONDS_PER_DAY = 24 * 60 * 60;
const MAX_RETRIES = 3;

// Conversation attribute key for channel (matches your Intercom data attribute)
const CHANNEL_ATTR_KEY = 'Channel';

// Channels that count as "coaching sessions" for this report
const SESSION_CHANNELS = ['Phone', 'Video Conference', 'Email', 'Chat'] as const;
type SessionChannel = (typeof SESSION_CHANNELS)[number];

// Contact attribute key for client (adjust if your Intercom key is different)
const CLIENT_ATTR_KEY = 'Employer';

// ---------- Types ----------

interface SessionRow {
  memberId: string;
  coachId: string | null;
  channel: SessionChannel;
  time: number; // unix seconds
}

interface SessionDetailRow {
  memberId: string;
  memberName: string | null;
  memberEmail: string | null;
  client: string | null;
  coachId: string | null;
  coachName: string | null;
  channel: SessionChannel;
  time: number;
  daysSince: number;
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

interface CaseloadReport {
  lookbackDays: number;
  generatedAt: string;
  totalMembers: number;
  summary: CaseloadSummary;
  members: CaseloadMemberRow[];
  sessions: SessionDetailRow[];
}

interface AdminInfo {
  id: string;
  name: string | null;
  email: string | null;
}

// ---------- Intercom helpers ----------

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function intercomRequest(
  path: string,
  init: RequestInit = {},
  attempt = 1
): Promise<any> {
  if (!INTERCOM_ACCESS_TOKEN) {
    throw new Error('INTERCOM_ACCESS_TOKEN is not set');
  }

  const res = await fetch(`${INTERCOM_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${INTERCOM_ACCESS_TOKEN}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Intercom-Version': INTERCOM_API_VERSION,
      ...(init.headers ?? {})
    }
  });

  if (res.status === 429 && attempt < MAX_RETRIES) {
    const retryAfterHeader = res.headers.get('Retry-After');
    const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : NaN;
    const delaySeconds = Number.isFinite(retryAfterSeconds)
      ? retryAfterSeconds
      : 2 ** attempt; // 2s, 4s, ...

    console.warn(
      `Intercom 429 rate limit on ${path}, attempt ${attempt} — retrying after ${delaySeconds}s`
    );
    await sleep(delaySeconds * 1000);
    return intercomRequest(path, init, attempt + 1);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Intercom ${res.status} ${res.statusText}: ${text}`);
  }

  return res.json();
}

/**
 * Fetch ALL closed conversations updated since `sinceUnix`,
 * following pagination using pages.next.starting_after.
 */
async function searchClosedConversationsSince(sinceUnix: number): Promise<any[]> {
  const allConversations: any[] = [];
  let startingAfter: string | undefined = undefined;
  let page = 1;

  while (true) {
    const body: any = {
      query: {
        operator: 'AND',
        value: [
          { field: 'state', operator: '=', value: 'closed' },
          { field: 'updated_at', operator: '>', value: sinceUnix }
        ]
      },
      pagination: {
        per_page: 150
      }
    };

    if (startingAfter) {
      body.pagination.starting_after = startingAfter;
    }

    const data = await intercomRequest('/conversations/search', {
      method: 'POST',
      body: JSON.stringify(body)
    });

    const conversations = data.conversations ?? data.data ?? [];
    const totalCount = data.total_count ?? data.total ?? 'unknown';

    console.log(
      `Caseload conversations page ${page}: got ${conversations.length} (total_count=${totalCount}).`
    );

    allConversations.push(...conversations);

    const nextCursor: string | undefined = data.pages?.next?.starting_after;
    if (!nextCursor) {
      break;
    }

    startingAfter = nextCursor;
    page += 1;
  }

  console.log(`Caseload: total fetched conversations: ${allConversations.length}`);
  return allConversations;
}

/**
 * Fetch a single contact by id.
 */
async function getContact(contactId: string): Promise<any> {
  return intercomRequest(`/contacts/${contactId}`);
}

/**
 * Fetch details for many contacts with limited concurrency.
 */
async function fetchContactsDetails(contactIds: string[]): Promise<Map<string, any>> {
  const result = new Map<string, any>();
  const ids = [...new Set(contactIds)]; // dedupe
  const concurrency = 10;
  const queue = [...ids];

  while (queue.length > 0) {
    const batch = queue.splice(0, concurrency);

    await Promise.all(
      batch.map(async (id) => {
        try {
          const contact = await getContact(id);
          result.set(id, contact);
        } catch (err: any) {
          console.error(`Error fetching contact ${id}:`, err?.message ?? err);
        }
      })
    );
  }

  return result;
}

/**
 * Fetch all admins (coaches) so we can map admin_assignee_id -> name.
 * IMPORTANT: force all IDs to strings for consistent lookups.
 */
async function fetchAdmins(): Promise<Map<string, AdminInfo>> {
  const data = await intercomRequest('/admins', { method: 'GET' });
  const admins = data.admins ?? data.data ?? [];
  const map = new Map<string, AdminInfo>();

  for (const a of admins) {
    const id = String(a.id);
    map.set(id, {
      id,
      name: a.name ?? null,
      email: a.email ?? null
    });
  }

  return map;
}

// ---------- Caseload logic ----------

/**
 * Compute the four time-bucket flags from days_since_last_session.
 *
 * Bucket definitions:
 *  - bucket_1: last session <= 7 days ago
 *  - bucket_2: 8–28 days ago
 *  - bucket_3: 29–56 days ago
 *  - bucket_4: > 56 days ago
 */
function computeBuckets(daysSince: number): MemberBuckets {
  return {
    bucket_1: daysSince <= 7,
    bucket_2: daysSince > 7 && daysSince <= 28,
    bucket_3: daysSince > 28 && daysSince <= 56,
    bucket_4: daysSince > 56
  };
}

/**
 * Build the caseload report:
 * - Session-level list (for sessions report & UI)
 * - Aggregated per member (for caseload view)
 */
async function runCaseloadReport(lookbackDays: number): Promise<CaseloadReport> {
  const nowUnix = Math.floor(Date.now() / 1000);
  const sinceUnix = nowUnix - lookbackDays * SECONDS_PER_DAY;

  console.log(
    `Caseload report: lookbackDays=${lookbackDays}, sinceUnix=${sinceUnix} (${new Date(
      sinceUnix * 1000
    ).toISOString()})`
  );

  // 1) Fetch all closed conversations in window
  const conversations = await searchClosedConversationsSince(sinceUnix);

  // 2) Extract sessions: one row per (member, coach, channel, time)
  const sessions: SessionRow[] = [];

  for (const conv of conversations) {
    try {
      const attrs = conv.custom_attributes || {};
      const channelValue = attrs[CHANNEL_ATTR_KEY] as string | undefined;
      if (!channelValue) continue;

      if (!SESSION_CHANNELS.includes(channelValue as SessionChannel)) {
        continue; // only phone/video/email/chat
      }

      const channel = channelValue as SessionChannel;

      const contactsList = conv.contacts?.contacts || [];
      if (!contactsList.length) continue;

      // Force memberId to string
      const memberId = String(contactsList[0].id);

      const stats = conv.statistics || {};
      const sessionTime: number | undefined =
        stats.last_close_at ||
        stats.last_admin_reply_at ||
        conv.updated_at ||
        conv.created_at;

      if (!sessionTime) continue;

      // Force coachId to string so it matches fetchAdmins() keys
      const coachId =
        conv.admin_assignee_id != null ? String(conv.admin_assignee_id) : null;

      sessions.push({
        memberId,
        coachId,
        channel,
        time: sessionTime
      });
    } catch (err: any) {
      console.error(`Error processing conversation ${conv.id}:`, err?.message ?? err);
    }
  }

  console.log(`Total qualifying sessions (Phone/Video/Email/Chat): ${sessions.length}`);

  // 3) Group sessions by member
  const sessionsByMember = new Map<string, SessionRow[]>();
  for (const s of sessions) {
    const list = sessionsByMember.get(s.memberId) ?? [];
    list.push(s);
    sessionsByMember.set(s.memberId, list);
  }

  console.log(`Unique members with at least one session: ${sessionsByMember.size}`);

  // 4) Fetch member details (name/email/client)
  const memberIds = Array.from(sessionsByMember.keys());
  const contactDetails = await fetchContactsDetails(memberIds);

  // 5) Fetch admin details (coach names)
  const adminMap = await fetchAdmins();

  // 6) Build session-level detail rows
  const sessionDetails: SessionDetailRow[] = sessions.map((s) => {
    const contact = contactDetails.get(s.memberId) || {};
    const memberName = contact.name ?? null;
    const memberEmail = contact.email ?? null;
    const contactAttrs = contact.custom_attributes || {};
    const client = (contactAttrs[CLIENT_ATTR_KEY] as string) ?? null;

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

  // 7) Build member-level rows (for caseload view)
  const members: CaseloadMemberRow[] = [];

  for (const [memberId, memberSessions] of sessionsByMember.entries()) {
    const contact = contactDetails.get(memberId) || {};
    const memberName = contact.name ?? null;
    const memberEmail = contact.email ?? null;
    const contactAttrs = contact.custom_attributes || {};
    const client = (contactAttrs[CLIENT_ATTR_KEY] as string) ?? null;

    // Last session time
    const lastSessionAt = memberSessions.reduce(
      (max, s) => (s.time > max ? s.time : max),
      0
    );
    if (!lastSessionAt) continue;

    const daysSinceLastSession = (nowUnix - lastSessionAt) / SECONDS_PER_DAY;

    // Channels and coaches
    const channelsSet = new Set<SessionChannel>();
    const coachIdSet = new Set<string>();

    for (const s of memberSessions) {
      channelsSet.add(s.channel);
      if (s.coachId) coachIdSet.add(s.coachId);
    }

    const channelsUsed = Array.from(channelsSet).sort();
    const channelCombo = channelsUsed.join(' + ') || '(none)';

    const coachIds = Array.from(coachIdSet).sort();
    const coachNames = coachIds.map((id) => adminMap.get(id)?.name ?? id);

    const buckets = computeBuckets(daysSinceLastSession);

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
      buckets
    });
  }

  // 8) Summary counts (member-level buckets)
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

  return {
    lookbackDays,
    generatedAt: new Date(nowUnix * 1000).toISOString(),
    totalMembers: members.length,
    summary,
    members,
    sessions: sessionDetails
  };
}

// ---------- SvelteKit handler ----------

export const POST: RequestHandler = async ({ request }) => {
  try {
    let body: any = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    const raw = body.lookbackDays;
    const parsed = Number(raw);

    if (Number.isNaN(parsed) || parsed <= 0) {
      return new Response(
        JSON.stringify({
          error: 'Invalid lookbackDays',
          details: 'lookbackDays must be a positive number of days (1–365).'
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    let lookbackDays = parsed;
    if (lookbackDays > 365) {
      lookbackDays = 365; // hard cap
    }

    const report = await runCaseloadReport(lookbackDays);

    return new Response(JSON.stringify(report), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (e: any) {
    console.error('Fatal error in caseload report:', e?.message ?? e);
    return new Response(
      JSON.stringify({
        error: 'Intercom caseload report failed',
        details: e?.message ?? String(e)
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
