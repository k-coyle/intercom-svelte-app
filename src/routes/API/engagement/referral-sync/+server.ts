import type { RequestHandler } from '@sveltejs/kit';
import {
  coerceIntercomPerPage,
  extractIntercomContacts,
  intercomPaginate,
  intercomRequest
} from '$lib/server/intercom';
import {
  INTERCOM_ATTR_ELIGIBLE_PROGRAMS,
  INTERCOM_ATTR_REFERRAL
} from '$lib/server/intercom-attrs';

// Contact attribute keys
const ATTR_REFERRAL = INTERCOM_ATTR_REFERRAL;
const ATTR_ELIGIBLE_PROGRAMS = INTERCOM_ATTR_ELIGIBLE_PROGRAMS;

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

// ---------- Search contacts by Referral ----------

async function searchContactsByReferral(
  referralValue: string,
  perPage: number
): Promise<IntercomContact[]> {
  const contacts = await intercomPaginate<IntercomContact>({
    path: '/contacts/search',
    body: {
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
      }
    },
    perPage,
    extractItems: extractIntercomContacts,
    onPage: ({ page, items, totalCount }) => {
      const count = totalCount ?? 'unknown';
      console.log(
        `referral-sync contacts page ${page}: ${items} contacts (total_count=${count})`
      );
    }
  });

  console.log(
    `referral-sync: total contacts fetched for Referral="${referralValue}": ${contacts.length}`
  );
  return contacts;
}

// ---------- Core logic ----------

async function runReferralSync(body: ReferralSyncRequest) {
  const dryRun = body.dryRun ?? true;
  const referralValue = body.referralValue ?? DEFAULT_REFERRAL_VALUE;
  const eligibleValue = body.eligibleProgramsValue ?? DEFAULT_ELIGIBLE_VALUE;
  const perPage = coerceIntercomPerPage(body.perPage);

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
