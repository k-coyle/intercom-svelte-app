// src/routes/API/engagement/billing/+server.ts
import type { RequestHandler } from '@sveltejs/kit';
import {
  extractIntercomContacts,
  extractIntercomConversations,
  fetchContactsByIds,
  intercomPaginate,
  INTERCOM_MAX_PER_PAGE
} from '$lib/server/intercom';
import {
  INTERCOM_ATTR_CHANNEL,
  INTERCOM_ATTR_EMPLOYER,
  INTERCOM_ATTR_ENROLLED_DATE
} from '$lib/server/intercom-attrs';

const SECONDS_PER_DAY = 24 * 60 * 60;

// Attribute keys
// NOTE: Billing now uses "Enrolled Date" as the participant start date.
// The BillingRow.registrationAt field will now hold the Enrolled Date.
const ENROLLED_ATTR_KEY = INTERCOM_ATTR_ENROLLED_DATE;
const EMPLOYER_ATTR_KEY = INTERCOM_ATTR_EMPLOYER;
const CHANNEL_ATTR_KEY = INTERCOM_ATTR_CHANNEL;

// Engagement definition
const ENGAGED_DAYS = 57; // "<57 days ago"
const ENGAGED_TAIL_DAYS = ENGAGED_DAYS - 1; // 56
const REPORT_TZ = 'America/New_York';

// Channels that count as "coaching sessions"
const SESSION_CHANNELS = ['Phone', 'Video Conference'] as const;
type SessionChannel = (typeof SESSION_CHANNELS)[number];

interface BillingRow {
  memberId: string;
  memberName: string | null;
  memberEmail: string | null;
  employer: string | null;
  // This is now the Enrolled Date (Unix seconds)
  registrationAt: number | null;
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

/**
 * Fetch ALL closed conversations updated between [startUnix, endUnix],
 * following pagination using pages.next.starting_after.
 */
async function searchClosedConversationsBetween(
  startUnix: number,
  endUnix: number
): Promise<any[]> {
  const conversations = await intercomPaginate({
    path: '/conversations/search',
    body: {
      query: {
        operator: 'AND',
        value: [
          { field: 'state', operator: '=', value: 'closed' },
          { field: 'created_at', operator: '>', value: startUnix },
          { field: 'created_at', operator: '<=', value: endUnix }
        ]
      }
    },
    perPage: INTERCOM_MAX_PER_PAGE,
    extractItems: extractIntercomConversations,
    onPage: ({ page, items, totalCount }) => {
      const count = totalCount ?? 'unknown';
      console.log(
        `Billing: conversations page ${page}: got ${items} (total_count=${count}).`
      );
    }
  });

  console.log(`Billing: total conversations in window: ${conversations.length}`);
  return conversations;
}

/**
 * Search contacts whose Enrolled Date is within [monthStartUnix, monthEndUnix).
 * NOTE: we use > monthStartUnix-1 and < monthEndUnix to avoid <=, which Intercom dislikes.
 */
async function searchNewParticipantsInMonth(
  monthStartUnix: number,
  monthEndUnix: number
): Promise<Set<string>> {
  const ids = new Set<string>();
  const contacts = await intercomPaginate({
    path: '/contacts/search',
    body: {
      query: {
        operator: 'AND',
        value: [
          {
            field: `custom_attributes.${ENROLLED_ATTR_KEY}`,
            operator: '>',
            value: monthStartUnix - 1 // effectively >= monthStartUnix
          },
          {
            field: `custom_attributes.${ENROLLED_ATTR_KEY}`,
            operator: '<',
            value: monthEndUnix // effectively < monthEndUnix
          }
        ]
      }
    },
    perPage: INTERCOM_MAX_PER_PAGE,
    extractItems: extractIntercomContacts,
    onPage: ({ page, items, totalCount }) => {
      const count = totalCount ?? 'unknown';
      console.log(
        `Billing: contacts page ${page}: got ${items} (total_count=${count}).`
      );
    }
  });

  for (const c of contacts) {
    if (c.id) {
      ids.add(String(c.id));
    }
  }

  console.log(`Billing: new participants in month (by Enrolled Date): ${ids.size}`);
  return ids;
}

/**
 * Fetch details for many contacts with limited concurrency.
 */
async function fetchContactsDetails(contactIds: string[]): Promise<Map<string, any>> {
  return fetchContactsByIds(contactIds, {
    concurrency: 10,
    onError: (id, err) => {
      const message = (err as any)?.message ?? String(err);
      console.error(`Billing: error fetching contact ${id}:`, message);
    }
  });
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

function getTzOffsetMinutes(date: Date, timeZone: string): number {
  // Compute offset by comparing the same instant rendered in UTC vs rendered in timeZone
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

  // This is what the timeZone "says" the instant is, expressed as if it were UTC.
  const asIfUtc = Date.UTC(y, m - 1, d, hh, mm, ss);
  return Math.round((asIfUtc - date.getTime()) / 60000);
}

function zonedTimeToUtcUnix(
  year: number,
  monthIndex0: number, // 0-11
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string
): number {
  // Start with a naive UTC guess for the local wall clock time
  const guessUtcMs = Date.UTC(year, monthIndex0, day, hour, minute, second);

  // Determine the actual offset at that instant in the given time zone
  const offsetMin = getTzOffsetMinutes(new Date(guessUtcMs), timeZone);

  // Subtract offset to convert local wall time to UTC
  const utcMs = guessUtcMs - offsetMin * 60_000;
  return Math.floor(utcMs / 1000);
}

function computeMonthWindowNY(monthYearLabel: string): {
  year: number;
  month: number; // 1-12
  monthStartUnix: number;
  monthEndUnix: number; // start of next month in NY, as UTC unix seconds
  monthStartISO: string;
  monthEndISO: string;
} {
  const m = /^(\d{4})-(\d{2})$/.exec(monthYearLabel);
  if (!m) throw new Error(`Invalid monthYearLabel: ${monthYearLabel} (expected YYYY-MM)`);

  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw new Error(`Invalid month: ${month}`);

  const monthIndex0 = month - 1;

  // NY local: start at 00:00:00 on the 1st
  const monthStartUnix = zonedTimeToUtcUnix(year, monthIndex0, 1, 0, 0, 0, REPORT_TZ);

  // NY local: start of next month 00:00:00
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

/**
 * Build billing report for given calendar month.
 */
async function runBillingReport(monthYearLabel: string): Promise<BillingReport> {
  const startedAt = Date.now();

  const {
    year,
    month,
    monthStartUnix,
    monthEndUnix,
    monthStartISO,
    monthEndISO
  } = computeMonthWindowNY(monthYearLabel);

  console.log(`Billing: START month=${monthYearLabel}`);
  console.log(`Billing: window start=${monthStartISO} end=${monthEndISO}`);

  // Tail window for "<57 days ago at least one day during month"
  const engagedTailWindowStartUnix = monthStartUnix - ENGAGED_TAIL_DAYS * SECONDS_PER_DAY;
  console.log(
    `Billing: tail window start=${new Date(engagedTailWindowStartUnix * 1000).toISOString()}`
  );

  // 1) Fetch conversations
  console.log(`Billing: [1/5] Fetching closed conversations (paginated)…`);
  const t1 = Date.now();

  const conversations = await searchClosedConversationsBetween(
    engagedTailWindowStartUnix,
    monthEndUnix - 1
  );

  console.log(
    `Billing: [1/5] Done. conversations=${conversations.length} (${Date.now() - t1}ms)`
  );

  // 2) Process conversations → lastSessionByMember
  console.log(`Billing: [2/5] Processing conversations → last session per member…`);
  const t2 = Date.now();

  const lastSessionByMember = new Map<string, number>();
  let skippedNoChannel = 0;
  let skippedBadChannel = 0;
  let skippedNoContact = 0;
  let skippedNoSessionTime = 0;
  let skippedOutOfWindow = 0;

  for (const conv of conversations) {
    try {
      const attrs = conv.custom_attributes || {};
      const channelValue = attrs[CHANNEL_ATTR_KEY] as string | undefined;
      if (!channelValue) {
        skippedNoChannel++;
        continue;
      }

      if (!SESSION_CHANNELS.includes(channelValue as SessionChannel)) {
        skippedBadChannel++;
        continue;
      }

      const contactsList = conv.contacts?.contacts || [];
      if (!contactsList.length) {
        skippedNoContact++;
        continue;
      }

      const memberId = String(contactsList[0].id);

      const stats = conv.statistics || {};
      const sessionTime: number | undefined =
        stats.last_close_at ||
        stats.last_admin_reply_at ||
        conv.created_at ||
        conv.created_at;

      if (!sessionTime) {
        skippedNoSessionTime++;
        continue;
      }

      if (sessionTime < engagedTailWindowStartUnix || sessionTime >= monthEndUnix) {
        skippedOutOfWindow++;
        continue;
      }

      const prev = lastSessionByMember.get(memberId) ?? 0;
      if (sessionTime > prev) lastSessionByMember.set(memberId, sessionTime);
    } catch (err: any) {
      console.error(`Billing: error processing conversation ${conv.id}:`, err?.message ?? err);
    }
  }

  console.log(
    `Billing: [2/5] Done. membersWithSessions=${lastSessionByMember.size} (${Date.now() - t2}ms)`
  );
  console.log(
    `Billing: skips noChannel=${skippedNoChannel}, badChannel=${skippedBadChannel}, noContact=${skippedNoContact}, noSessionTime=${skippedNoSessionTime}, outOfWindow=${skippedOutOfWindow}`
  );

  // 3) New participants in the month (by Enrolled Date)
  console.log(`Billing: [3/5] Searching new participants (contacts)…`);
  const t3 = Date.now();

  const newParticipantIds = await searchNewParticipantsInMonth(monthStartUnix, monthEndUnix);

  console.log(
    `Billing: [3/5] Done. newParticipants=${newParticipantIds.size} (${Date.now() - t3}ms)`
  );

  // 4) Engaged participants in the month
  console.log(`Billing: [4/5] Computing engaged set…`);
  const t4 = Date.now();

  const engagedIds = new Set<string>();
  const engagedLowerBound = monthStartUnix - ENGAGED_TAIL_DAYS * SECONDS_PER_DAY;

  for (const [memberId, lastSessionAt] of lastSessionByMember.entries()) {
    if (lastSessionAt >= engagedLowerBound && lastSessionAt < monthEndUnix) {
      engagedIds.add(memberId);
    }
  }

  console.log(
    `Billing: [4/5] Done. engaged=${engagedIds.size} (${Date.now() - t4}ms)`
  );

  // 5) Union & fetch contact details
  const unionIdsSet = new Set<string>();
  for (const id of newParticipantIds) unionIdsSet.add(id);
  for (const id of engagedIds) unionIdsSet.add(id);
  const unionIds = Array.from(unionIdsSet);

  console.log(`Billing: union billable members=${unionIds.length}`);

  if (unionIds.length === 0) {
    console.log(`Billing: END (0 rows) totalTime=${Date.now() - startedAt}ms`);
    return {
      year,
      month,
      monthYearLabel,
      monthStart: monthStartISO,
      monthEnd: monthEndISO,
      generatedAt: new Date().toISOString(),
      totalRows: 0,
      rows: []
    };
  }

  console.log(`Billing: [5/5] Fetching contact details for ${unionIds.length} members…`);
  const t5 = Date.now();

  const contactDetails = await fetchContactsDetails(unionIds);

  console.log(
    `Billing: [5/5] Done. fetchedContacts=${contactDetails.size} (${Date.now() - t5}ms)`
  );

  const rows: BillingRow[] = [];
  let missingContacts = 0;

  for (const memberId of unionIds) {
    const contact = contactDetails.get(memberId);
    if (!contact) {
      missingContacts++;
      continue;
    }

    const attrs = contact.custom_attributes || {};

    // NOTE: This is now the Enrolled Date value from Intercom.
    const enrolledRaw = attrs[ENROLLED_ATTR_KEY];
    let registrationAt: number | null = null;

    if (typeof enrolledRaw === 'number') registrationAt = enrolledRaw;
    else if (typeof enrolledRaw === 'string') {
      const parsed = Date.parse(enrolledRaw);
      if (!Number.isNaN(parsed)) registrationAt = Math.floor(parsed / 1000);
    }

    const isNewParticipant =
      registrationAt !== null &&
      registrationAt >= monthStartUnix &&
      registrationAt < monthEndUnix;

    const lastSessionAt = lastSessionByMember.get(memberId) ?? null;

    const engagedLowerBound = monthStartUnix - ENGAGED_TAIL_DAYS * SECONDS_PER_DAY;
    const engagedDuringMonth =
      lastSessionAt !== null &&
      lastSessionAt >= engagedLowerBound &&
      lastSessionAt < monthEndUnix;

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

  console.log(
    `Billing: rows=${rows.length} (missingContacts=${missingContacts}) totalTime=${Date.now() - startedAt}ms`
  );
  console.log(`Billing: END month=${monthYearLabel}`);

  return {
    year,
    month,
    monthYearLabel,
    monthStart: monthStartISO,
    monthEnd: monthEndISO,
    generatedAt: new Date().toISOString(),
    totalRows: rows.length,
    rows
  };
}

// ---------- SvelteKit handler ----------

export const POST: RequestHandler = async ({ request }) => {
  try {
    const body = await request.json().catch(() => ({}));
    const monthYearLabel = String(body?.monthYearLabel ?? '').trim();

    if (!monthYearLabel) {
      return new Response(
        JSON.stringify({ error: 'monthYearLabel is required (YYYY-MM)' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const report = await runBillingReport(monthYearLabel);

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
