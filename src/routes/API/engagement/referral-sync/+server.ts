import type { RequestHandler } from '@sveltejs/kit';
import {
  coerceIntercomPerPage,
  extractIntercomContacts,
  intercomPaginate,
  intercomRequest
} from '$lib/server/intercom';
import { createReportLogger } from '$lib/server/report-logger';
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
const log = createReportLogger('engagement-referral-sync');

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
      log.debug('contacts_page', {
        page,
        pageItems: items,
        totalCount: totalCount ?? null
      });
    }
  });

  log.info('contacts_fetched', { referralValue, count: contacts.length });
  return contacts;
}

// ---------- Core logic ----------

async function runReferralSync(body: ReferralSyncRequest) {
  const dryRun = body.dryRun ?? true;
  const referralValue = body.referralValue ?? DEFAULT_REFERRAL_VALUE;
  const eligibleValue = body.eligibleProgramsValue ?? DEFAULT_ELIGIBLE_VALUE;
  const perPage = coerceIntercomPerPage(body.perPage);
  log.info('sync_start', { dryRun, referralValue, eligibleValue, perPage });

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
      log.debug('contact_update_dry_run', { contactId: contact.id });
    } else {
      await intercomRequest(`/contacts/${contact.id}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
      log.debug('contact_updated', { contactId: contact.id });
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
    log.info('sync_complete', summary);

    return new Response(JSON.stringify(summary), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (e: any) {
    log.error('sync_failed', { message: e?.message ?? String(e) });
    return new Response(
      JSON.stringify({
        error: 'Intercom referral-sync failed',
        details: e?.message ?? String(e)
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
