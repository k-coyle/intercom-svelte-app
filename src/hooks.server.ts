import type { Handle } from '@sveltejs/kit';
import { recordApiHistoryRun } from '$lib/server/report-history';

const API_PREFIX = '/API/';
const HISTORY_ENDPOINT = '/API/engagement/history';

export const handle: Handle = async ({ event, resolve }) => {
	const pathname = event.url.pathname;
	const shouldTrack = pathname.startsWith(API_PREFIX) && pathname !== HISTORY_ENDPOINT;

	if (!shouldTrack) {
		return resolve(event);
	}

	const startedAtMs = Date.now();

	try {
		const response = await resolve(event);
		await recordApiHistoryRun({
			endpoint: pathname,
			method: event.request.method,
			httpStatus: response.status,
			status: response.status >= 400 ? 'failed' : 'success',
			startedAtMs
		});
		return response;
	} catch (error: any) {
		await recordApiHistoryRun({
			endpoint: pathname,
			method: event.request.method,
			httpStatus: 500,
			status: 'failed',
			startedAtMs,
			errorMessage: error?.message ?? String(error)
		});
		throw error;
	}
};
