import type { RequestHandler } from '@sveltejs/kit';
import {
  INTERCOM_ACCESS_TOKEN,
  INTERCOM_VERSION,
  INTERCOM_API_BASE
} from '$env/static/private';

const INTERCOM_BASE_URL = INTERCOM_API_BASE || 'https://api.intercom.io';
const INTERCOM_API_VERSION = INTERCOM_VERSION || '2.10';
const MAX_RETRIES = 3;

// Contact attribute keys
const ATTR_REFERRAL = 'Referral';
const ATTR_ELIGIBLE_PROGRAMS = 'Eligible Programs';

// Default mapping
const DEFAULT_REFERRAL_VALUE = 'Counter Health';
const DEFAULT_ELIGIBLE_VALUE = 'Smart Access';

type ReferralSyncRequest = {
  dryRun?: boolean;
  referralValue?: string;         // default "Counter Health"
  eligibleProgramsValue?: string; // default "Smart Access"
  perPage?: number;               // default 150, max 150
};

type IntercomContact = {
  id: string;
  role?: string;
  custom_attributes?: Record<string, any>;
};

// ---------- Utility ----------

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- Intercom helper with 429 retry ----------

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

// ---------- Search contacts by Referral ----------

async function searchContactsByReferral(
  referralValue: string,
  perPage: number
): Promise<IntercomContact[]> {
  const all: IntercomContact[] = [];
  let page = 1;
  let pagination: any = { per_page: perPage };

  while (pagination) {
    const payload = {
      query: {
        operator: 'AND',
        value: [
          {
            field: 'role',
            operator: '=',
            value: 'user'
          },
          {
            field: `custom_attributes.${ATTR_REFERRAL}`,
            operator: '=',
            value: referralValue
          }
        ]
      },
      pagination
    };

    const data = await intercomRequest('/contacts/search', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    const contacts: IntercomContact[] = data.data ?? [];
    const totalCount = data.total_count ?? data.total ?? 'unknown';

    console.log(
      `referral-sync contacts page ${page}: ${contacts.length} contacts (total_count=${totalCount})`
    );

    all.push(...contacts);

    if (!data.pages?.next?.starting_after) {
      pagination = null;
      break;
    }

    pagination = {
      per_page: perPage,
      starting_after: data.pages.next.starting_after
    };
    page += 1;
  }

  console.log(
    `referral-sync: total contacts fetched for Referral="${referralValue}": ${all.length}`
  );
  return all;
}

// ---------- Core logic ----------

async function runReferralSync(body: ReferralSyncRequest) {
  const dryRun = body.dryRun ?? true;
  const referralValue = body.referralValue ?? DEFAULT_REFERRAL_VALUE;
  const eligibleValue = body.eligibleProgramsValue ?? DEFAULT_ELIGIBLE_VALUE;
  const perPage =
    body.perPage && body.perPage > 0 && body.perPage <= 150 ? body.perPage : 150;

  const contacts = await searchContactsByReferral(referralValue, perPage);

  let contactsEvaluated = 0;
  let contactsUpdated = 0;
  let alreadySet = 0;

  for (const contact of contacts) {
    contactsEvaluated++;

    const attrs = contact.custom_attributes ?? {};
    const currentEligible = attrs[ATTR_ELIGIBLE_PROGRAMS];

    if (currentEligible === eligibleValue) {
      // Already correct
      alreadySet++;
      continue;
    }

    const payload = {
      custom_attributes: {
        [ATTR_ELIGIBLE_PROGRAMS]: eligibleValue
      }
    };

    if (dryRun) {
      console.log(
        `[DRY RUN] Would set "${ATTR_ELIGIBLE_PROGRAMS}"="${eligibleValue}" for contact`,
        contact.id
      );
    } else {
      await intercomRequest(`/contacts/${contact.id}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
      console.log(
        `[UPDATED] Set "${ATTR_ELIGIBLE_PROGRAMS}"="${eligibleValue}" for contact`,
        contact.id
      );
    }

    contactsUpdated++;
  }

  return {
    dryRun,
    referralValue,
    eligibleValue,
    perPage,
    contactsFetched: contacts.length,
    contactsEvaluated,
    contactsUpdated,
    alreadySet
  };
}

// ---------- SvelteKit handler ----------

export const POST: RequestHandler = async ({ request }) => {
  try {
    const body = (await request.json()) as ReferralSyncRequest;
    const summary = await runReferralSync(body);

    return new Response(JSON.stringify(summary), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (e: any) {
    console.error('Intercom referral-sync failed:', e?.message ?? e);
    return new Response(
      JSON.stringify({
        error: 'Intercom referral-sync failed',
        details: e?.message ?? String(e)
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
