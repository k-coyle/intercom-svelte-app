import type { RequestHandler } from '@sveltejs/kit';
import {INTERCOM_ACCESS_TOKEN, INTERCOM_VERSION, INTERCOM_API_BASE } from '$env/static/private';

const INTERCOM_BASE_URL = INTERCOM_API_BASE || 'https://api.intercom.io';
const INTERCOM_API_VERSION = INTERCOM_VERSION || '2.10';

const PEOPLE_ATTR_LAST_CALL_KEY = 'Last Coaching Call';
const PEOPLE_ATTR_STATUS_KEY = 'Engagement Status';
const CHANNEL_ATTR_KEY = 'Channel';
const CHANNEL_CALL_VALUES = ['Phone', 'Video Conference'] as const;

const DEFAULT_LOOKBACK_DAYS = 7; // keep small for first dry run
const SECONDS_PER_DAY = 24 * 60 * 60;

/**
 * Basic Intercom API helper.
 */
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
 * Fetch *all* closed conversations updated since `sinceUnix`,
 * following all pages using starting_after cursor.
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
      // 👈 This is the *string* cursor from the previous response
      body.pagination.starting_after = startingAfter;
    }

    const data = await intercomRequest('/conversations/search', {
      method: 'POST',
      body: JSON.stringify(body)
    });

    const conversations = data.conversations ?? [];
    const totalCount = data.total_count ?? data.total ?? 'unknown';

    console.log(
      `Page ${page}: got ${conversations.length} conversations (total_count=${totalCount}).`
    );

    allConversations.push(...conversations);

    // ✅ Correctly get the *string* cursor for the next page
    const nextCursor: string | undefined = data.pages?.next?.starting_after;

    if (!nextCursor) {
      break; // no more pages
    }

    startingAfter = nextCursor;
    page += 1;
  }

  console.log(`Total fetched conversations: ${allConversations.length}`);
  return allConversations;
}

/**
 * Fetch full contact details to read attributes.
 */
async function getContact(contactId: string): Promise<any> {
  return intercomRequest(`/contacts/${contactId}`);
}

/**
 * Classify engagement bucket.
 */
function classifyEngagement(daysSince: number): string {
  if (daysSince <= 30) return 'Engaged';
  if (daysSince <= 60) return 'At Risk';
  return 'Unengaged';
}

/**
 * DRY-RUN update: just log what we WOULD do.
 */
async function updateContact(contactId: string, lastCallUnix: number, status: string, dryRun: boolean) {
  const body = {
    custom_attributes: {
      [PEOPLE_ATTR_LAST_CALL_KEY]: lastCallUnix,
      [PEOPLE_ATTR_STATUS_KEY]: status
    }
  };

  if (dryRun) {
    console.log('[DRY RUN] Would update contact', contactId, body);
    return;
  }

  await intercomRequest(`/contacts/${contactId}`, {
    method: 'PUT',
    body: JSON.stringify(body)
  });

  console.log('[UPDATED] Contact', contactId, body);
}

/**
 * Core logic: compute last call per contact and log updates (no writes).
 */
async function runEngagementSync(lookbackDays: number, dryRun: boolean) {
  const nowUnix = Math.floor(Date.now() / 1000);
  const sinceUnix = nowUnix - lookbackDays * SECONDS_PER_DAY;

  console.log(
    `Intercom coach-engagement sync: lookbackDays=${lookbackDays}, dryRun=${dryRun}, sinceUnix=${sinceUnix}`
  );

  const lastCallByContact = new Map<string, number>();

  const conversations = await searchClosedConversationsSince(sinceUnix);

  const concurrency = 20; // can be pretty high now, we're not doing extra network calls
  const queue = [...conversations];

  let conversationsChecked = 0;
  let conversationsWithCallChannel = 0;

  while (queue.length > 0) {
    const batch = queue.splice(0, concurrency);

    await Promise.all(
      batch.map(async (conv) => {
        try {
          conversationsChecked += 1;

          const attrs = conv.custom_attributes || {};
          const channelValue = attrs[CHANNEL_ATTR_KEY];

          if (!CHANNEL_CALL_VALUES.includes(channelValue)) {
            return;
          }

          conversationsWithCallChannel += 1;

          const contactsList = conv.contacts?.contacts || [];
          if (!contactsList.length) return;

          const contactId = contactsList[0].id as string;

          const stats = conv.statistics || {};
          const callTime =
            stats.last_close_at ||
            stats.last_admin_reply_at ||
            conv.updated_at ||
            conv.created_at;

          if (!callTime) return;

          const existing = lastCallByContact.get(contactId);
          if (!existing || callTime > existing) {
            lastCallByContact.set(contactId, callTime);
          }
        } catch (err: any) {
          console.error(`Error processing conversation ${conv.id}:`, err?.message ?? err);
        }
      })
    );
  }

  console.log(
    `Checked ${conversationsChecked} closed conversations; ` +
      `${conversationsWithCallChannel} had channel in [${CHANNEL_CALL_VALUES.join(', ')}].`
  );

  // Contact updates: I’d still keep these sequential or low-concurrency to avoid rate limits
  let contactsUpdated = 0;
  for (const [contactId, lastCallUnix] of lastCallByContact.entries()) {
    const daysSince = (nowUnix - lastCallUnix) / SECONDS_PER_DAY;
    const status = classifyEngagement(daysSince);

    console.log(
      `Contact ${contactId}: last_call=${new Date(
        lastCallUnix * 1000
      ).toISOString()}, days_since=${daysSince.toFixed(1)}, status=${status}`
    );

    try {
      await updateContact(contactId, lastCallUnix, status, dryRun);
      contactsUpdated += 1;
    } catch (err: any) {
      console.error(`Error updating contact ${contactId}:`, err?.message ?? err);
    }
  }

  return {
    lookbackDays,
    dryRun,
    conversationsChecked,
    conversationsWithCallChannel,
    contactsWithCalls: lastCallByContact.size,
    contactsUpdated
  };
}

/**
 * SvelteKit POST handler.
 * Body: { "lookbackDays"?: number }  (dry run is always true here)
 */
export const POST: RequestHandler = async ({ request }) => {
  try {
    // Read the body ONCE as text
    const raw = await request.text();

    let body: any = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch (err) {
      console.error('Error parsing JSON body:', err);
      body = {};
    }

    // Use parsed values, with defaults
    const lookbackDays = Number(body.lookbackDays ?? DEFAULT_LOOKBACK_DAYS);
    const dryRun = body.dryRun ?? true;

    console.log('USING lookbackDays:', lookbackDays, 'dryRun:', dryRun);

    const summary = await runEngagementSync(lookbackDays, dryRun);

    return new Response(JSON.stringify(summary), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (e: any) {
    console.error('Fatal error in coach-engagement sync:', e?.message ?? e);
    return new Response(
      JSON.stringify({
        error: 'Intercom coach-engagement sync failed',
        details: e?.message ?? String(e)
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};