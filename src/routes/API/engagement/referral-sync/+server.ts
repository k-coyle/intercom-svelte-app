import type { RequestHandler } from '@sveltejs/kit';
import { coerceIntercomPerPage, intercomRequest } from '$lib/server/intercom';
import { createReportLogger } from '$lib/server/report-logger';
import { INTERCOM_ATTR_ELIGIBLE_PROGRAMS, INTERCOM_ATTR_REFERRAL } from '$lib/server/intercom-attrs';
import {
	isAbortError,
	JOB_TTL_MS,
	MIN_TIME_TO_START_REQUEST_MS,
	STEP_BUDGET_MS,
	STEP_SAFETY_MS,
	timeLeftMs
} from '$lib/server/job-runtime';

// Contact attribute keys
const ATTR_REFERRAL = INTERCOM_ATTR_REFERRAL;
const ATTR_ELIGIBLE_PROGRAMS = INTERCOM_ATTR_ELIGIBLE_PROGRAMS;

// Default mapping
const DEFAULT_REFERRAL_VALUE = 'Counter Health';
const DEFAULT_ELIGIBLE_VALUE = 'Smart Access';

type SyncOp = 'create' | 'step' | 'cancel' | 'cleanup';
type JobStatus = 'queued' | 'running' | 'complete' | 'error' | 'cancelled';
type JobPhase = 'contacts' | 'updates' | 'finalize' | 'complete';

type ReferralSyncRequest = {
	op?: SyncOp;
	jobId?: string;
	dryRun?: boolean;
	referralValue?: string; // default "Counter Health"
	eligibleProgramsValue?: string; // default "Smart Access"
	perPage?: number; // default 150, max 150
};

type IntercomContact = {
	id: string;
	role?: string;
	custom_attributes?: Record<string, any>;
};

interface ReferralSyncSummary {
	dryRun: boolean;
	referralValue: string;
	eligibleValue: string;
	perPage: number;
	contactsFetched: number;
	contactsEvaluated: number;
	contactsUpdated: number;
	contactsFailed: number;
	alreadySet: number;
}

interface ReferralSyncJobState {
	id: string;
	dryRun: boolean;
	referralValue: string;
	eligibleValue: string;
	perPage: number;

	status: JobStatus;
	phase: JobPhase;
	createdAtMs: number;
	updatedAtMs: number;
	error?: string;
	summary?: ReferralSyncSummary;

	contactsStartingAfter?: string;
	updateContactIds: string[];
	updateIndex: number;

	contactPagesFetched: number;
	contactsFetched: number;
	contactsEvaluated: number;
	contactsUpdated: number;
	contactsFailed: number;
	alreadySet: number;
}

const log = createReportLogger('engagement-referral-sync');
const jobs = new Map<string, ReferralSyncJobState>();

function makeJobId() {
	return `referral-sync-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function cleanExpiredJobs(nowMs: number) {
	for (const [id, job] of jobs.entries()) {
		if (nowMs - job.updatedAtMs > JOB_TTL_MS) {
			log.info('job_expired', { jobId: id, ageMs: nowMs - job.updatedAtMs });
			jobs.delete(id);
		}
	}
}

async function intercomRequestWithDeadline(path: string, init: RequestInit, deadlineMs: number) {
	return intercomRequest(path, init, {
		deadlineMs,
		maxRetries: 3,
		slowThresholdMs: 5_000
	});
}

function createJob(body: ReferralSyncRequest): ReferralSyncJobState {
	const nowMs = Date.now();
	const job: ReferralSyncJobState = {
		id: makeJobId(),
		dryRun: body.dryRun ?? true,
		referralValue: body.referralValue ?? DEFAULT_REFERRAL_VALUE,
		eligibleValue: body.eligibleProgramsValue ?? DEFAULT_ELIGIBLE_VALUE,
		perPage: coerceIntercomPerPage(body.perPage),
		status: 'queued',
		phase: 'contacts',
		createdAtMs: nowMs,
		updatedAtMs: nowMs,
		updateContactIds: [],
		updateIndex: 0,
		contactPagesFetched: 0,
		contactsFetched: 0,
		contactsEvaluated: 0,
		contactsUpdated: 0,
		contactsFailed: 0,
		alreadySet: 0
	};

	jobs.set(job.id, job);
	log.info('job_create', {
		jobId: job.id,
		dryRun: job.dryRun,
		referralValue: job.referralValue,
		eligibleValue: job.eligibleValue,
		perPage: job.perPage
	});
	return job;
}

async function fetchContactsPage(
	job: ReferralSyncJobState,
	deadlineMs: number
): Promise<{ contacts: IntercomContact[]; nextCursor?: string }> {
	const body: any = {
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
					value: job.referralValue
				}
			]
		},
		pagination: {
			per_page: job.perPage
		}
	};

	if (job.contactsStartingAfter) {
		body.pagination.starting_after = job.contactsStartingAfter;
	}

	const data = await intercomRequestWithDeadline(
		'/contacts/search',
		{
			method: 'POST',
			body: JSON.stringify(body)
		},
		deadlineMs
	);

	const contacts = (data.data ?? data.contacts ?? []) as IntercomContact[];
	const nextCursor: string | undefined = data.pages?.next?.starting_after;
	return { contacts, nextCursor };
}

function processContactsPage(job: ReferralSyncJobState, contacts: IntercomContact[]) {
	for (const contact of contacts) {
		job.contactsEvaluated += 1;
		const attrs = contact.custom_attributes ?? {};
		const currentEligible = attrs[ATTR_ELIGIBLE_PROGRAMS];

		if (currentEligible === job.eligibleValue) {
			job.alreadySet += 1;
			continue;
		}

		job.updateContactIds.push(String(contact.id));
	}
}

async function applyUpdate(job: ReferralSyncJobState, contactId: string, deadlineMs: number): Promise<void> {
	try {
		const payload = {
			custom_attributes: {
				[ATTR_ELIGIBLE_PROGRAMS]: job.eligibleValue
			}
		};

		if (job.dryRun) {
			log.debug('contact_update_dry_run', { jobId: job.id, contactId });
		} else {
			await intercomRequestWithDeadline(
				`/contacts/${contactId}`,
				{
					method: 'PUT',
					body: JSON.stringify(payload)
				},
				deadlineMs
			);
			log.debug('contact_updated', { jobId: job.id, contactId });
		}

		job.contactsUpdated += 1;
	} catch (err: any) {
		if (isAbortError(err)) throw err;
		job.contactsFailed += 1;
		log.error('contact_update_failed', {
			jobId: job.id,
			contactId,
			message: err?.message ?? String(err)
		});
	}
}

function finalizeJob(job: ReferralSyncJobState) {
	job.summary = {
		dryRun: job.dryRun,
		referralValue: job.referralValue,
		eligibleValue: job.eligibleValue,
		perPage: job.perPage,
		contactsFetched: job.contactsFetched,
		contactsEvaluated: job.contactsEvaluated,
		contactsUpdated: job.contactsUpdated,
		contactsFailed: job.contactsFailed,
		alreadySet: job.alreadySet
	};

	job.phase = 'complete';
	job.status = 'complete';
}

function buildProgress(job: ReferralSyncJobState) {
	return {
		contactPagesFetched: job.contactPagesFetched,
		contactsFetched: job.contactsFetched,
		contactsEvaluated: job.contactsEvaluated,
		alreadySet: job.alreadySet,
		updateCandidates: job.updateContactIds.length,
		updatesProcessed: job.updateIndex,
		contactsUpdated: job.contactsUpdated,
		contactsFailed: job.contactsFailed
	};
}

function buildStatusPayload(job: ReferralSyncJobState) {
	return {
		jobId: job.id,
		status: job.status,
		phase: job.phase,
		done: job.status === 'complete' || job.status === 'error' || job.status === 'cancelled',
		dryRun: job.dryRun,
		referralValue: job.referralValue,
		eligibleValue: job.eligibleValue,
		perPage: job.perPage,
		progress: buildProgress(job),
		error: job.error ?? null,
		updatedAt: new Date(job.updatedAtMs).toISOString()
	};
}

async function stepJob(job: ReferralSyncJobState): Promise<any> {
	const stepStart = Date.now();
	const deadlineMs = stepStart + STEP_BUDGET_MS - STEP_SAFETY_MS;

	job.status = 'running';
	job.updatedAtMs = Date.now();

	try {
		if (job.phase === 'contacts') {
			while (timeLeftMs(deadlineMs) >= MIN_TIME_TO_START_REQUEST_MS) {
				const { contacts, nextCursor } = await fetchContactsPage(job, deadlineMs);
				job.contactPagesFetched += 1;
				job.contactsFetched += contacts.length;
				processContactsPage(job, contacts);
				job.contactsStartingAfter = nextCursor;

				if (!nextCursor) {
					job.phase = 'updates';
					log.info('phase_advance', {
						jobId: job.id,
						to: 'updates',
						updateCandidates: job.updateContactIds.length
					});
					break;
				}

				// Safety break to avoid cursor loops.
				if (contacts.length === 0 && nextCursor) break;
			}
		}

		if (job.phase === 'updates') {
			while (
				timeLeftMs(deadlineMs) >= MIN_TIME_TO_START_REQUEST_MS &&
				job.updateIndex < job.updateContactIds.length
			) {
				const contactId = job.updateContactIds[job.updateIndex];
				await applyUpdate(job, contactId, deadlineMs);
				job.updateIndex += 1;
			}

			if (job.updateIndex >= job.updateContactIds.length) {
				job.phase = 'finalize';
			}
		}

		if (job.phase === 'finalize') {
			finalizeJob(job);
			log.info('job_complete', {
				jobId: job.id,
				contactsFetched: job.contactsFetched,
				contactsUpdated: job.contactsUpdated,
				contactsFailed: job.contactsFailed
			});
		}

		job.updatedAtMs = Date.now();
		return buildStatusPayload(job);
	} catch (err: any) {
		if (isAbortError(err)) {
			job.updatedAtMs = Date.now();
			return buildStatusPayload(job);
		}

		job.status = 'error';
		job.phase = 'complete';
		job.error = err?.message ?? String(err);
		job.updatedAtMs = Date.now();
		log.error('job_error', { jobId: job.id, message: job.error });
		return buildStatusPayload(job);
	}
}

async function runJobToCompletion(
	job: ReferralSyncJobState,
	opts: { maxSteps?: number; stepDelayMs?: number } = {}
): Promise<ReferralSyncSummary> {
	const maxSteps = Math.max(1, Math.floor(opts.maxSteps ?? 500));
	const stepDelayMs = Math.max(0, Math.floor(opts.stepDelayMs ?? 0));

	try {
		for (let i = 0; i < maxSteps; i += 1) {
			const status = await stepJob(job);
			if (!status) throw new Error(`Job not found: ${job.id}`);

			if (status.status === 'error') {
				throw new Error(String(status.error ?? 'referral-sync job failed'));
			}

			if (status.status === 'cancelled') {
				throw new Error('referral-sync job cancelled');
			}

			if (status.done || status.status === 'complete' || status.phase === 'complete') {
				if (!job.summary) throw new Error('referral-sync job completed without summary payload');
				return job.summary;
			}

			if (stepDelayMs > 0) {
				await new Promise((resolve) => setTimeout(resolve, stepDelayMs));
			}
		}

		throw new Error(`referral-sync job exceeded max steps (${maxSteps})`);
	} finally {
		jobs.delete(job.id);
	}
}

export const POST: RequestHandler = async ({ request }) => {
	cleanExpiredJobs(Date.now());

	let body: ReferralSyncRequest = {};
	try {
		body = (await request.json()) as ReferralSyncRequest;
	} catch {
		body = {};
	}

	const hasExplicitOp = body?.op != null && String(body.op).trim().length > 0;
	if (!hasExplicitOp) {
		try {
			const job = createJob(body);
			const summary = await runJobToCompletion(job);
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
	}

	const op = String(body.op ?? 'create') as SyncOp | string;

	if (op === 'create') {
		const job = createJob(body);
		return new Response(JSON.stringify(buildStatusPayload(job)), {
			headers: { 'Content-Type': 'application/json' }
		});
	}

	if (op === 'step') {
		const jobId = String(body.jobId ?? '');
		if (!jobId) {
			return new Response(JSON.stringify({ error: 'Missing jobId' }), {
				status: 400,
				headers: { 'Content-Type': 'application/json' }
			});
		}

		const job = jobs.get(jobId);
		if (!job) {
			return new Response(JSON.stringify({ error: 'Job not found', jobId }), {
				status: 404,
				headers: { 'Content-Type': 'application/json' }
			});
		}

		if (job.status === 'complete' || job.status === 'error' || job.status === 'cancelled') {
			return new Response(JSON.stringify(buildStatusPayload(job)), {
				headers: { 'Content-Type': 'application/json' }
			});
		}

		const payload = await stepJob(job);
		return new Response(JSON.stringify(payload), {
			headers: { 'Content-Type': 'application/json' }
		});
	}

	if (op === 'cancel') {
		const jobId = String(body.jobId ?? '');
		const job = jobId ? jobs.get(jobId) : null;
		if (!job) {
			return new Response(JSON.stringify({ error: 'Job not found', jobId }), {
				status: 404,
				headers: { 'Content-Type': 'application/json' }
			});
		}

		job.status = 'cancelled';
		job.phase = 'complete';
		job.updatedAtMs = Date.now();
		log.info('job_cancelled', { jobId: job.id });

		return new Response(JSON.stringify(buildStatusPayload(job)), {
			headers: { 'Content-Type': 'application/json' }
		});
	}

	if (op === 'cleanup') {
		const jobId = String(body.jobId ?? '');
		if (!jobId) {
			return new Response(JSON.stringify({ error: 'Missing jobId' }), {
				status: 400,
				headers: { 'Content-Type': 'application/json' }
			});
		}

		const deleted = jobs.delete(jobId);
		log.info('job_cleanup', { jobId, deleted });

		return new Response(JSON.stringify({ jobId, deleted }), {
			headers: { 'Content-Type': 'application/json' }
		});
	}

	return new Response(
		JSON.stringify({
			error: 'Unknown op',
			details: 'Supported ops: create, step, cancel, cleanup'
		}),
		{ status: 400, headers: { 'Content-Type': 'application/json' } }
	);
};

export const GET: RequestHandler = async ({ url }) => {
	cleanExpiredJobs(Date.now());

	const jobId = url.searchParams.get('jobId') ?? '';
	if (!jobId) {
		return new Response(
			JSON.stringify({
				error: 'Missing jobId',
				usage: 'GET ?jobId=... (status) or ?jobId=...&view=summary'
			}),
			{ status: 400, headers: { 'Content-Type': 'application/json' } }
		);
	}

	const job = jobs.get(jobId);
	if (!job) {
		return new Response(JSON.stringify({ error: 'Job not found', jobId }), {
			status: 404,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	const view = url.searchParams.get('view');
	if (!view) {
		return new Response(JSON.stringify(buildStatusPayload(job)), {
			headers: { 'Content-Type': 'application/json' }
		});
	}

	if (view === 'summary') {
		if (job.status !== 'complete' || !job.summary) {
			return new Response(
				JSON.stringify({
					error: 'Job not complete',
					status: job.status,
					phase: job.phase
				}),
				{ status: 409, headers: { 'Content-Type': 'application/json' } }
			);
		}

		return new Response(JSON.stringify(job.summary), {
			headers: { 'Content-Type': 'application/json' }
		});
	}

	return new Response(
		JSON.stringify({
			error: 'Unknown view',
			details: 'Supported views: summary'
		}),
		{ status: 400, headers: { 'Content-Type': 'application/json' } }
	);
};
