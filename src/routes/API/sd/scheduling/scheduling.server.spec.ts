import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildSyntheticEngagementData, type SyntheticEngagementData } from '$lib/testing/engagement-synthetic-data';
import { createOfflineIntercomModule } from '$lib/testing/offline-intercom-mock';
import { INTERCOM_ATTR_EMPLOYER, INTERCOM_ATTR_ELIGIBLE_PROGRAMS } from '$lib/server/intercom-attrs';

type PostHandler = any;
type GetHandler = any;

function postRequest(body: Record<string, unknown>) {
	return new Request('http://localhost/API/sd/scheduling', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	});
}

async function readJson<T>(response: Response): Promise<T> {
	return (await response.json()) as T;
}

async function runJobToComplete(post: PostHandler, createBody: Record<string, unknown>) {
	const cookies = { get: () => undefined };
	const createResponse = await post({
		request: postRequest({ op: 'create', ...createBody }),
		cookies
	});
	expect(createResponse.ok).toBe(true);
	const created = await readJson<{ jobId: string }>(createResponse);
	expect(created.jobId).toBeTruthy();

	let status: any = null;
	for (let i = 0; i < 500; i += 1) {
		const stepResponse = await post({
			request: postRequest({ op: 'step', jobId: created.jobId }),
			cookies
		});
		expect(stepResponse.ok).toBe(true);
		status = await readJson<any>(stepResponse);
		if (status?.done || status?.status === 'complete' || status?.phase === 'complete') break;
	}

	expect(status?.status).toBe('complete');
	return created.jobId;
}

describe('sd scheduling name fallback matching', () => {
	let schedulingPost: PostHandler;
	let schedulingGet: GetHandler;
	let customData: SyntheticEngagementData;

	beforeAll(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-04-15T12:00:00.000Z'));
		vi.resetModules();

		customData = JSON.parse(
			JSON.stringify(buildSyntheticEngagementData({ anchorNow: new Date('2026-04-15T12:00:00.000Z') }))
		) as SyntheticEngagementData;

		customData.contacts[0].name = 'Ariana Marie Cortez';
		customData.contacts[0].email = 'ariana.cortez@example.com';
		customData.contacts[0].custom_attributes[INTERCOM_ATTR_EMPLOYER] = 'Acme Health';
		customData.contacts[0].custom_attributes[INTERCOM_ATTR_ELIGIBLE_PROGRAMS] = ['Lifestyle'];

		const oncehubRows = [
			{
				id: 'BOOK-0001',
				status: 'completed',
				created_time: '2026-04-01T15:00:00.000Z',
				starting_time: '2026-04-02T16:00:00.000Z',
				attendees: ['coach.alpha@uspm.com', 'legacy-member-email@example.com'],
				owner: 'OWNER-1',
				contact: {
					name: 'Ariana Cortez'
				}
			}
		];

		vi.doMock('$env/static/private', () => ({
			ONCEHUB_API_KEY: 'test-oncehub-key',
			ONCEHUB_API_BASE: 'https://api.oncehub.test/v2'
		}));
		vi.doMock('$lib/server/intercom-provider', () => createOfflineIntercomModule(customData));
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (!url.includes('/bookings')) {
					throw new Error(`Unexpected fetch URL in test: ${url}`);
				}

				return new Response(JSON.stringify(oncehubRows), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				});
			})
		);

		({ POST: schedulingPost, GET: schedulingGet } = await import('./+server'));
	});

	afterAll(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
		vi.doUnmock('$env/static/private');
		vi.doUnmock('$lib/server/intercom-provider');
		vi.resetModules();
	});

	it('matches a booking to Intercom by normalized name when email lookup misses', async () => {
		const jobId = await runJobToComplete(schedulingPost, {
			startDate: '2026-04-01',
			endDate: '2026-04-03',
			dateBasis: 'session'
		});

		const rowsUrl = new URL('http://localhost/API/sd/scheduling');
		rowsUrl.searchParams.set('jobId', jobId);
		rowsUrl.searchParams.set('view', 'rows');
		rowsUrl.searchParams.set('limit', '25');
		const rowsResponse = await schedulingGet({ url: rowsUrl });
		expect(rowsResponse.ok).toBe(true);

		const payload = await readJson<{ items: any[]; total: number }>(rowsResponse);
		expect(payload.total).toBe(1);

		const row = payload.items[0];
		expect(row.memberId).toBe(customData.contacts[0].id);
		expect(row.memberName).toBe('Ariana Marie Cortez');
		expect(row.memberEmail).toBe('ariana.cortez@example.com');
		expect(row.oncehubMemberEmail).toBe('legacy-member-email@example.com');
		expect(row.intercomMemberEmail).toBe('ariana.cortez@example.com');
		expect(row.oncehubMemberName).toBe('Ariana Cortez');
		expect(row.memberMatchMethod).toBe('name_relaxed');
		expect(row.employer).toBe('Acme Health');
		expect(row.programs).toEqual(['Lifestyle']);
	});
});
