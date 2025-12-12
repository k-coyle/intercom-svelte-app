// src/routes/API/intercom/billing/+server.ts
import type { RequestHandler } from '@sveltejs/kit';
import {
  INTERCOM_ACCESS_TOKEN,
  INTERCOM_VERSION,
  INTERCOM_API_BASE
} from '$env/static/private';

const INTERCOM_BASE_URL = INTERCOM_API_BASE || 'https://api.intercom.io';
const INTERCOM_API_VERSION = INTERCOM_VERSION || '2.10';

const SECONDS_PER_DAY = 24 * 60 * 60;

// Attribute keys
const REGISTRATION_ATTR_KEY = 'Registration Date';
const EMPLOYER_ATTR_KEY = 'Employer';
const CHANNEL_ATTR_KEY = 'Channel';

// Channels that count as "coaching sessions"
const SESSION_CHANNELS = ['Phone', 'Video Conference', 'Email', 'Chat'] as const;
type SessionChannel = (typeof SESSION_CHANNELS)[number];

interface BillingRow {
  memberId: string;
  memberName: string | null;
  memberEmail: string | null;
  employer: string | null;
  registrationAt: number | null; // unix seconds
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
 * Fetch ALL closed conversations updated between [startUnix, endUnix],
 * following pagination using pages.next.starting_after.
 */
async function searchClosedConversationsBetween(
  startUnix: number,
  endUnix: number
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
          { field: 'updated_at', operator: '>', value: startUnix },
          { field: 'updated_at', operator: '<=', value: endUnix }
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
      `Billing: conversations page ${page}: got ${conversations.length} (total_count=${totalCount}).`
    );

    allConversations.push(...conversations);

    const nextCursor: string | undefined = data.pages?.next?.starting_after;
    if (!nextCursor) break;

    startingAfter = nextCursor;
    page += 1;
  }

  console.log(`Billing: total conversations in window: ${allConversations.length}`);
  return allConversations;
}

/**
 * Search contacts whose Registration Date is within [monthStartUnix, monthEndUnix).
 * NOTE: we use > monthStartUnix-1 and < monthEndUnix to avoid <=, which Intercom dislikes.
 */
async function searchNewParticipantsInMonth(
  monthStartUnix: number,
  monthEndUnix: number
): Promise<Set<string>> {
  const ids = new Set<string>();
  let startingAfter: string | undefined = undefined;
  let page = 1;

  while (true) {
    const body: any = {
      query: {
        operator: 'AND',
        value: [
          {
            field: `custom_attributes.${REGISTRATION_ATTR_KEY}`,
            operator: '>',
            value: monthStartUnix - 1 // effectively >= monthStartUnix
          },
          {
            field: `custom_attributes.${REGISTRATION_ATTR_KEY}`,
            operator: '<',
            value: monthEndUnix // effectively < monthEndUnix
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
      `Billing: contacts page ${page}: got ${contacts.length} (total_count=${totalCount}).`
    );

    for (const c of contacts) {
      if (c.id) {
        ids.add(String(c.id));
      }
    }

    const nextCursor: string | undefined = data.pages?.next?.starting_after;
    if (!nextCursor) break;

    startingAfter = nextCursor;
    page += 1;
  }

  console.log(`Billing: new participants in month: ${ids.size}`);
  return ids;
}

/**
 * Fetch details for many contacts with limited concurrency.
 */
async function fetchContactsDetails(contactIds: string[]): Promise<Map<string, any>> {
  const result = new Map<string, any>();
  const ids = [...new Set(contactIds)];
  const concurrency = 10;
  const queue = [...ids];

  while (queue.length > 0) {
    const batch = queue.splice(0, concurrency);

    await Promise.all(
      batch.map(async (id) => {
        try {
          const contact = await intercomRequest(`/contacts/${id}`);
          result.set(id, contact);
        } catch (err: any) {
          console.error(`Billing: error fetching contact ${id}:`, err?.message ?? err);
        }
      })
    );
  }

  return result;
}

// ---------- Billing logic ----------

function computePreviousCalendarMonth(): {
  year: number;
  month: number; // 1-12
  monthStartUnix: number;
  monthEndUnix: number;
  monthStartDate: Date;
  monthEndDate: Date;
} {
  const now = new Date();
  let year = now.getFullYear();
  let monthIndex = now.getMonth(); // 0-11, current month

  // Previous month
  if (monthIndex === 0) {
    year -= 1;
    monthIndex = 11;
  } else {
    monthIndex -= 1;
  }

  const monthStartDate = new Date(year, monthIndex, 1, 0, 0, 0, 0);
  const monthEndDate = new Date(year, monthIndex + 1, 1, 0, 0, 0, 0);

  const monthStartUnix = Math.floor(monthStartDate.getTime() / 1000);
  const monthEndUnix = Math.floor(monthEndDate.getTime() / 1000);

  return {
    year,
    month: monthIndex + 1,
    monthStartUnix,
    monthEndUnix,
    monthStartDate,
    monthEndDate
  };
}

/**
 * Build billing report for previous calendar month.
 */
async function runBillingReport(): Promise<BillingReport> {
  const {
    year,
    month,
    monthStartUnix,
    monthEndUnix,
    monthStartDate,
    monthEndDate
  } = computePreviousCalendarMonth();

  const monthYearLabel = `${year}-${String(month).padStart(2, '0')}`;
  console.log(
    `Billing report for ${monthYearLabel}: monthStart=${new Date(
      monthStartUnix * 1000
    ).toISOString()}, monthEnd=${new Date(monthEndUnix * 1000).toISOString()}`
  );

  // Engagement tail window: we need sessions that could keep a user engaged
  // for at least one day *inside* the month.
  const engagedTailWindowStartUnix = monthStartUnix - 56 * SECONDS_PER_DAY;

  // 1) Get all closed conversations in [engagedTailWindowStartUnix, monthEndUnix]
  const conversations = await searchClosedConversationsBetween(
    engagedTailWindowStartUnix,
    monthEndUnix
  );

  // 2) Track last coaching session time per member within that window
  const lastSessionByMember = new Map<string, number>();

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
        stats.last_close_at ||
        stats.last_admin_reply_at ||
        conv.updated_at ||
        conv.created_at;

      if (!sessionTime) continue;

      if (
        sessionTime < engagedTailWindowStartUnix ||
        sessionTime > monthEndUnix
      ) {
        continue;
      }

      const prev = lastSessionByMember.get(memberId) ?? 0;
      if (sessionTime > prev) {
        lastSessionByMember.set(memberId, sessionTime);
      }
    } catch (err: any) {
      console.error(`Billing: error processing conversation ${conv.id}:`, err?.message ?? err);
    }
  }

  console.log(
    `Billing: members with at least one coaching session in tail window: ${lastSessionByMember.size}`
  );

  // 3) New participants in the month (Registration Date in [monthStart, monthEnd))
  const newParticipantIds = await searchNewParticipantsInMonth(
    monthStartUnix,
    monthEndUnix
  );

  // 4) Engaged participants in the month:
  // Engaged if there exists a day in month where "last coaching session < 57 days ago".
  // Equivalent conditions for lastSessionAt:
  //   - lastSessionAt <= monthEndUnix
  //   - lastSessionAt >= monthStartUnix - 56 days
  const engagedIds = new Set<string>();
  const engagedLowerBound = monthStartUnix - 56 * SECONDS_PER_DAY;

  for (const [memberId, lastSessionAt] of lastSessionByMember.entries()) {
    if (
      lastSessionAt >= engagedLowerBound &&
      lastSessionAt <= monthEndUnix
    ) {
      engagedIds.add(memberId);
    }
  }

  console.log(`Billing: engaged participants in month: ${engagedIds.size}`);

  // 5) Union of IDs we care about: new participants in month OR engaged during month
  const unionIdsSet = new Set<string>();
  for (const id of newParticipantIds) unionIdsSet.add(id);
  for (const id of engagedIds) unionIdsSet.add(id);
  const unionIds = Array.from(unionIdsSet);

  console.log(`Billing: total unique billable members: ${unionIds.length}`);

  if (unionIds.length === 0) {
    return {
      year,
      month,
      monthYearLabel,
      monthStart: monthStartDate.toISOString(),
      monthEnd: monthEndDate.toISOString(),
      generatedAt: new Date().toISOString(),
      totalRows: 0,
      rows: []
    };
  }

  // 6) Fetch contact details for all union IDs
  const contactDetails = await fetchContactsDetails(unionIds);

  const rows: BillingRow[] = [];

  for (const memberId of unionIds) {
    const contact = contactDetails.get(memberId);
    if (!contact) continue;

    const attrs = contact.custom_attributes || {};

    // Registration Date
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

    const isNewParticipant =
      registrationAt !== null &&
      registrationAt >= monthStartUnix &&
      registrationAt < monthEndUnix;

    const lastSessionAt = lastSessionByMember.get(memberId) ?? null;

    const engagedDuringMonth =
      lastSessionAt !== null &&
      lastSessionAt >= engagedLowerBound &&
      lastSessionAt <= monthEndUnix;

    const employerRaw = attrs[EMPLOYER_ATTR_KEY];
    const employer =
      typeof employerRaw === 'string'
        ? employerRaw
        : employerRaw != null
        ? String(employerRaw)
        : null;

    const memberName = contact.name ?? null;
    const memberEmail = contact.email ?? null;

    rows.push({
      memberId,
      memberName,
      memberEmail,
      employer,
      registrationAt,
      lastSessionAt,
      isNewParticipant,
      engagedDuringMonth
    });
  }

  // Sort rows (Employer → Name → ID)
  rows.sort((a, b) => {
    const ae = a.employer ?? '';
    const be = b.employer ?? '';
    if (ae !== be) return ae.localeCompare(be);

    const an = a.memberName ?? '';
    const bn = b.memberName ?? '';
    if (an !== bn) return an.localeCompare(bn);

    return a.memberId.localeCompare(b.memberId);
  });

  return {
    year,
    month,
    monthYearLabel,
    monthStart: monthStartDate.toISOString(),
    monthEnd: monthEndDate.toISOString(),
    generatedAt: new Date().toISOString(),
    totalRows: rows.length,
    rows
  };
}

// ---------- SvelteKit handler ----------

export const POST: RequestHandler = async () => {
  try {
    const report = await runBillingReport();

    return new Response(JSON.stringify(report), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (e: any) {
    console.error('Fatal error in billing report:', e?.message ?? e);
    return new Response(
      JSON.stringify({
        error: 'Intercom billing report failed',
        details: e?.message ?? String(e)
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
