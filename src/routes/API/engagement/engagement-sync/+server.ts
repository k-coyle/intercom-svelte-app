import type { RequestHandler } from '@sveltejs/kit';
import {
  coerceIntercomPerPage,
  extractIntercomContacts,
  intercomPaginate,
  intercomRequest
} from '$lib/server/intercom';
import {
  INTERCOM_ATTR_ENROLLED_DATE,
  INTERCOM_ATTR_ENGAGEMENT_STATUS,
  INTERCOM_ATTR_ENGAGEMENT_STATUS_DATE,
  INTERCOM_ATTR_FIRST_SESSION,
  INTERCOM_ATTR_LAST_SESSION
} from '$lib/server/intercom-attrs';

const SECONDS_PER_DAY = 24 * 60 * 60;

// Contact attributes (custom)
const ATTR_ENROLLED_DATE = INTERCOM_ATTR_ENROLLED_DATE;            // numeric unix seconds
const ATTR_FIRST_SESSION = INTERCOM_ATTR_FIRST_SESSION;           // not needed for status, but kept for future
const ATTR_LAST_SESSION = INTERCOM_ATTR_LAST_SESSION;             // numeric unix seconds
const ATTR_ENGAGEMENT_STATUS = INTERCOM_ATTR_ENGAGEMENT_STATUS;    // 'Engaged' | 'At Risk' | 'Unengaged'
const ATTR_ENGAGEMENT_STATUS_DATE = INTERCOM_ATTR_ENGAGEMENT_STATUS_DATE; // numeric unix seconds

type EngagementSyncRequest = {
  dryRun?: boolean;
  enrolledLookbackDays?: number; // optional: only classify those enrolled in last N days
  perPage?: number;
};

type IntercomContact = {
  id: string;
  role?: string;
  custom_attributes?: Record<string, any>;
};

// ----- Helpers -----

function daysBetween(nowUnix: number, pastUnix?: number): number {
  if (pastUnix == null) return Number.POSITIVE_INFINITY;
  const rawDays = (nowUnix - pastUnix) / SECONDS_PER_DAY;
  return rawDays < 0 ? 0 : rawDays; // clamp negatives to 0
}

// Build contact search query to fetch “participants”: users with Enrolled Date set
function buildParticipantQuery(
  nowUnix: number,
  enrolledLookbackDays?: number
): any {
  const filters: any[] = [];

  // Only user role (not leads)
  filters.push({
    field: 'role',
    operator: '=',
    value: 'user'
  });

  // Has Enrolled Date (non-zero/unset)
  filters.push({
    field: `custom_attributes.${ATTR_ENROLLED_DATE}`,
    operator: '>',
    value: 0
  });

  // Optional: only those enrolled in last N days
  if (enrolledLookbackDays && enrolledLookbackDays > 0) {
    const sinceUnix = nowUnix - enrolledLookbackDays * SECONDS_PER_DAY;
    filters.push({
      field: `custom_attributes.${ATTR_ENROLLED_DATE}`,
      operator: '>',
      value: sinceUnix
    });
  }

  if (filters.length === 1) return filters[0];

  return {
    operator: 'AND',
    value: filters
  };
}

async function searchParticipants(
  nowUnix: number,
  body: EngagementSyncRequest
): Promise<IntercomContact[]> {
  const query = buildParticipantQuery(nowUnix, body.enrolledLookbackDays);
  const perPage = coerceIntercomPerPage(body.perPage);

  const participants = await intercomPaginate<IntercomContact>({
    path: '/contacts/search',
    body: { query },
    perPage,
    extractItems: extractIntercomContacts,
    onPage: ({ page, items, totalCount }) => {
      const count = totalCount ?? 'unknown';
      console.log(
        `engagement-sync contacts page ${page}: ${items} contacts (total_count=${count})`
      );
    }
  });

  console.log(`engagement-sync: total participants fetched: ${participants.length}`);
  return participants;
}

/**
 * Core classification logic (matches your TL;DR):
 *
 * - If no Enrolled Date → skip (we don't call this in that case).
 * - If NO qualifying session yet (no Last Coaching Session):
 *    - daysSinceEnrolled <= 28 → Engaged
 *    - daysSinceEnrolled > 28  → Unengaged
 * - If HAS qualifying session:
 *    - daysSinceLastSession <= 28 → Engaged
 *    - 29–56 → At Risk
 *    - > 56 → Unengaged
 */
function computeNewStatus(
  hasEnrolledDate: boolean,
  hasSession: boolean,
  daysSinceEnrolled: number,
  daysSinceLastSession: number
): string {
  if (!hasEnrolledDate) {
    // Shouldn't be called for these, but guard anyway
    return 'Unengaged';
  }

  if (!hasSession) {
    // No qualifying session yet
    if (daysSinceEnrolled <= 28) {
      return 'Engaged';
    }
    return 'Unengaged';
  }

  // Has at least one qualifying session: use recency only
  if (daysSinceLastSession <= 28) return 'Engaged';
  if (daysSinceLastSession <= 56) return 'At Risk';
  return 'Unengaged';
}

async function runEngagementSync(body: EngagementSyncRequest) {
  const nowUnix = Math.floor(Date.now() / 1000);
  const dryRun = body.dryRun ?? true;

  const participants = await searchParticipants(nowUnix, body);

  let participantsEvaluated = 0;
  let participantsUpdated = 0;
  let skippedNoEnrolled = 0;
  let movedToEngaged = 0;
  let movedToAtRisk = 0;
  let movedToUnengaged = 0;

  for (const contact of participants) {
    const attrs = contact.custom_attributes ?? {};

    const enrolledUnixRaw = attrs[ATTR_ENROLLED_DATE];
    const lastSessionUnixRaw = attrs[ATTR_LAST_SESSION];
    const currentStatusRaw = attrs[ATTR_ENGAGEMENT_STATUS];

    const hasEnrolledDate =
      typeof enrolledUnixRaw === 'number' && enrolledUnixRaw > 0;

    if (!hasEnrolledDate) {
      skippedNoEnrolled++;
      continue;
    }

    participantsEvaluated++;

    const enrolledUnix: number = enrolledUnixRaw;
    const lastSessionUnix: number | undefined =
      typeof lastSessionUnixRaw === 'number' ? lastSessionUnixRaw : undefined;

    const hasSession = lastSessionUnix != null;

    const daysSinceEnrolled = daysBetween(nowUnix, enrolledUnix);
    const daysSinceLastSession = daysBetween(nowUnix, lastSessionUnix);

    const currentStatus: string | undefined =
      typeof currentStatusRaw === 'string' ? currentStatusRaw : undefined;

    const newStatus = computeNewStatus(
      hasEnrolledDate,
      hasSession,
      daysSinceEnrolled,
      daysSinceLastSession
    );

    if (!currentStatus || newStatus !== currentStatus) {
      const payload = {
        custom_attributes: {
          [ATTR_ENGAGEMENT_STATUS]: newStatus,
          [ATTR_ENGAGEMENT_STATUS_DATE]: nowUnix
        }
      };

      if (dryRun) {
        console.log('[DRY RUN] Would update contact', contact.id, payload);
      } else {
        await intercomRequest(`/contacts/${contact.id}`, {
          method: 'PUT',
          body: JSON.stringify(payload)
        });
        console.log('[UPDATED] Contact', contact.id, payload);
      }

      participantsUpdated++;

      if (newStatus === 'Engaged') movedToEngaged++;
      else if (newStatus === 'At Risk') movedToAtRisk++;
      else if (newStatus === 'Unengaged') movedToUnengaged++;
    }
  }

  return {
    dryRun,
    participantsFetched: participants.length,
    participantsEvaluated,
    participantsUpdated,
    skippedNoEnrolled,
    movedToEngaged,
    movedToAtRisk,
    movedToUnengaged
  };
}

// ----- SvelteKit handler -----

export const POST: RequestHandler = async ({ request }) => {
  try {
    const body = (await request.json()) as EngagementSyncRequest;
    const summary = await runEngagementSync(body);

    return new Response(JSON.stringify(summary), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (e: any) {
    console.error('Intercom engagement-sync failed:', e?.message ?? e);
    return new Response(
      JSON.stringify({
        error: 'Intercom engagement-sync failed',
        details: e?.message ?? String(e)
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
