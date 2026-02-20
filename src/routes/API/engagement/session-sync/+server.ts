import type { RequestHandler } from '@sveltejs/kit';
import {
  extractIntercomConversations,
  intercomPaginate,
  intercomRequest,
  INTERCOM_MAX_PER_PAGE
} from '$lib/server/intercom';
import {
  INTERCOM_ATTR_CHANNEL,
  INTERCOM_ATTR_ENROLLED_DATE,
  INTERCOM_ATTR_FIRST_SESSION,
  INTERCOM_ATTR_LAST_CALL,
  INTERCOM_ATTR_LAST_SESSION,
  INTERCOM_ATTR_REGISTRATION_DATE,
  INTERCOM_ATTR_SERVICE_CODE
} from '$lib/server/intercom-attrs';

const SECONDS_PER_DAY = 24 * 60 * 60;

// Conversation custom attributes
const CHANNEL_ATTR_KEY = INTERCOM_ATTR_CHANNEL;
const SERVICE_CODE_ATTR_KEY = INTERCOM_ATTR_SERVICE_CODE;

const CHANNEL_PHONE = 'Phone';
const CHANNEL_VIDEO = 'Video Conference';
const CALL_CHANNELS = [CHANNEL_PHONE, CHANNEL_VIDEO] as const;

const SERVICE_CODE_ALLOWED = ['Health Coaching 001', 'Disease Management 002'] as const;

// Contact custom attributes
const ATTR_ENROLLED_DATE = INTERCOM_ATTR_ENROLLED_DATE;     // used indirectly via engagement job
const ATTR_REGISTRATION_DATE = INTERCOM_ATTR_REGISTRATION_DATE;
const ATTR_FIRST_SESSION = INTERCOM_ATTR_FIRST_SESSION;
const ATTR_LAST_SESSION = INTERCOM_ATTR_LAST_SESSION;
const ATTR_LAST_CALL = INTERCOM_ATTR_LAST_CALL;

type Mode = 'all' | 'first-only' | 'last-and-call-only';

type SessionSyncRequest = {
  lookbackDays?: number;
  dryRun?: boolean;
  mode?: Mode;
};

type IntercomConversation = any;
type IntercomContact = any;

// ---------- Conversations search ----------

async function searchConversationsSince(sinceUnix: number): Promise<IntercomConversation[]> {
  const conversations = await intercomPaginate<IntercomConversation>({
    path: '/conversations/search',
    body: {
      query: {
        field: 'updated_at',
        operator: '>',
        value: sinceUnix
      }
    },
    perPage: INTERCOM_MAX_PER_PAGE,
    extractItems: extractIntercomConversations,
    onPage: ({ page, items, totalCount }) => {
      const count = totalCount ?? 'unknown';
      console.log(
        `session-sync conversations page ${page}: ${items} convos (total_count=${count})`
      );
    }
  });

  console.log(`session-sync: total conversations fetched: ${conversations.length}`);
  return conversations;
}


// ---------- Contacts helper ----------

async function getContact(contactId: string): Promise<IntercomContact> {
  return intercomRequest(`/contacts/${contactId}`);
}

async function updateContactCustomAttributes(
  contactId: string,
  attrs: Record<string, any>,
  dryRun: boolean
): Promise<void> {
  const body = { custom_attributes: attrs };

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

// ---------- Core session sync ----------

async function runSessionSync(lookbackDays: number, mode: Mode, dryRun: boolean) {
  const nowUnix = Math.floor(Date.now() / 1000);
  const sinceUnix = nowUnix - lookbackDays * SECONDS_PER_DAY;

  console.log(
    `Session sync: lookbackDays=${lookbackDays}, mode=${mode}, dryRun=${dryRun}, sinceUnix=${sinceUnix}`
  );

  const conversations = await searchConversationsSince(sinceUnix);

  // Maps: contactId -> unix seconds
  const firstSessionByContact = new Map<string, number>();
  const lastSessionByContact = new Map<string, number>();
  const lastCallByContact = new Map<string, number>();

  let totalConversations = 0;
  let qualifyingSessions = 0;
  let qualifyingCalls = 0;

  for (const conv of conversations) {
    totalConversations++;

    const attrs = conv.custom_attributes ?? {};
    const channel = attrs[CHANNEL_ATTR_KEY];
    const serviceCode = attrs[SERVICE_CODE_ATTR_KEY];
    const state = conv.state;

    const contactsList = conv.contacts?.contacts ?? conv.contacts?.data ?? [];
    if (!contactsList.length) continue;

    const contactId: string = contactsList[0].id;

    const stats = conv.statistics ?? {};
    const convTime: number =
      stats.last_close_at ||
      stats.last_admin_reply_at ||
      conv.updated_at ||
      conv.created_at;

    if (!convTime) continue;

    // --- Last Call (Channel = Phone, any state) ---
    if ((mode === 'all' || mode === 'last-and-call-only') && channel === CHANNEL_PHONE) {
      qualifyingCalls++;
      const existingCall = lastCallByContact.get(contactId);
      if (!existingCall || convTime > existingCall) {
        lastCallByContact.set(contactId, convTime);
      }
    }

    // --- Coaching sessions (Channel Phone/Video + Service Code + closed) ---
    const isQualifyingSession =
      (mode === 'all' || mode === 'first-only' || mode === 'last-and-call-only') &&
      CALL_CHANNELS.includes(channel) &&
      SERVICE_CODE_ALLOWED.includes(serviceCode) &&
      state === 'closed';

    if (!isQualifyingSession) continue;

    qualifyingSessions++;

    // Track FIRST and LAST session times
    const existingFirst = firstSessionByContact.get(contactId);
    if (!existingFirst || convTime < existingFirst) {
      firstSessionByContact.set(contactId, convTime);
    }

    const existingLast = lastSessionByContact.get(contactId);
    if (!existingLast || convTime > existingLast) {
      lastSessionByContact.set(contactId, convTime);
    }
  }

  console.log(
    `Session sync processed ${totalConversations} conversations, ` +
      `${qualifyingSessions} qualifying sessions, ${qualifyingCalls} qualifying calls`
  );

  // Build the set of contacts we need to inspect/update
  const contactIds = new Set<string>();
  if (mode === 'all' || mode === 'first-only') {
    for (const id of firstSessionByContact.keys()) contactIds.add(id);
  }
  if (mode === 'all' || mode === 'last-and-call-only') {
    for (const id of lastSessionByContact.keys()) contactIds.add(id);
    for (const id of lastCallByContact.keys()) contactIds.add(id);
  }

  console.log(`Session sync: contacts with potential updates: ${contactIds.size}`);

  let contactsUpdated = 0;

  const concurrency = 10;
  const idsArray = Array.from(contactIds);
  let index = 0;

  async function processNextBatch() {
    const batch = idsArray.slice(index, index + concurrency);
    index += concurrency;

    await Promise.all(
      batch.map(async (contactId) => {
        try {
          const contact = await getContact(contactId);
          const existingAttrs = contact.custom_attributes ?? {};

          const payload: Record<string, any> = {};

          // ----- First Session Date -----
          if (mode === 'all' || mode === 'first-only') {
            const newFirstUnix = firstSessionByContact.get(contactId);
            if (newFirstUnix) {
              const existingFirstUnix = existingAttrs[ATTR_FIRST_SESSION];
              let desiredFirst = newFirstUnix;

              if (existingFirstUnix && typeof existingFirstUnix === 'number') {
                desiredFirst = Math.min(existingFirstUnix, newFirstUnix);
              }

              if (!existingFirstUnix || desiredFirst !== existingFirstUnix) {
                payload[ATTR_FIRST_SESSION] = desiredFirst;
              }
            }
          }

          // ----- Last Coaching Session -----
          if (mode === 'all' || mode === 'last-and-call-only') {
            const newLastUnix = lastSessionByContact.get(contactId);
            if (newLastUnix) {
              const existingLastUnix = existingAttrs[ATTR_LAST_SESSION];
              let desiredLast = newLastUnix;

              if (existingLastUnix && typeof existingLastUnix === 'number') {
                desiredLast = Math.max(existingLastUnix, newLastUnix);
              }

              if (!existingLastUnix || desiredLast !== existingLastUnix) {
                payload[ATTR_LAST_SESSION] = desiredLast;
              }
            }

            // ----- Last Call -----
            const newLastCallUnix = lastCallByContact.get(contactId);
            if (newLastCallUnix) {
              const existingLastCallUnix = existingAttrs[ATTR_LAST_CALL];
              let desiredLastCall = newLastCallUnix;

              if (existingLastCallUnix && typeof existingLastCallUnix === 'number') {
                desiredLastCall = Math.max(existingLastCallUnix, newLastCallUnix);
              }

              if (!existingLastCallUnix || desiredLastCall !== existingLastCallUnix) {
                payload[ATTR_LAST_CALL] = desiredLastCall;
              }
            }
          }

          if (Object.keys(payload).length === 0) {
            return;
          }

          await updateContactCustomAttributes(contactId, payload, dryRun);
          contactsUpdated++;
        } catch (err: any) {
          console.error(`Error updating contact ${contactId}:`, err?.message ?? err);
        }
      })
    );

    if (index < idsArray.length) {
      await processNextBatch();
    }
  }

  if (idsArray.length > 0) {
    await processNextBatch();
  }

  return {
    lookbackDays,
    mode,
    dryRun,
    totalConversations,
    qualifyingSessions,
    qualifyingCalls,
    contactsWithFirstSessionCandidates: firstSessionByContact.size,
    contactsWithLastSessionCandidates: lastSessionByContact.size,
    contactsWithLastCallCandidates: lastCallByContact.size,
    contactsUpdated
  };
}

// ---------- SvelteKit handler ----------

export const POST: RequestHandler = async ({ request }) => {
  try {
    const body = (await request.json()) as SessionSyncRequest;

    const lookbackDays = body.lookbackDays ?? 30;
    const dryRun = body.dryRun ?? true;
    const mode: Mode = body.mode ?? 'all';

    const summary = await runSessionSync(lookbackDays, mode, dryRun);

    return new Response(JSON.stringify(summary), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (e: any) {
    console.error('Intercom session-sync failed:', e?.message ?? e);
    return new Response(
      JSON.stringify({
        error: 'Intercom session-sync failed',
        details: e?.message ?? String(e)
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
