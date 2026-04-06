import type { RequestHandler } from '@sveltejs/kit';
import { getApiHistorySnapshot } from '$lib/server/report-history';
import { getBuildInfo } from '$lib/server/build-info';

export const GET: RequestHandler = async ({ url }) => {
	const limitRaw = Number(url.searchParams.get('limit') ?? 200);
	const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(Math.floor(limitRaw), 1000)) : 200;

	try {
		const snapshot = await getApiHistorySnapshot(limit);
		const buildInfo = getBuildInfo();
		return new Response(
			JSON.stringify({
				generatedAt: new Date().toISOString(),
				buildInfo,
				...snapshot
			}),
			{
				headers: { 'Content-Type': 'application/json' }
			}
		);
	} catch (error: any) {
		return new Response(
			JSON.stringify({
				error: 'Failed to load API history',
				details: error?.message ?? String(error)
			}),
			{
				status: 500,
				headers: { 'Content-Type': 'application/json' }
			}
		);
	}
};
