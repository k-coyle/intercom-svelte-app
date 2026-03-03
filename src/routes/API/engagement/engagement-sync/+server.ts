import type { RequestHandler } from '@sveltejs/kit';
import { coerceIntercomPerPage, intercomRequest } from '$lib/server/intercom';
import { createReportLogger } from '$lib/server/report-logger';
import {
	INTERCOM_ATTR_ENROLLED_DATE,
	INTERCOM_ATTR_ENGAGEMENT_STATUS,
	INTERCOM_ATTR_ENGAGEMENT_STATUS_DATE,
	INTERCOM_ATTR_LAST_SESSION
} from '$lib/server/intercom-attrs';
import {
	isAbortError,
	JOB_TTL_MS,
	MIN_TIME_TO_START_REQUEST_MS,
	STEP_BUDGET_MS,
	STEP_SAFETY_MS,
	timeLeftMs
} from '$lib/server/job-runtime';

const SECONDS_PER_DAY = 24 * 60 * 60;
const MAX_LOOKBACK_DAYS = 365;

// Contact attributes (custom)
const ATTR_ENROLLED_DATE = INTERCOM_ATTR_ENROLLED_DATE; // numeric unix seconds
const ATTR_LAST_SESSION = INTERCOM_ATTR_LAST_SESSION; // numeric unix seconds
const ATTR_ENGAGEMENT_STATUS = INTERCOM_ATTR_ENGAGEMENT_STATUS; // 'Engaged' | 'At Risk' | 'Unengaged'
const ATTR_ENGAGEMENT_STATUS_DATE = INTERCOM_ATTR_ENGAGEMENT_STATUS_DATE; // numeric unix seconds

type SyncOp = 'create' | 'step' | 'cancel' | 'cleanup';
type JobStatus = 'queued' | 'running' | 'complete' | 'error' | 'cancelled';
type JobPhase = 'participants' | 'updates' | 'finalize' | 'complete';
type NewStatus = 'Engaged' | 'At Risk' | 'Unengaged';

type EngagementSyncRequest = {
	op?: SyncOp;
	jobId?: string;
	dryRun?: boolean;
	enrolledLookbackDays?: number; // optional: only classify those enrolled in last N days
	perPage?: number;
};

type IntercomContact = {
	id: string;
	role?: string;
	custom_attributes?: Record<string, any>;
};

type EngagementUpdateCandidate = {
	contactId: string;
	newStatus: NewStatus;
};

interface EngagementSyncSummary {
	dryRun: boolean;
	enrolledLookbackDays: number | null;
	perPage: number;
	participantsFetched: number;
	participantsEvaluated: number;
	participantsUpdated: number;
	participantsFailed: number;
	skippedNoEnrolled: number;
	movedToEngaged: number;
	movedToAtRisk: number;
	movedToUnengaged: number;
}

interface EngagementSyncJobState {
	id: string;
	dryRun: boolean;
	enrolledLookbackDays?: number;
	perPage: number;
	nowUnix: number;

	status: JobStatus;
	phase: JobPhase;
	createdAtMs: number;
	updatedAtMs: number;
	error?: string;
	summary?: EngagementSyncSummary;

	participantsStartingAfter?: string;
	updateCandidates: EngagementUpdateCandidate[];
	updateIndex: number;

	participantPagesFetched: number;
	participantsFetched: number;
	participantsEvaluated: number;
	skippedNoEnrolled: number;
	participantsUpdated: number;
	participantsFailed: number;
	movedToEngaged: number;
	movedToAtRisk: number;
	movedToUnengaged: number;
}

const log = createReportLogger('engagement-sync');
const jobs = new Map<string, EngagementSyncJobState>();

function makeJobId() {
	return `engagement-sync-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function cleanExpiredJobs(nowMs: number) {
	for (const [id, job] of jobs.entries()) {
		if (nowMs - job.updatedAtMs > JOB_TTL_MS) {
			log.info('job_expired', { jobId: id, ageMs: nowMs - job.updatedAtMs });
			jobs.delete(id);
		}
	}
}

function parseEnrolledLookbackDays(raw: unknown): number | undefined {
	if (raw == null) return undefined;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
	return Math.min(Math.floor(parsed), MAX_LOOKBACK_DAYS);
}

async function intercomRequestWithDeadline(path: string, init: RequestInit, deadlineMs: number) {
	return intercomRequest(path, init, {
		deadlineMs,
		maxRetries: 3,
		slowThresholdMs: 5_000
	});
}

function createJob(body: EngagementSyncRequest): EngagementSyncJobState {
	const nowMs = Date.now();
	const nowUnix = Math.floor(nowMs / 1000);
	const job: EngagementSyncJobState = {
		id: makeJobId(),
		dryRun: body.dryRun ?? true,
		enrolledLookbackDays: parseEnrolledLookbackDays(body.enrolledLookbackDays),
		perPage: coerceIntercomPerPage(body.perPage),
		nowUnix,
		status: 'queued',
		phase: 'participants',
		createdAtMs: nowMs,
		updatedAtMs: nowMs,
		updateCandidates: [],
		updateIndex: 0,
		participantPagesFetched: 0,
		participantsFetched: 0,
		participantsEvaluated: 0,
		skippedNoEnrolled: 0,
		participantsUpdated: 0,
		participantsFailed: 0,
		movedToEngaged: 0,
		movedToAtRisk: 0,
		movedToUnengaged: 0
	};

	jobs.set(job.id, job);
	log.info('job_create', {
		jobId: job.id,
		dryRun: job.dryRun,
		enrolledLookbackDays: job.enrolledLookbackDays ?? null,
		perPage: job.perPage
	});
	return job;
}

// ----- Helpers -----

function daysBetween(nowUnix: number, pastUnix?: number): number {
	if (pastUnix == null) return Number.POSITIVE_INFINITY;
	const rawDays = (nowUnix - pastUnix) / SECONDS_PER_DAY;
	return rawDays < 0 ? 0 : rawDays; // clamp negatives to 0
}

// Build contact search query to fetch participants: users with Enrolled Date set.
function buildParticipantQuery(job: EngagementSyncJobState): any {
	const filters: any[] = [];

	// Only user role (not leads).
	filters.push({
		field: 'role',
		operator: '=',
		value: 'user'
	});

	// Has Enrolled Date (non-zero/unset).
	filters.push({
		field: `custom_attributes.${ATTR_ENROLLED_DATE}`,
		operator: '>',
		value: 0
	});

	// Optional: only those enrolled in last N days.
	if (job.enrolledLookbackDays && job.enrolledLookbackDays > 0) {
		const sinceUnix = job.nowUnix - job.enrolledLookbackDays * SECONDS_PER_DAY;
		filters.push({
			field: `custom_attributes.${ATTR_ENROLLED_DATE}`,
			operator: '>',
			value: sinceUnix
		});
	}

	if (filters.length === 1) return filters[0];

	return {
		operator: 'AND',
		value: filters
	};
}

function computeNewStatus(
	hasEnrolledDate: boolean,
	hasSession: boolean,
	daysSinceEnrolled: number,
	daysSinceLastSession: number
): NewStatus {
	if (!hasEnrolledDate) return 'Unengaged';

	if (!hasSession) {
		if (daysSinceEnrolled <= 28) return 'Engaged';
		return 'Unengaged';
	}

	if (daysSinceLastSession <= 28) return 'Engaged';
	if (daysSinceLastSession <= 56) return 'At Risk';
	return 'Unengaged';
}

async function fetchParticipantsPage(
	job: EngagementSyncJobState,
	deadlineMs: number
): Promise<{ participants: IntercomContact[]; nextCursor?: string }> {
	const body: any = {
		query: buildParticipantQuery(job),
		pagination: {
			per_page: job.perPage
		}
	};
	if (job.participantsStartingAfter) {
		body.pagination.starting_after = job.participantsStartingAfter;
	}

	const data = await intercomRequestWithDeadline(
		'/contacts/search',
		{
			method: 'POST',
			body: JSON.stringify(body)
		},
		deadlineMs
	);

	const participants = (data.data ?? data.contacts ?? []) as IntercomContact[];
	const nextCursor: string | undefined = data.pages?.next?.starting_after;
	return { participants, nextCursor };
}

function processParticipantsPage(job: EngagementSyncJobState, participants: IntercomContact[]) {
	for (const contact of participants) {
		const attrs = contact.custom_attributes ?? {};

		const enrolledUnixRaw = attrs[ATTR_ENROLLED_DATE];
		const lastSessionUnixRaw = attrs[ATTR_LAST_SESSION];
		const currentStatusRaw = attrs[ATTR_ENGAGEMENT_STATUS];

		const hasEnrolledDate = typeof enrolledUnixRaw === 'number' && enrolledUnixRaw > 0;
		if (!hasEnrolledDate) {
			job.skippedNoEnrolled += 1;
			continue;
		}

		job.participantsEvaluated += 1;

		const enrolledUnix: number = enrolledUnixRaw;
		const lastSessionUnix: number | undefined =
			typeof lastSessionUnixRaw === 'number' ? lastSessionUnixRaw : undefined;

		const hasSession = lastSessionUnix != null;
		const daysSinceEnrolled = daysBetween(job.nowUnix, enrolledUnix);
		const daysSinceLastSession = daysBetween(job.nowUnix, lastSessionUnix);
		const currentStatus: string | undefined =
			typeof currentStatusRaw === 'string' ? currentStatusRaw : undefined;

		const newStatus = computeNewStatus(
			hasEnrolledDate,
			hasSession,
			daysSinceEnrolled,
			daysSinceLastSession
		);

		if (!currentStatus || newStatus !== currentStatus) {
			job.updateCandidates.push({
				contactId: String(contact.id),
				newStatus
			});
		}
	}
}

async function applyCandidate(
	job: EngagementSyncJobState,
	candidate: EngagementUpdateCandidate,
	deadlineMs: number
) {
	try {
		const payload = {
			custom_attributes: {
				[ATTR_ENGAGEMENT_STATUS]: candidate.newStatus,
				[ATTR_ENGAGEMENT_STATUS_DATE]: job.nowUnix
			}
		};

		if (job.dryRun) {
			log.debug('contact_update_dry_run', {
				jobId: job.id,
				contactId: candidate.contactId,
				newStatus: candidate.newStatus
			});
		} else {
			await intercomRequestWithDeadline(
				`/contacts/${candidate.contactId}`,
				{
					method: 'PUT',
					body: JSON.stringify(payload)
				},
				deadlineMs
			);
			log.debug('contact_updated', {
				jobId: job.id,
				contactId: candidate.contactId,
				newStatus: candidate.newStatus
			});
		}

		job.participantsUpdated += 1;
		if (candidate.newStatus === 'Engaged') job.movedToEngaged += 1;
		else if (candidate.newStatus === 'At Risk') job.movedToAtRisk += 1;
		else if (candidate.newStatus === 'Unengaged') job.movedToUnengaged += 1;
	} catch (err: any) {
		if (isAbortError(err)) throw err;
		job.participantsFailed += 1;
		log.error('contact_update_failed', {
			jobId: job.id,
			contactId: candidate.contactId,
			newStatus: candidate.newStatus,
			message: err?.message ?? String(err)
		});
	}
}

function finalizeJob(job: EngagementSyncJobState) {
	job.summary = {
		dryRun: job.dryRun,
		enrolledLookbackDays: job.enrolledLookbackDays ?? null,
		perPage: job.perPage,
		participantsFetched: job.participantsFetched,
		participantsEvaluated: job.participantsEvaluated,
		participantsUpdated: job.participantsUpdated,
		participantsFailed: job.participantsFailed,
		skippedNoEnrolled: job.skippedNoEnrolled,
		movedToEngaged: job.movedToEngaged,
		movedToAtRisk: job.movedToAtRisk,
		movedToUnengaged: job.movedToUnengaged
	};

	job.phase = 'complete';
	job.status = 'complete';
}

function buildProgress(job: EngagementSyncJobState) {
	return {
		participantPagesFetched: job.participantPagesFetched,
		participantsFetched: job.participantsFetched,
		participantsEvaluated: job.participantsEvaluated,
		skippedNoEnrolled: job.skippedNoEnrolled,
		updateCandidates: job.updateCandidates.length,
		updatesProcessed: job.updateIndex,
		participantsUpdated: job.participantsUpdated,
		participantsFailed: job.participantsFailed
	};
}

function buildStatusPayload(job: EngagementSyncJobState) {
	return {
		jobId: job.id,
		status: job.status,
		phase: job.phase,
		done: job.status === 'complete' || job.status === 'error' || job.status === 'cancelled',
		dryRun: job.dryRun,
		enrolledLookbackDays: job.enrolledLookbackDays ?? null,
		perPage: job.perPage,
		progress: buildProgress(job),
		error: job.error ?? null,
		updatedAt: new Date(job.updatedAtMs).toISOString()
	};
}

async function stepJob(job: EngagementSyncJobState): Promise<any> {
	const stepStart = Date.now();
	const deadlineMs = stepStart + STEP_BUDGET_MS - STEP_SAFETY_MS;

	job.status = 'running';
	job.updatedAtMs = Date.now();

	try {
		if (job.phase === 'participants') {
			while (timeLeftMs(deadlineMs) >= MIN_TIME_TO_START_REQUEST_MS) {
				const { participants, nextCursor } = await fetchParticipantsPage(job, deadlineMs);

				job.participantPagesFetched += 1;
				job.participantsFetched += participants.length;
				processParticipantsPage(job, participants);
				job.participantsStartingAfter = nextCursor;

				if (!nextCursor) {
					job.phase = 'updates';
					log.info('phase_advance', {
						jobId: job.id,
						to: 'updates',
						updateCandidates: job.updateCandidates.length
					});
					break;
				}

				// Safety break to avoid cursor loops.
				if (participants.length === 0 && nextCursor) break;
			}
		}

		if (job.phase === 'updates') {
			while (
				timeLeftMs(deadlineMs) >= MIN_TIME_TO_START_REQUEST_MS &&
				job.updateIndex < job.updateCandidates.length
			) {
				const candidate = job.updateCandidates[job.updateIndex];
				await applyCandidate(job, candidate, deadlineMs);
				job.updateIndex += 1;
			}

			if (job.updateIndex >= job.updateCandidates.length) {
				job.phase = 'finalize';
			}
		}

		if (job.phase === 'finalize') {
			finalizeJob(job);
			log.info('job_complete', {
				jobId: job.id,
				dryRun: job.dryRun,
				participantsFetched: job.participantsFetched,
				participantsUpdated: job.participantsUpdated,
				participantsFailed: job.participantsFailed
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
	job: EngagementSyncJobState,
	opts: { maxSteps?: number; stepDelayMs?: number } = {}
): Promise<EngagementSyncSummary> {
	const maxSteps = Math.max(1, Math.floor(opts.maxSteps ?? 500));
	const stepDelayMs = Math.max(0, Math.floor(opts.stepDelayMs ?? 0));

	try {
		for (let i = 0; i < maxSteps; i += 1) {
			const status = await stepJob(job);
			if (!status) throw new Error(`Job not found: ${job.id}`);

			if (status.status === 'error') {
				throw new Error(String(status.error ?? 'engagement-sync job failed'));
			}

			if (status.status === 'cancelled') {
				throw new Error('engagement-sync job cancelled');
			}

			if (status.done || status.status === 'complete' || status.phase === 'complete') {
				if (!job.summary) throw new Error('engagement-sync job completed without summary payload');
				return job.summary;
			}

			if (stepDelayMs > 0) {
				await new Promise((resolve) => setTimeout(resolve, stepDelayMs));
			}
		}

		throw new Error(`engagement-sync job exceeded max steps (${maxSteps})`);
	} finally {
		jobs.delete(job.id);
	}
}

export const POST: RequestHandler = async ({ request }) => {
	cleanExpiredJobs(Date.now());

	let body: EngagementSyncRequest = {};
	try {
		body = (await request.json()) as EngagementSyncRequest;
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
					error: 'Intercom engagement-sync failed',
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
