import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildSyntheticEngagementData } from '$lib/testing/engagement-synthetic-data';
import { createOfflineIntercomModule } from '$lib/testing/offline-intercom-mock';

type PostHandler = any;
type GetHandler = any;

const testData = buildSyntheticEngagementData();

function postRequest(body: Record<string, unknown>) {
	return new Request('http://localhost/API/engagement', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	});
}

async function readJson<T>(response: Response): Promise<T> {
	const payload = (await response.json()) as T;
	return payload;
}

async function runJobToComplete(post: PostHandler, createBody: Record<string, unknown>) {
	const createResponse = await post({ request: postRequest({ op: 'create', ...createBody }) });
	expect(createResponse.ok).toBe(true);
	const created = await readJson<{ jobId: string }>(createResponse);
	expect(typeof created.jobId).toBe('string');
	expect(created.jobId.length).toBeGreaterThan(0);

	let status: any = null;
	for (let i = 0; i < 500; i += 1) {
		const stepResponse = await post({
			request: postRequest({ op: 'step', jobId: created.jobId })
		});
		expect(stepResponse.ok).toBe(true);
		status = await readJson<any>(stepResponse);
		if (status?.done || status?.status === 'complete' || status?.phase === 'complete') break;
	}

	expect(status).not.toBeNull();
	expect(status.status).toBe('complete');
	return { jobId: created.jobId, status };
}

async function cleanupJob(post: PostHandler, jobId: string) {
	const cleanupResponse = await post({ request: postRequest({ op: 'cleanup', jobId }) });
	expect(cleanupResponse.ok).toBe(true);
}

describe('offline reporting endpoints', () => {
	let caseloadPost: PostHandler;
	let caseloadGet: GetHandler;
	let newParticipantsPost: PostHandler;
	let newParticipantsGet: GetHandler;
	let billingPost: PostHandler;
	let billingGet: GetHandler;
	let overviewGet: GetHandler;

	beforeAll(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(testData.anchorNow);
		vi.resetModules();
		vi.doMock('$lib/server/intercom', () => createOfflineIntercomModule(testData));

		({ POST: caseloadPost, GET: caseloadGet } = await import('./caseload/+server'));
		({ POST: newParticipantsPost, GET: newParticipantsGet } = await import(
			'./new-participants/+server'
		));
		({ POST: billingPost, GET: billingGet } = await import('./billing/+server'));
		({ GET: overviewGet } = await import('./overview/+server'));
	});

	afterAll(() => {
		vi.useRealTimers();
		vi.doUnmock('$lib/server/intercom');
		vi.resetModules();
	});

	it('computes overview KPI counts against the shared synthetic dataset', async () => {
		const url = new URL('http://localhost/API/engagement/overview');
		url.searchParams.set('monthYearLabel', testData.expected.overviewMonthLabel);

		const response = await overviewGet({ url });
		expect(response.ok).toBe(true);
		const payload = await readJson<any>(response);

		expect(payload.monthYearLabel).toBe(testData.expected.overviewMonthLabel);
		expect(payload.kpis.newRegistrationsMtd.count).toBe(testData.expected.overview.newRegistrationsMtd.count);
		expect(payload.kpis.newRegistrationsMtd.priorCount).toBe(
			testData.expected.overview.newRegistrationsMtd.priorCount
		);
		expect(payload.kpis.newEnrolleesMtd.count).toBe(testData.expected.overview.newEnrolleesMtd.count);
		expect(payload.kpis.newEnrolleesMtd.priorCount).toBe(
			testData.expected.overview.newEnrolleesMtd.priorCount
		);
		expect(payload.kpis.qualifyingSessionsMtd.count).toBe(
			testData.expected.overview.qualifyingSessionsMtd.count
		);
		expect(payload.kpis.qualifyingSessionsMtd.priorCount).toBe(
			testData.expected.overview.qualifyingSessionsMtd.priorCount
		);
		expect(payload.enrollmentSnapshot.newlyRegisteredWithQualifyingSessionMtd).toEqual(
			testData.expected.overview.enrollmentSnapshot.newlyRegisteredWithQualifyingSessionMtd
		);
		expect(payload.caseloadTrends.sessionsByServiceCodeMtd).toEqual(
			testData.expected.overview.caseloadTrends.sessionsByServiceCodeMtd
		);
		expect(payload.enrollmentSnapshot.newlyRegisteredWithQualifyingSessionMtd.current.pct).not.toBeNull();
		expect(payload.kpis.newRegistrationsMtd.count).toBeGreaterThan(
			payload.kpis.newRegistrationsMtd.priorCount
		);
		expect(payload.kpis.newEnrolleesMtd.count).toBeGreaterThan(
			payload.kpis.newEnrolleesMtd.priorCount
		);
	});

	it('computes caseload summary/members/sessions from the shared dataset', async () => {
		const { jobId } = await runJobToComplete(caseloadPost, {
			lookbackDays: testData.expected.lookbackDays
		});

		const summaryUrl = new URL('http://localhost/API/engagement/caseload');
		summaryUrl.searchParams.set('jobId', jobId);
		summaryUrl.searchParams.set('view', 'summary');
		const summaryResponse = await caseloadGet({ url: summaryUrl });
		expect(summaryResponse.ok).toBe(true);
		const summary = await readJson<any>(summaryResponse);
		expect(summary.totalMembers).toBe(testData.expected.caseload.totalMembers);
		expect(summary.counts.sessions).toBe(testData.expected.caseload.totalSessions);
		expect(summary.summary).toEqual(testData.expected.caseload.buckets);
		expect(summary.summary.bucket_1 + summary.summary.bucket_2).toBeGreaterThan(
			summary.summary.bucket_3 + summary.summary.bucket_4
		);

		const membersUrl = new URL('http://localhost/API/engagement/caseload');
		membersUrl.searchParams.set('jobId', jobId);
		membersUrl.searchParams.set('view', 'members');
		membersUrl.searchParams.set('limit', '4');
		let membersResponse = await caseloadGet({ url: membersUrl });
		expect(membersResponse.ok).toBe(true);
		let membersPage = await readJson<any>(membersResponse);
		expect(membersPage.items.length).toBe(4);
		expect(membersPage.nextOffset).toBe(4);
		expect(membersPage.total).toBe(testData.expected.caseload.totalMembers);

		membersUrl.searchParams.set('offset', String(membersPage.nextOffset));
		membersResponse = await caseloadGet({ url: membersUrl });
		membersPage = await readJson<any>(membersResponse);
		expect(membersPage.items.length).toBe(4);
		expect(membersPage.nextOffset).toBe(8);

		const sessionsUrl = new URL('http://localhost/API/engagement/caseload');
		sessionsUrl.searchParams.set('jobId', jobId);
		sessionsUrl.searchParams.set('view', 'sessions');
		const sessionsResponse = await caseloadGet({ url: sessionsUrl });
		expect(sessionsResponse.ok).toBe(true);
		const sessions = await readJson<any>(sessionsResponse);
		expect(sessions.total).toBe(testData.expected.caseload.totalSessions);
		expect(sessions.items.every((row: any) => ['Phone', 'Video Conference', 'Email', 'Chat'].includes(row.channel))).toBe(true);

		await cleanupJob(caseloadPost, jobId);
	});

	it('computes new-participants summary and bucket rows from the shared dataset', async () => {
		const { jobId } = await runJobToComplete(newParticipantsPost, {
			lookbackDays: testData.expected.lookbackDays
		});

		const summaryUrl = new URL('http://localhost/API/engagement/new-participants');
		summaryUrl.searchParams.set('jobId', jobId);
		summaryUrl.searchParams.set('view', 'summary');
		const summaryResponse = await newParticipantsGet({ url: summaryUrl });
		expect(summaryResponse.ok).toBe(true);
		const summary = await readJson<any>(summaryResponse);
		expect(summary.totalParticipants).toBe(testData.expected.newParticipants.totalParticipants);
		expect(summary.summary).toEqual(testData.expected.newParticipants.summary);

		const rowsUrl = new URL('http://localhost/API/engagement/new-participants');
		rowsUrl.searchParams.set('jobId', jobId);
		rowsUrl.searchParams.set('view', 'participants');
		rowsUrl.searchParams.set('limit', '5000');
		const rowsResponse = await newParticipantsGet({ url: rowsUrl });
		expect(rowsResponse.ok).toBe(true);
		const rowsPayload = await readJson<any>(rowsResponse);
		expect(rowsPayload.total).toBe(testData.expected.newParticipants.totalParticipants);

		const rows = rowsPayload.items as any[];
		const gt14to21 = rows.filter((row) => row.buckets?.gt_14_to_21).length;
		const gt21to28 = rows.filter((row) => row.buckets?.gt_21_to_28).length;
		const gt28 = rows.filter((row) => row.buckets?.gt_28).length;
		expect({ gt_14_to_21: gt14to21, gt_21_to_28: gt21to28, gt_28: gt28 }).toEqual(
			testData.expected.newParticipants.summary
		);

		await cleanupJob(newParticipantsPost, jobId);
	});

	it('computes billing union cohort and engagement flags from the shared dataset', async () => {
		const { jobId } = await runJobToComplete(billingPost, {
			monthYearLabel: testData.expected.billingMonthLabel
		});

		const summaryUrl = new URL('http://localhost/API/engagement/billing');
		summaryUrl.searchParams.set('jobId', jobId);
		summaryUrl.searchParams.set('view', 'summary');
		const summaryResponse = await billingGet({ url: summaryUrl });
		expect(summaryResponse.ok).toBe(true);
		const summary = await readJson<any>(summaryResponse);
		expect(summary.monthYearLabel).toBe(testData.expected.billingMonthLabel);
		expect(summary.totalRows).toBe(testData.expected.billing.totalRows);

		const rowsUrl = new URL('http://localhost/API/engagement/billing');
		rowsUrl.searchParams.set('jobId', jobId);
		rowsUrl.searchParams.set('view', 'rows');
		rowsUrl.searchParams.set('limit', '5000');
		const rowsResponse = await billingGet({ url: rowsUrl });
		expect(rowsResponse.ok).toBe(true);
		const rowsPayload = await readJson<any>(rowsResponse);
		const rows = rowsPayload.items as any[];
		expect(rowsPayload.total).toBe(testData.expected.billing.totalRows);

		const totalNew = rows.filter((row) => row.isNewParticipant).length;
		const totalEngaged = rows.filter((row) => row.engagedDuringMonth).length;
		expect(totalNew).toBe(testData.expected.billing.totalNewParticipants);
		expect(totalEngaged).toBe(testData.expected.billing.totalEngagedDuringMonth);
		expect(rows.some((row) => row.isNewParticipant && !row.engagedDuringMonth)).toBe(true);
		expect(rows.some((row) => !row.isNewParticipant && row.engagedDuringMonth)).toBe(true);
		expect(totalEngaged).toBeGreaterThan(Math.floor(rowsPayload.total * 0.55));

		await cleanupJob(billingPost, jobId);
	});
});
