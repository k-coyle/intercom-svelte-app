// src/routes/API/intercom/new-participants/+server.ts
import type { RequestHandler } from '@sveltejs/kit';
import {
  INTERCOM_ACCESS_TOKEN,
  INTERCOM_VERSION,
  INTERCOM_API_BASE
} from '$env/static/private';

const INTERCOM_BASE_URL = INTERCOM_API_BASE || 'https://api.intercom.io';
const INTERCOM_API_VERSION = INTERCOM_VERSION || '2.10';

const SECONDS_PER_DAY = 24 * 60 * 60;

// Custom attribute keys – adjust if your keys differ in Intercom
const REGISTRATION_ATTR_KEY = 'Registration Date';
const CLIENT_ATTR_KEY = 'Employer';
const CHANNEL_ATTR_KEY = 'Channel';

// Channels that count as "coaching sessions"
const SESSION_CHANNELS = ['Phone', 'Video Conference', 'Email', 'Chat'] as const;
type SessionChannel = (typeof SESSION_CHANNELS)[number];

interface SessionRow {
  memberId: string;
  coachId: string | null;
  channel: SessionChannel;
  time: number; // unix seconds
}

interface ParticipantRow {
  memberId: string;
  memberName: string | null;
  memberEmail: string | null;
  client: string | null;
  registrationAt: number;
  daysSinceRegistration: number;
  hasSession: boolean;
  lastSessionAt: number | null;
  daysSinceLastSession: number | null;
  coachIds: string[];
  coachNames: string[];
  channelsUsed: SessionChannel[];
}

interface NewParticipantsReport {
  lookbackDays: number;
  generatedAt: string;
  totalParticipants: number;
  participants: ParticipantRow[];
}

interface AdminInfo {
  id: string;
  name: string | null;
  email: string | null;
}

// ---------- Intercom helpers ----------

async function intercomRequest(path: string, init: RequestInit = {}): Promise<any> {
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

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Intercom ${res.status} ${res.statusText}: ${text}`);
  }

  return res.json();
}

/**
 * Search contacts whose Registration date is within the lookback window.
 * We query by registration attribute; if the field path gives you 400s,
 * you may need to tweak `field` per Intercom docs.
 */
async function searchContactsRegisteredSince(sinceUnix: number): Promise<any[]> {
  const allContacts: any[] = [];
  let startingAfter: string | undefined = undefined;
  let page = 1;

  while (true) {
    const body: any = {
      query: {
        operator: 'AND',
        value: [
          {
            // NOTE: this assumes Intercom exposes the custom attribute as this field.
            // If it 400s, check your exact registration field name in Intercom search docs.
            field: `custom_attributes.${REGISTRATION_ATTR_KEY}`,
            operator: '>',
            value: sinceUnix
          }
        ]
      },
      pagination: {
        per_page: 150
      }
    };

    if (startingAfter) {
      body.pagination.starting_after = startingAfter;
    }

    const data = await intercomRequest('/contacts/search', {
      method: 'POST',
      body: JSON.stringify(body)
    });

    const contacts = data.data ?? data.contacts ?? [];
    const totalCount = data.total_count ?? data.total ?? 'unknown';

    console.log(
      `Contacts page ${page}: got ${contacts.length} (total_count=${totalCount}).`
    );

    allContacts.push(...contacts);

    const nextCursor: string | undefined = data.pages?.next?.starting_after;
    if (!nextCursor) break;

    startingAfter = nextCursor;
    page += 1;
  }

  console.log(`Total contacts with recent registration: ${allContacts.length}`);
  return allContacts;
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

    const conversations = data.conversations ?? [];
    const totalCount = data.total_count ?? data.total ?? 'unknown';

    console.log(
      `Conversations page ${page}: got ${conversations.length} (total_count=${totalCount}).`
    );

    allConversations.push(...conversations);

    const nextCursor: string | undefined = data.pages?.next?.starting_after;
    if (!nextCursor) break;

    startingAfter = nextCursor;
    page += 1;
  }

  console.log(`Total fetched conversations: ${allConversations.length}`);
  return allConversations;
}

/**
 * Fetch all admins (coaches) so we can map admin_assignee_id -> name.
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

// ---------- New Participants logic ----------

/**
 * Build the new-participants report:
 * - Find contacts whose Registration date is within lookbackDays
 * - Look at coaching sessions (Phone/Video/Email/Chat) since the window start
 * - For each participant, compute whether they have any sessions
 *   AFTER registration, days since registration, etc.
 */
async function runNewParticipantsReport(lookbackDays: number): Promise<NewParticipantsReport> {
  const nowUnix = Math.floor(Date.now() / 1000);
  const sinceUnix = nowUnix - lookbackDays * SECONDS_PER_DAY;

  console.log(
    `New participants report: lookbackDays=${lookbackDays}, sinceUnix=${sinceUnix} (${new Date(
      sinceUnix * 1000
    ).toISOString()})`
  );

  // 1) Contacts with Registration date in this window
  const contacts = await searchContactsRegisteredSince(sinceUnix);

  const participantsMap = new Map<string, ParticipantRow>();

  for (const contact of contacts) {
    const attrs = contact.custom_attributes || {};
    const regRaw = attrs[REGISTRATION_ATTR_KEY];

    let registrationAt: number | null = null;
    if (typeof regRaw === 'number') {
      registrationAt = regRaw;
    } else if (typeof regRaw === 'string') {
      const parsed = Date.parse(regRaw);
      if (!Number.isNaN(parsed)) {
        registrationAt = Math.floor(parsed / 1000);
      }
    }

    if (!registrationAt) {
      // no usable registration date, skip – this report is registration-driven
      continue;
    }

    if (registrationAt < sinceUnix) {
      // old registration outside window – skip
      continue;
    }

    const memberId = String(contact.id);
    const memberName = contact.name ?? null;
    const memberEmail = contact.email ?? null;
    const client = (attrs[CLIENT_ATTR_KEY] as string) ?? null;

    const daysSinceRegistration = (nowUnix - registrationAt) / SECONDS_PER_DAY;

    participantsMap.set(memberId, {
      memberId,
      memberName,
      memberEmail,
      client,
      registrationAt,
      daysSinceRegistration,
      hasSession: false,
      lastSessionAt: null,
      daysSinceLastSession: null,
      coachIds: [],
      coachNames: [],
      channelsUsed: []
    });
  }

  console.log(
    `Participants with registration in window: ${participantsMap.size}`
  );

  if (participantsMap.size === 0) {
    return {
      lookbackDays,
      generatedAt: new Date(nowUnix * 1000).toISOString(),
      totalParticipants: 0,
      participants: []
    };
  }

  const participantIds = new Set(participantsMap.keys());

  // 2) Fetch all closed conversations in that same window
  const conversations = await searchClosedConversationsSince(sinceUnix);

  // Build session rows keyed by memberId (only for participants)
  const sessionsByMember = new Map<string, SessionRow[]>();

  for (const conv of conversations) {
    try {
      const attrs = conv.custom_attributes || {};
      const channelValue = attrs[CHANNEL_ATTR_KEY] as string | undefined;
      if (!channelValue) continue;

      if (!SESSION_CHANNELS.includes(channelValue as SessionChannel)) {
        continue; // only Phone/Video/Email/Chat
      }

      const channel = channelValue as SessionChannel;

      const contactsList = conv.contacts?.contacts || [];
      if (!contactsList.length) continue;

      const memberId = String(contactsList[0].id);

      // Ignore sessions for contacts that are NOT in our participants set
      if (!participantIds.has(memberId)) continue;

      const stats = conv.statistics || {};
      const sessionTime =
        stats.last_close_at ||
        stats.last_admin_reply_at ||
        conv.updated_at ||
        conv.created_at;

      if (!sessionTime) continue;

      const coachId =
        conv.admin_assignee_id != null ? String(conv.admin_assignee_id) : null;

      const existing = sessionsByMember.get(memberId) ?? [];
      existing.push({
        memberId,
        coachId,
        channel,
        time: sessionTime
      });
      sessionsByMember.set(memberId, existing);
    } catch (err: any) {
      console.error(`Error processing conversation ${conv.id}:`, err?.message ?? err);
    }
  }

  console.log(
    `Participants with at least one conversation in window: ${sessionsByMember.size}`
  );

  // 3) Fetch admins (for coach names)
  const adminMap = await fetchAdmins();

  // 4) Fill in session information per participant
  for (const [memberId, row] of participantsMap.entries()) {
    const memberSessions = sessionsByMember.get(memberId) ?? [];

    // Filter sessions to those AFTER registration
    const relevantSessions = memberSessions.filter(
      (s) => s.time >= row.registrationAt
    );

    if (relevantSessions.length === 0) {
      // No sessions after registration
      continue;
    }

    row.hasSession = true;

    let lastSessionAt = 0;
    const coachIdSet = new Set<string>();
    const channelSet = new Set<SessionChannel>();

    for (const s of relevantSessions) {
      if (s.time > lastSessionAt) lastSessionAt = s.time;
      if (s.coachId) coachIdSet.add(s.coachId);
      channelSet.add(s.channel);
    }

    row.lastSessionAt = lastSessionAt;
    row.daysSinceLastSession = (nowUnix - lastSessionAt) / SECONDS_PER_DAY;

    row.coachIds = Array.from(coachIdSet).sort();
    row.coachNames = row.coachIds.map(
      (id) => adminMap.get(id)?.name ?? id
    );
    row.channelsUsed = Array.from(channelSet).sort();
  }

  const participants = Array.from(participantsMap.values());

  return {
    lookbackDays,
    generatedAt: new Date(nowUnix * 1000).toISOString(),
    totalParticipants: participants.length,
    participants
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
    let lookbackDays: number;

    if (raw === undefined || raw === null || raw === '') {
      // Default to 28 days if not provided (matches your current definition)
      lookbackDays = 28;
    } else {
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
      lookbackDays = parsed;
    }

    if (lookbackDays > 365) {
      lookbackDays = 365; // hard cap
    }

    const report = await runNewParticipantsReport(lookbackDays);

    return new Response(JSON.stringify(report), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (e: any) {
    console.error('Fatal error in new-participants report:', e?.message ?? e);
    return new Response(
      JSON.stringify({
        error: 'Intercom new-participants report failed',
          details: e?.message ?? String(e)
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
