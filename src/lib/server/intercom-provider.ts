import { env } from '$env/dynamic/private';
import { getRequestEvent } from '$app/server';
import * as intercomApi from '$lib/server/intercom';
import { resolveOfflineFixturesEnabled } from '$lib/server/sandbox-mode';
import { buildSyntheticEngagementData } from '$lib/testing/engagement-synthetic-data';
import { createOfflineIntercomModule } from '$lib/testing/offline-intercom-mock';

function useOfflineFixtures(): boolean {
	try {
		const event = getRequestEvent();
		return resolveOfflineFixturesEnabled({ cookies: event.cookies });
	} catch {
		return resolveOfflineFixturesEnabled();
	}
}

function getApi() {
	if (!useOfflineFixtures()) return intercomApi;
	const now = new Date();
	const stableDailyAnchor = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12, 0, 0)
	);
	const synthetic = buildSyntheticEngagementData({ anchorNow: stableDailyAnchor });
	return createOfflineIntercomModule(synthetic);
}

export const INTERCOM_MAX_PER_PAGE = intercomApi.INTERCOM_MAX_PER_PAGE;

export function coerceIntercomPerPage(...args: Parameters<typeof intercomApi.coerceIntercomPerPage>) {
	return getApi().coerceIntercomPerPage(...args);
}

export function extractIntercomContacts(
	...args: Parameters<typeof intercomApi.extractIntercomContacts>
) {
	return getApi().extractIntercomContacts(...args);
}

export function extractIntercomConversations(
	...args: Parameters<typeof intercomApi.extractIntercomConversations>
) {
	return getApi().extractIntercomConversations(...args);
}

export function fetchContactsByIds(...args: Parameters<typeof intercomApi.fetchContactsByIds>) {
	return getApi().fetchContactsByIds(...args);
}

export function intercomPaginate<T>(...args: Parameters<typeof intercomApi.intercomPaginate<T>>) {
	return getApi().intercomPaginate<T>(...args);
}

export function intercomRequest(...args: Parameters<typeof intercomApi.intercomRequest>) {
	return getApi().intercomRequest(...args);
}
