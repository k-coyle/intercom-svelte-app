import type { RequestHandler } from '@sveltejs/kit';
import {
	intercomRequest,
	INTERCOM_MAX_PER_PAGE
} from '$lib/server/intercom';
import { createReportLogger } from '$lib/server/report-logger';
import {
	INTERCOM_ATTR_CHANNEL,
	INTERCOM_ATTR_FIRST_SESSION,
	INTERCOM_ATTR_LAST_CALL,
	INTERCOM_ATTR_LAST_SESSION,
	INTERCOM_ATTR_SERVICE_CODE
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

// Conversation custom attributes
const CHANNEL_ATTR_KEY = INTERCOM_ATTR_CHANNEL;
const SERVICE_CODE_ATTR_KEY = INTERCOM_ATTR_SERVICE_CODE;

const CHANNEL_PHONE = 'Phone';
const CHANNEL_VIDEO = 'Video Conference';
const CALL_CHANNELS = [CHANNEL_PHONE, CHANNEL_VIDEO] as const;

const SERVICE_CODE_ALLOWED = ['Health Coaching 001', 'Disease Management 002'] as const;

// Contact custom attributes
const ATTR_FIRST_SESSION = INTERCOM_ATTR_FIRST_SESSION;
const ATTR_LAST_SESSION = INTERCOM_ATTR_LAST_SESSION;
const ATTR_LAST_CALL = INTERCOM_ATTR_LAST_CALL;

type Mode = 'all' | 'first-only' | 'last-and-call-only';
type JobStatus = 'queued' | 'running' | 'complete' | 'error' | 'cancelled';
type JobPhase = 'conversations' | 'contacts' | 'finalize' | 'complete';

type SessionSyncRequest = {
	op?: 'create' | 'step' | 'cancel' | 'cleanup';
	jobId?: string;
	lookbackDays?: number;
	dryRun?: boolean;
	mode?: Mode;
};

const log = createReportLogger('engagement-session-sync');
const jobs = new Map<string, SessionSyncJobState>();

interface SessionSyncSummary {
	lookbackDays: number;
	mode: Mode;
	dryRun: boolean;
	totalConversations: number;
	qualifyingSessions: number;
	qualifyingCalls: number;
	contactsWithFirstSessionCandidates: number;
	contactsWithLastSessionCandidates: number;
	contactsWithLastCallCandidates: number;
	contactsUpdated: number;
	contactsFailed: number;
}

interface SessionSyncJobState {
	id: string;
	lookbackDays: number;
	mode: Mode;
	dryRun: boolean;
	nowUnix: number;
	sinceUnix: number;
	status: JobStatus;
	phase: JobPhase;
	createdAtMs: number;
	updatedAtMs: number;
	error?: string;

	conversationsStartingAfter?: string;
	contactIds: string[];
	contactIndex: number;
	summary?: SessionSyncSummary;

	conversationPagesFetched: number;
	totalConversations: number;
	duplicateConversationsSkipped: number;
	qualifyingSessions: number;
	qualifyingCalls: number;
	contactsUpdated: number;
	contactsFailed: number;

	processedConversationIds: Set<string>;
	firstSessionByContact: Map<string, number>;
	lastSessionByContact: Map<string, number>;
	lastCallByContact: Map<string, number>;
}

function makeJobId() {
	return `session-sync-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function cleanExpiredJobs(nowMs: number) {
	for (const [id, job] of jobs.entries()) {
		if (nowMs - job.updatedAtMs > JOB_TTL_MS) {
			log.info('job_expired', { jobId: id, ageMs: nowMs - job.updatedAtMs });
			jobs.delete(id);
		}
	}
}

function parseLookbackDays(raw: unknown): number {
	const parsed = Number(raw ?? 30);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error('lookbackDays must be a positive number');
	}
	return Math.min(Math.floor(parsed), MAX_LOOKBACK_DAYS);
}

function parseMode(raw: unknown): Mode {
	const mode = String(raw ?? 'all') as Mode;
	if (mode === 'all' || mode === 'first-only' || mode === 'last-and-call-only') return mode;
	throw new Error('mode must be one of: all, first-only, last-and-call-only');
}

async function intercomRequestWithDeadline(path: string, init: RequestInit, deadlineMs: number) {
	return intercomRequest(path, init, {
		deadlineMs,
		maxRetries: 3,
		slowThresholdMs: 5_000
	});
}

function createJob(lookbackDaysRaw: unknown, modeRaw: unknown, dryRunRaw: unknown): SessionSyncJobState {
	const lookbackDays = parseLookbackDays(lookbackDaysRaw);
	const mode = parseMode(modeRaw);
	const dryRun = typeof dryRunRaw === 'boolean' ? dryRunRaw : true;
	const nowUnix = Math.floor(Date.now() / 1000);
	const nowMs = Date.now();

	const job: SessionSyncJobState = {
		id: makeJobId(),
		lookbackDays,
		mode,
		dryRun,
		nowUnix,
		sinceUnix: nowUnix - lookbackDays * SECONDS_PER_DAY,
		status: 'queued',
		phase: 'conversations',
		createdAtMs: nowMs,
		updatedAtMs: nowMs,

		contactIds: [],
		contactIndex: 0,
		conversationPagesFetched: 0,
		totalConversations: 0,
		duplicateConversationsSkipped: 0,
		qualifyingSessions: 0,
		qualifyingCalls: 0,
		contactsUpdated: 0,
		contactsFailed: 0,
		processedConversationIds: new Set<string>(),
		firstSessionByContact: new Map<string, number>(),
		lastSessionByContact: new Map<string, number>(),
		lastCallByContact: new Map<string, number>()
	};

	jobs.set(job.id, job);
	log.info('job_create', {
		jobId: job.id,
		lookbackDays: job.lookbackDays,
		mode: job.mode,
		dryRun: job.dryRun,
		sinceUnix: job.sinceUnix
	});

	return job;
}

function toUnix(raw: unknown): number | null {
	if (typeof raw === 'number' && Number.isFinite(raw)) return Math.floor(raw);
	if (typeof raw === 'string') {
		const parsed = Number(raw);
		if (Number.isFinite(parsed)) return Math.floor(parsed);
	}
	return null;
}

async function fetchConversationsPage(
	job: SessionSyncJobState,
	deadlineMs: number
): Promise<{ conversations: any[]; nextCursor?: string }> {
	const body: any = {
		query: {
			field: 'updated_at',
			operator: '>',
			value: job.sinceUnix
		},
		pagination: {
			per_page: INTERCOM_MAX_PER_PAGE
		}
	};

	if (job.conversationsStartingAfter) {
		body.pagination.starting_after = job.conversationsStartingAfter;
	}

	const data = await intercomRequestWithDeadline(
		'/conversations/search',
		{
			method: 'POST',
			body: JSON.stringify(body)
		},
		deadlineMs
	);

	const conversations = data.conversations ?? data.data ?? [];
	const nextCursor: string | undefined = data.pages?.next?.starting_after;
	return { conversations, nextCursor };
}

function processConversationsPage(job: SessionSyncJobState, conversations: any[]) {
	for (const conv of conversations) {
		const conversationId = conv?.id != null ? String(conv.id) : '';
		if (conversationId) {
			if (job.processedConversationIds.has(conversationId)) {
				job.duplicateConversationsSkipped += 1;
				continue;
			}
			job.processedConversationIds.add(conversationId);
		}

		const attrs = conv.custom_attributes ?? {};
		const channel = attrs[CHANNEL_ATTR_KEY];
		const serviceCode = attrs[SERVICE_CODE_ATTR_KEY];
		const state = conv.state;

		const contactsList = conv.contacts?.contacts ?? conv.contacts?.data ?? [];
		const firstContactId = contactsList?.[0]?.id;
		if (firstContactId == null) continue;
		const contactId = String(firstContactId);

		const stats = conv.statistics ?? {};
		const convTime =
			toUnix(stats.last_close_at) ??
			toUnix(stats.last_admin_reply_at) ??
			toUnix(conv.updated_at) ??
			toUnix(conv.created_at);
		if (convTime == null) continue;

		// Last Call (Phone channel, any state).
		if ((job.mode === 'all' || job.mode === 'last-and-call-only') && channel === CHANNEL_PHONE) {
			job.qualifyingCalls += 1;
			const existingCall = job.lastCallByContact.get(contactId);
			if (!existingCall || convTime > existingCall) {
				job.lastCallByContact.set(contactId, convTime);
			}
		}

		// Coaching sessions (Phone/Video + service code + closed).
		const isQualifyingSession =
			(job.mode === 'all' || job.mode === 'first-only' || job.mode === 'last-and-call-only') &&
			CALL_CHANNELS.includes(channel) &&
			SERVICE_CODE_ALLOWED.includes(serviceCode) &&
			state === 'closed';
		if (!isQualifyingSession) continue;

		job.qualifyingSessions += 1;

		const existingFirst = job.firstSessionByContact.get(contactId);
		if (!existingFirst || convTime < existingFirst) {
			job.firstSessionByContact.set(contactId, convTime);
		}

		const existingLast = job.lastSessionByContact.get(contactId);
		if (!existingLast || convTime > existingLast) {
			job.lastSessionByContact.set(contactId, convTime);
		}
	}
}

function ensureContactIds(job: SessionSyncJobState) {
	if (job.contactIds.length > 0 || job.phase === 'contacts' || job.phase === 'finalize') return;

	const ids = new Set<string>();
	if (job.mode === 'all' || job.mode === 'first-only') {
		for (const id of job.firstSessionByContact.keys()) ids.add(id);
	}
	if (job.mode === 'all' || job.mode === 'last-and-call-only') {
		for (const id of job.lastSessionByContact.keys()) ids.add(id);
		for (const id of job.lastCallByContact.keys()) ids.add(id);
	}

	job.contactIds = Array.from(ids);
	job.contactIndex = 0;
}

function buildContactPayload(job: SessionSyncJobState, contactId: string, existingAttrs: Record<string, any>) {
	const payload: Record<string, any> = {};

	// First Session Date
	if (job.mode === 'all' || job.mode === 'first-only') {
		const newFirstUnix = job.firstSessionByContact.get(contactId);
		if (newFirstUnix) {
			const existingFirstUnix = existingAttrs[ATTR_FIRST_SESSION];
			let desiredFirst = newFirstUnix;
			if (typeof existingFirstUnix === 'number' && Number.isFinite(existingFirstUnix)) {
				desiredFirst = Math.min(existingFirstUnix, newFirstUnix);
			}

			if (existingFirstUnix == null || desiredFirst !== existingFirstUnix) {
				payload[ATTR_FIRST_SESSION] = desiredFirst;
			}
		}
	}

	// Last Coaching Session
	if (job.mode === 'all' || job.mode === 'last-and-call-only') {
		const newLastUnix = job.lastSessionByContact.get(contactId);
		if (newLastUnix) {
			const existingLastUnix = existingAttrs[ATTR_LAST_SESSION];
			let desiredLast = newLastUnix;
			if (typeof existingLastUnix === 'number' && Number.isFinite(existingLastUnix)) {
				desiredLast = Math.max(existingLastUnix, newLastUnix);
			}

			if (existingLastUnix == null || desiredLast !== existingLastUnix) {
				payload[ATTR_LAST_SESSION] = desiredLast;
			}
		}

		// Last Call
		const newLastCallUnix = job.lastCallByContact.get(contactId);
		if (newLastCallUnix) {
			const existingLastCallUnix = existingAttrs[ATTR_LAST_CALL];
			let desiredLastCall = newLastCallUnix;
			if (typeof existingLastCallUnix === 'number' && Number.isFinite(existingLastCallUnix)) {
				desiredLastCall = Math.max(existingLastCallUnix, newLastCallUnix);
			}

			if (existingLastCallUnix == null || desiredLastCall !== existingLastCallUnix) {
				payload[ATTR_LAST_CALL] = desiredLastCall;
			}
		}
	}

	return payload;
}

async function processContact(job: SessionSyncJobState, contactId: string, deadlineMs: number): Promise<void> {
	try {
		const contact = await intercomRequestWithDeadline(`/contacts/${contactId}`, {}, deadlineMs);
		const existingAttrs = contact.custom_attributes ?? {};
		const payload = buildContactPayload(job, contactId, existingAttrs);

		if (Object.keys(payload).length === 0) return;

		if (job.dryRun) {
			log.debug('contact_update_dry_run', { jobId: job.id, contactId });
		} else {
			await intercomRequestWithDeadline(
				`/contacts/${contactId}`,
				{
					method: 'PUT',
					body: JSON.stringify({ custom_attributes: payload })
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

function finalizeJob(job: SessionSyncJobState) {
	ensureContactIds(job);
	job.summary = {
		lookbackDays: job.lookbackDays,
		mode: job.mode,
		dryRun: job.dryRun,
		totalConversations: job.totalConversations,
		qualifyingSessions: job.qualifyingSessions,
		qualifyingCalls: job.qualifyingCalls,
		contactsWithFirstSessionCandidates: job.firstSessionByContact.size,
		contactsWithLastSessionCandidates: job.lastSessionByContact.size,
		contactsWithLastCallCandidates: job.lastCallByContact.size,
		contactsUpdated: job.contactsUpdated,
		contactsFailed: job.contactsFailed
	};
	job.phase = 'complete';
	job.status = 'complete';
}

function buildProgress(job: SessionSyncJobState) {
	const contactsCandidateCount = job.contactIds.length > 0 ? job.contactIds.length : null;
	return {
		conversationPagesFetched: job.conversationPagesFetched,
		totalConversations: job.totalConversations,
		duplicateConversationsSkipped: job.duplicateConversationsSkipped,
		qualifyingSessions: job.qualifyingSessions,
		qualifyingCalls: job.qualifyingCalls,
		contactsCandidateCount,
		contactsProcessed: job.contactIndex,
		contactsUpdated: job.contactsUpdated,
		contactsFailed: job.contactsFailed,
		contactsRemaining:
			contactsCandidateCount == null ? null : Math.max(0, contactsCandidateCount - job.contactIndex)
	};
}

function buildStatusPayload(job: SessionSyncJobState) {
	return {
		jobId: job.id,
		status: job.status,
		phase: job.phase,
		done: job.status === 'complete' || job.status === 'error' || job.status === 'cancelled',
		lookbackDays: job.lookbackDays,
		mode: job.mode,
		dryRun: job.dryRun,
		sinceUnix: job.sinceUnix,
		progress: buildProgress(job),
		error: job.error ?? null,
		updatedAt: new Date(job.updatedAtMs).toISOString()
	};
}

async function stepJob(job: SessionSyncJobState): Promise<any> {
	const stepStart = Date.now();
	const deadlineMs = stepStart + STEP_BUDGET_MS - STEP_SAFETY_MS;

	job.status = 'running';
	job.updatedAtMs = Date.now();

	try {
		if (job.phase === 'conversations') {
			while (timeLeftMs(deadlineMs) >= MIN_TIME_TO_START_REQUEST_MS) {
				const { conversations, nextCursor } = await fetchConversationsPage(job, deadlineMs);
				job.conversationPagesFetched += 1;
				job.totalConversations += conversations.length;
				processConversationsPage(job, conversations);
				job.conversationsStartingAfter = nextCursor;

				if (!nextCursor) {
					ensureContactIds(job);
					job.phase = 'contacts';
					log.info('phase_advance', {
						jobId: job.id,
						to: 'contacts',
						contactsCandidateCount: job.contactIds.length
					});
					break;
				}

				// Safety break to avoid cursor loops.
				if (conversations.length === 0 && nextCursor) break;
			}
		}

		if (job.phase === 'contacts') {
			while (
				timeLeftMs(deadlineMs) >= MIN_TIME_TO_START_REQUEST_MS &&
				job.contactIndex < job.contactIds.length
			) {
				const contactId = job.contactIds[job.contactIndex];
				await processContact(job, contactId, deadlineMs);
				job.contactIndex += 1;
			}

			if (job.contactIndex >= job.contactIds.length) {
				job.phase = 'finalize';
			}
		}

		if (job.phase === 'finalize') {
			finalizeJob(job);
			log.info('job_complete', {
				jobId: job.id,
				totalConversations: job.totalConversations,
				qualifyingSessions: job.qualifyingSessions,
				qualifyingCalls: job.qualifyingCalls,
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
	job: SessionSyncJobState,
	opts: { maxSteps?: number; stepDelayMs?: number } = {}
): Promise<SessionSyncSummary> {
	const maxSteps = Math.max(1, Math.floor(opts.maxSteps ?? 500));
	const stepDelayMs = Math.max(0, Math.floor(opts.stepDelayMs ?? 0));

	try {
		for (let i = 0; i < maxSteps; i += 1) {
			const status = await stepJob(job);
			if (!status) throw new Error(`Job not found: ${job.id}`);

			if (status.status === 'error') {
				throw new Error(String(status.error ?? 'session-sync job failed'));
			}

			if (status.status === 'cancelled') {
				throw new Error('session-sync job cancelled');
			}

			if (status.done || status.status === 'complete' || status.phase === 'complete') {
				if (!job.summary) throw new Error('session-sync job completed without summary payload');
				return job.summary;
			}

			if (stepDelayMs > 0) {
				await new Promise((resolve) => setTimeout(resolve, stepDelayMs));
			}
		}

		throw new Error(`session-sync job exceeded max steps (${maxSteps})`);
	} finally {
		jobs.delete(job.id);
	}
}

export const POST: RequestHandler = async ({ request }) => {
	cleanExpiredJobs(Date.now());

	let body: SessionSyncRequest = {};
	try {
		body = (await request.json()) as SessionSyncRequest;
	} catch {
		body = {};
	}

	const hasExplicitOp = body?.op != null && String(body.op).trim().length > 0;
	if (!hasExplicitOp) {
		try {
			const job = createJob(body.lookbackDays, body.mode, body.dryRun);
			const summary = await runJobToCompletion(job);
			return new Response(JSON.stringify(summary), {
				headers: { 'Content-Type': 'application/json' }
			});
		} catch (e: any) {
			log.error('sync_failed', { message: e?.message ?? String(e) });
			return new Response(
				JSON.stringify({
					error: 'Intercom session-sync failed',
					details: e?.message ?? String(e)
				}),
				{ status: 500, headers: { 'Content-Type': 'application/json' } }
			);
		}
	}

	const op = String(body.op ?? 'create');

	if (op === 'create') {
		try {
			const job = createJob(body.lookbackDays, body.mode, body.dryRun);
			return new Response(JSON.stringify(buildStatusPayload(job)), {
				headers: { 'Content-Type': 'application/json' }
			});
		} catch (e: any) {
			return new Response(JSON.stringify({ error: e?.message ?? String(e) }), {
				status: 400,
				headers: { 'Content-Type': 'application/json' }
			});
		}
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
