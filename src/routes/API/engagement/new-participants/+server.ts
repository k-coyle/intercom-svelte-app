// src/routes/API/engagement/new-participants/+server.ts
import type { RequestHandler } from '@sveltejs/kit';
import { intercomRequest } from '$lib/server/intercom';

const SECONDS_PER_DAY = 24 * 60 * 60;

// Custom attribute keys
const PARTICIPANT_DATE_ATTR_KEY = 'Enrolled Date';
const CLIENT_ATTR_KEY = 'Employer';
const CHANNEL_ATTR_KEY = 'Channel';

// Channels that count as "coaching sessions" for this report
const SESSION_CHANNELS = ['Phone', 'Video Conference', 'Email', 'Chat'] as const;
type SessionChannel = (typeof SESSION_CHANNELS)[number];

const DEFAULT_LOOKBACK_DAYS = 365;

// ---------- Search helpers ----------

/**
 * Fetch all "enrolled" contacts whose participant date (Registration / Enrolled Date)
 * is within the lookback window.
 */
async function searchEnrolledContactsSince(sinceUnix: number): Promise<any[]> {
  const allContacts: any[] = [];
  let startingAfter: string | undefined = undefined;
  let page = 1;

  while (true) {
    const body: any = {
      query: {
        operator: 'AND',
        value: [
          { field: 'role', operator: '=', value: 'user' },
          {
            field: `custom_attributes.${PARTICIPANT_DATE_ATTR_KEY}`,
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
      `New-participants contacts page ${page}: got ${contacts.length} contacts (total_count=${totalCount}).`
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
 * Fetch ALL closed conversations updated since `sinceUnix` for a given set of contacts,
 * following pagination using pages.next.starting_after.
 */
async function searchClosedConversationsSince(
  sinceUnix: number,
  contactIds: string[]
): Promise<any[]> {
  const allConversations: any[] = [];
  let startingAfter: string | undefined = undefined;
  let page = 1;

  while (true) {
    const body: any = {
      query: {
        operator: 'AND',
        value: [
          { field: 'state', operator: '=', value: 'closed' },
          { field: 'updated_at', operator: '>', value: sinceUnix },
          { field: 'contact_ids', operator: 'IN', value: contactIds }
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
      `New-participants conversations page ${page}: got ${conversations.length} conversations (total_count=${totalCount}).`
    );

    allConversations.push(...conversations);

    const nextCursor: string | undefined = data.pages?.next?.starting_after;
    if (!nextCursor) break;

    startingAfter = nextCursor;
    page += 1;
  }

  console.log(`Total fetched conversations for chunk: ${allConversations.length}`);
  return allConversations;
}

async function fetchConversationsForContacts(
  sinceUnix: number,
  contactIds: string[]
) {
  const chunkSize = 15;
  const all: any[] = [];

  if (!contactIds.length) return all;

  for (let i = 0; i < contactIds.length; i += chunkSize) {
    const chunk = contactIds.slice(i, i + chunkSize);
    const convs = await searchClosedConversationsSince(sinceUnix, chunk);
    all.push(...convs);
  }

  return all;
}

/**
 * Fetch all admins and build an ID->name map so we can label coaches.
 */
async function fetchAdminMap(): Promise<
  Map<string, { name: string; email: string | null }>
> {
  const map = new Map<string, { name: string; email: string | null }>();

  try {
    const data = await intercomRequest('/admins');
    const admins = data.admins ?? data.data ?? [];
    for (const a of admins) {
      const id = a.id != null ? String(a.id) : '';
      if (!id) continue;
      const name = (a.name as string) ?? id;
      const email = (a.email as string) ?? null;
      map.set(id, { name, email });
    }
  } catch (err: any) {
    console.warn('Warning: unable to fetch admins map:', err?.message ?? err);
  }

  return map;
}

// ---------- Types ----------

interface SessionRow {
  memberId: string;
  coachId: string | null;
  channel: SessionChannel;
  time: number; // unix seconds
}

interface ParticipantBuckets {
  gt_14_to_21: boolean;
  gt_21_to_28: boolean;
  gt_28: boolean; // Unengaged for this report
}

interface ParticipantRow {
  memberId: string;
  memberName: string | null;
  memberEmail: string | null;
  client: string | null;
  participantAt: number | null; // Registration / Enrolled Date (unix seconds)
  daysSinceParticipant: number | null;

  hasSession: boolean;
  firstSessionAt: number | null;
  lastSessionAt: number | null;
  daysSinceLastSession: number | null;

  coachIds: string[];
  coachNames: string[];
  channelsUsed: SessionChannel[];

  // Metric used for bucket classification: days since last session,
  // or since participant date if no session yet.
  daysWithoutSession: number | null;
  buckets: ParticipantBuckets;
}

interface NewParticipantsSummary {
  gt_14_to_21: number;
  gt_21_to_28: number;
  gt_28: number;
}

interface NewParticipantsReport {
  generatedAt: string;
  lookbackDays: number;
  totalParticipants: number;
  summary: NewParticipantsSummary;
  participants: ParticipantRow[];
}

// ---------- Bucketing ----------

/**
 * Classify a participant into additive buckets based on daysWithoutSession.
 *
 * Rules (exclusive buckets):
 * - daysWithoutSession > 28        => gt_28 = true   (Unengaged)
 * - 21 < daysWithoutSession <= 28  => gt_21_to_28 = true
 * - 14 < daysWithoutSession <= 21  => gt_14_to_21 = true
 * - Otherwise                      => all false
 */
function classifyBuckets(daysWithoutSession: number | null): ParticipantBuckets {
  if (daysWithoutSession == null) {
    return { gt_14_to_21: false, gt_21_to_28: false, gt_28: false };
  }

  if (daysWithoutSession > 28) {
    return { gt_14_to_21: false, gt_21_to_28: false, gt_28: true };
  }

  if (daysWithoutSession > 21) {
    return { gt_14_to_21: false, gt_21_to_28: true, gt_28: false };
  }

  if (daysWithoutSession > 14) {
    return { gt_14_to_21: true, gt_21_to_28: false, gt_28: false };
  }

  return { gt_14_to_21: false, gt_21_to_28: false, gt_28: false };
}

// ---------- Core report builder ----------

/**
 * Build the report: enrolled participants + buckets.
 */
async function buildNewParticipantsReport(
  lookbackDays: number
): Promise<NewParticipantsReport> {
  const nowUnix = Math.floor(Date.now() / 1000);
  const sinceUnix = nowUnix - lookbackDays * SECONDS_PER_DAY;

  console.log(
    `New-participants report: lookbackDays=${lookbackDays}, sinceUnix=${sinceUnix}`
  );

  // 1) Fetch enrolled contacts
  const contacts = await searchEnrolledContactsSince(sinceUnix);

  // 2) Fetch relevant closed conversations in the same window
  const contactIds = Array.from(
    new Set(
      contacts
        .map((c: any) => (c.id != null ? String(c.id) : ''))
        .filter((id) => id.length > 0)
    )
  );
  const conversations = await fetchConversationsForContacts(sinceUnix, contactIds);

  // 3) Build session rows per contact
  const sessionsByMember = new Map<string, SessionRow[]>();

  for (const conv of conversations) {
    try {
      const attrs = conv.custom_attributes || {};
      const channelValue = attrs[CHANNEL_ATTR_KEY] as SessionChannel | undefined;

      if (!channelValue || !SESSION_CHANNELS.includes(channelValue)) {
        continue;
      }

      const stats = conv.statistics || {};
      const sessionTime: number | undefined =
        stats.last_close_at ||
        stats.last_admin_reply_at ||
        conv.updated_at ||
        conv.created_at;

      if (!sessionTime) continue;

      const contactsList = conv.contacts?.contacts || [];
      if (!contactsList.length) continue;

      const teammates = conv.teammates || [];
      const adminAssigneeId =
        conv.admin_assignee_id != null ? String(conv.admin_assignee_id) : null;
      const teammateId =
        teammates.length > 0 && teammates[0]?.id != null
          ? String(teammates[0].id)
          : null;

      const coachId = adminAssigneeId || teammateId || null;

      for (const c of contactsList) {
        if (!c?.id) continue;
        const memberId = String(c.id);

        const row: SessionRow = {
          memberId,
          coachId,
          channel: channelValue,
          time: sessionTime
        };

        const arr = sessionsByMember.get(memberId);
        if (arr) {
          arr.push(row);
        } else {
          sessionsByMember.set(memberId, [row]);
        }
      }
    } catch (err: any) {
      console.error(`Error processing conversation ${conv.id}:`, err?.message ?? err);
    }
  }

  // 4) Build admin map so we can label coaches
  const adminMap = await fetchAdminMap();

  // 5) Build participant rows
  const participants: ParticipantRow[] = [];

  for (const contact of contacts) {
    try {
      const memberId: string = String(contact.id);
      const custom = contact.custom_attributes || {};

      const participantAtRaw = custom[PARTICIPANT_DATE_ATTR_KEY];
      const participantAt =
        typeof participantAtRaw === 'number' && participantAtRaw > 0
          ? participantAtRaw
          : null;

      // Defensively re-check that participant date is in window
      if (!participantAt || participantAt < sinceUnix) {
        continue;
      }

      const daysSinceParticipant =
        participantAt != null ? (nowUnix - participantAt) / SECONDS_PER_DAY : null;

      const client =
        custom[CLIENT_ATTR_KEY] != null ? String(custom[CLIENT_ATTR_KEY]) : null;

      const name =
        (contact.name as string) ??
        (contact.external_id as string) ??
        null;

      const email =
        (contact.email as string) ??
        (Array.isArray(contact.emails) && contact.emails.length
          ? (contact.emails[0].value as string)
          : null);

      const sessions = sessionsByMember.get(memberId) || [];
      const hasSession = sessions.length > 0;

      let firstSessionAt: number | null = null;
      let lastSessionAt: number | null = null;
      let daysSinceLastSession: number | null = null;

      const coachIdSet = new Set<string>();
      const channelSet = new Set<SessionChannel>();

      if (hasSession) {
        for (const s of sessions) {
          if (s.time != null) {
            if (firstSessionAt == null || s.time < firstSessionAt) {
              firstSessionAt = s.time;
            }
            if (lastSessionAt == null || s.time > lastSessionAt) {
              lastSessionAt = s.time;
            }
          }
          if (s.coachId) {
            coachIdSet.add(s.coachId);
          }
          if (s.channel) {
            channelSet.add(s.channel);
          }
        }

        if (lastSessionAt != null) {
          daysSinceLastSession = (nowUnix - lastSessionAt) / SECONDS_PER_DAY;
        }
      }

      let daysWithoutSession: number | null = null;
      if (hasSession && daysSinceLastSession != null) {
        daysWithoutSession = daysSinceLastSession;
      } else if (!hasSession && daysSinceParticipant != null) {
        // If no sessions yet, measure from participant date
        daysWithoutSession = daysSinceParticipant;
      }

      const buckets = classifyBuckets(daysWithoutSession);

      const coachIds = Array.from(coachIdSet);
      const coachNames = coachIds.map((id) => {
        const admin = adminMap.get(id);
        return admin?.name ?? id;
      });

      const channelsUsed = Array.from(channelSet);

      const row: ParticipantRow = {
        memberId,
        memberName: name,
        memberEmail: email,
        client,
        participantAt,
        daysSinceParticipant,
        hasSession,
        firstSessionAt,
        lastSessionAt,
        daysSinceLastSession,
        coachIds,
        coachNames,
        channelsUsed,
        daysWithoutSession,
        buckets
      };

      participants.push(row);
    } catch (err: any) {
      console.error('Error building participant row:', err?.message ?? err);
    }
  }

  // 6) Summary counts (global, unfiltered)
  const summary: NewParticipantsSummary = {
    gt_14_to_21: 0,
    gt_21_to_28: 0,
    gt_28: 0
  };

  for (const p of participants) {
    if (p.buckets.gt_14_to_21) summary.gt_14_to_21 += 1;
    if (p.buckets.gt_21_to_28) summary.gt_21_to_28 += 1;
    if (p.buckets.gt_28) summary.gt_28 += 1;
  }

  const report: NewParticipantsReport = {
    generatedAt: new Date().toISOString(),
    lookbackDays,
    totalParticipants: participants.length,
    summary,
    participants
  };

  return report;
}

// ---------- SvelteKit handler ----------

/**
 * SvelteKit POST handler.
 * Body (optional): { "lookbackDays"?: number }
 */
export const POST: RequestHandler = async ({ request }) => {
  try {
    let lookbackDays = DEFAULT_LOOKBACK_DAYS;

    try {
      const raw = await request.text();
      if (raw) {
        const body = JSON.parse(raw);
        if (typeof body.lookbackDays === 'number' && body.lookbackDays > 0) {
          lookbackDays = Math.min(body.lookbackDays, DEFAULT_LOOKBACK_DAYS);
        }
      }
    } catch (err) {
      console.warn('Warning: unable to parse request body for new-participants:', err);
    }

    const report = await buildNewParticipantsReport(lookbackDays);

    return new Response(JSON.stringify(report), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (e: any) {
    console.error('Fatal error in new-participants report:', e?.message ?? e);
    return new Response(
      JSON.stringify({
        error: 'new-participants report failed',
        details: e?.message ?? String(e)
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
