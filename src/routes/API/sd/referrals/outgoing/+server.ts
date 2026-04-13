import type { RequestHandler } from '@sveltejs/kit';
import {
	fetchContactsByIds,
	INTERCOM_MAX_PER_PAGE,
	intercomRequest
} from '$lib/server/intercom-provider';
import {
	isAbortError,
	JOB_TTL_MS,
	MIN_TIME_TO_START_REQUEST_MS,
	STEP_BUDGET_MS,
	STEP_SAFETY_MS,
	timeLeftMs
} from '$lib/server/job-runtime';
import { createReportLogger } from '$lib/server/report-logger';
import { getInstanceFingerprint } from '$lib/server/instance-fingerprint';
import {
	isExcludedEmployer,
	parseDateInputToUnixEndExclusive,
	parseDateInputToUnixStart,
	parseStringListField,
	SD_EMPLOYER_ATTR_KEY,
	SD_OUTGOING_REFERRAL_ATTR_KEY,
	SD_OUTGOING_REFERRAL_REASON_ATTR_KEY,
	SD_PROGRAM_ATTR_KEY,
	toIsoDateLabel
} from '$lib/server/sd-report-utils';

const CONVERSATIONS_PER_PAGE = Math.min(100, INTERCOM_MAX_PER_PAGE);
const CONTACT_BATCH_SIZE = 50;
const CONTACT_FETCH_CONCURRENCY = 6;
const log = createReportLogger('sd-outgoing-referrals');
const INSTANCE_ID = getInstanceFingerprint();

type JobStatus = 'queued' | 'running' | 'complete' | 'error' | 'cancelled';
type JobPhase = 'conversations' | 'contacts' | 'admins' | 'finalize' | 'complete';

type ConversationSeed = {
	conversationId: string;
	createdAt: number;
	contactId: string | null;
	adminAssigneeId: string | null;
	outgoingReferral: string | null;
	outgoingReferralReason: string | null;
};

type OutgoingReferralRow = {
	conversationId: string;
	createdAt: number;
	createdDate: string;
	memberId: string | null;
	memberName: string | null;
	memberEmail: string | null;
	programs: string[];
	employer: string | null;
	outgoingReferral: string | null;
	outgoingReferralReason: string | null;
	coachId: string | null;
	coachName: string | null;
};

type OutgoingReferralReport = {
	generatedAt: string;
	startUnix: number;
	endUnixExclusive: number;
	startDate: string;
	endDate: string;
	totalRows: number;
	dateBounds: {
		minCreatedDate: string | null;
		maxCreatedDate: string | null;
	};
	rows: OutgoingReferralRow[];
};

type OutgoingReferralJobState = {
	id: string;
	status: JobStatus;
	phase: JobPhase;
	createdAtMs: number;
	updatedAtMs: number;
	error?: string;
	startUnix: number;
	endUnixExclusive: number;
	startDate: string;
	endDate: string;
	conversationStartingAfter?: string;
	conversationPagesFetched: number;
	conversationsFetched: number;
	conversations: ConversationSeed[];
	contactIds: string[];
	contactsById: Map<string, any>;
	contactBatchIndex: number;
	adminMap: Map<string, { id: string; name: string | null; email: string | null }>;
	report?: OutgoingReferralReport;
};

const jobs = new Map<string, OutgoingReferralJobState>();

function makeJobId() {
	return `sd-outgoing-referrals-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function cleanExpiredJobs(nowMs: number) {
	for (const [id, job] of jobs.entries()) {
		if (nowMs - job.updatedAtMs > JOB_TTL_MS) {
			jobs.delete(id);
			log.info('job_expired', { jobId: id, ageMs: nowMs - job.updatedAtMs, instanceId: INSTANCE_ID });
		}
	}
}

function normalizeDateInput(raw: unknown): string | null {
	const text = String(raw ?? '').trim();
	if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
	return text;
}

function contactEmail(contact: any): string | null {
	if (typeof contact?.email === 'string' && contact.email.trim()) return contact.email.trim();
	if (Array.isArray(contact?.emails) && contact.emails.length > 0) {
		const value = contact.emails[0]?.value;
		if (typeof value === 'string' && value.trim()) return value.trim();
	}
	return null;
}

async function intercomRequestWithDeadline(path: string, init: RequestInit, deadlineMs: number) {
	return intercomRequest(path, init, {
		deadlineMs,
		maxRetries: 3,
		slowThresholdMs: 5_000
	});
}

function getPrimaryContactId(conv: any): string | null {
	const contacts = conv?.contacts?.contacts ?? conv?.contacts?.data ?? conv?.contacts ?? [];
	if (!Array.isArray(contacts) || contacts.length === 0) return null;
	const id = contacts[0]?.id;
	return id != null ? String(id) : null;
}

async function fetchConversationsPage(
	job: OutgoingReferralJobState,
	startingAfter: string | undefined,
	deadlineMs: number
): Promise<{ conversations: any[]; nextCursor?: string }> {
	const body: any = {
		query: {
			operator: 'AND',
			value: [
				{ field: 'created_at', operator: '>', value: job.startUnix - 1 },
				{ field: 'created_at', operator: '<', value: job.endUnixExclusive }
			]
		},
		pagination: {
			per_page: CONVERSATIONS_PER_PAGE
		}
	};
	if (startingAfter) body.pagination.starting_after = startingAfter;

	const data = await intercomRequestWithDeadline(
		'/conversations/search',
		{
			method: 'POST',
			body: JSON.stringify(body)
		},
		deadlineMs
	);

	return {
		conversations: data.conversations ?? data.data ?? [],
		nextCursor: data.pages?.next?.starting_after
	};
}

function processConversationsPage(job: OutgoingReferralJobState, conversations: any[]) {
	for (const conv of conversations) {
		const conversationId = conv?.id != null ? String(conv.id) : '';
		if (!conversationId) continue;
		const createdAt = Number(conv?.created_at ?? 0) || 0;
		if (!Number.isFinite(createdAt) || createdAt <= 0) continue;
		const attrs = conv?.custom_attributes ?? {};
		const outgoingReferral =
			attrs?.[SD_OUTGOING_REFERRAL_ATTR_KEY] != null ? String(attrs[SD_OUTGOING_REFERRAL_ATTR_KEY]).trim() : '';
		if (!outgoingReferral) continue;

		job.conversations.push({
			conversationId,
			createdAt,
			contactId: getPrimaryContactId(conv),
			adminAssigneeId: conv?.admin_assignee_id != null ? String(conv.admin_assignee_id) : null,
			outgoingReferral,
			outgoingReferralReason:
				attrs?.[SD_OUTGOING_REFERRAL_REASON_ATTR_KEY] != null
					? String(attrs[SD_OUTGOING_REFERRAL_REASON_ATTR_KEY]).trim() || null
					: null
		});
	}
	job.conversationsFetched += conversations.length;
}

async function hydrateContacts(job: OutgoingReferralJobState, deadlineMs: number) {
	if (job.contactBatchIndex >= job.contactIds.length) {
		job.phase = 'admins';
		return;
	}
	if (timeLeftMs(deadlineMs) < MIN_TIME_TO_START_REQUEST_MS) return;

	const batch = job.contactIds.slice(job.contactBatchIndex, job.contactBatchIndex + CONTACT_BATCH_SIZE);
	if (batch.length === 0) {
		job.phase = 'admins';
		return;
	}

	const fetched = await fetchContactsByIds(batch, {
		concurrency: CONTACT_FETCH_CONCURRENCY,
		requestOptions: { deadlineMs, maxRetries: 3 }
	});
	for (const [id, contact] of fetched.entries()) {
		job.contactsById.set(id, contact);
	}
	job.contactBatchIndex += batch.length;
	if (job.contactBatchIndex >= job.contactIds.length) {
		job.phase = 'admins';
	}
}

async function fetchAdmins(job: OutgoingReferralJobState, deadlineMs: number) {
	const data = await intercomRequestWithDeadline('/admins', { method: 'GET' }, deadlineMs);
	const admins = data.admins ?? data.data ?? [];
	const map = new Map<string, { id: string; name: string | null; email: string | null }>();
	for (const admin of admins) {
		const id = admin?.id != null ? String(admin.id) : '';
		if (!id) continue;
		map.set(id, {
			id,
			name: admin?.name != null ? String(admin.name) : null,
			email: admin?.email != null ? String(admin.email) : null
		});
	}
	job.adminMap = map;
	job.phase = 'finalize';
}

function finalize(job: OutgoingReferralJobState) {
	const rows: OutgoingReferralRow[] = [];
	let minCreatedAt: number | null = null;
	let maxCreatedAt: number | null = null;

	for (const conversation of job.conversations) {
		const contact = conversation.contactId ? job.contactsById.get(conversation.contactId) : null;
		const role = String(contact?.role ?? '').trim().toLowerCase();
		if (role !== 'user') continue;
		const attrs = contact?.custom_attributes ?? {};

		const employerRaw = attrs?.[SD_EMPLOYER_ATTR_KEY];
		const employer =
			typeof employerRaw === 'string'
				? employerRaw
				: employerRaw != null
					? String(employerRaw)
					: null;
		if (isExcludedEmployer(employer)) continue;

		rows.push({
			conversationId: conversation.conversationId,
			createdAt: conversation.createdAt,
			createdDate: toIsoDateLabel(conversation.createdAt),
			memberId: conversation.contactId,
			memberName: contact?.name != null ? String(contact.name) : null,
			memberEmail: contactEmail(contact),
			programs: parseStringListField(attrs?.[SD_PROGRAM_ATTR_KEY]),
			employer,
			outgoingReferral: conversation.outgoingReferral,
			outgoingReferralReason: conversation.outgoingReferralReason,
			coachId: conversation.adminAssigneeId,
			coachName: conversation.adminAssigneeId
				? (job.adminMap.get(conversation.adminAssigneeId)?.name ?? conversation.adminAssigneeId)
				: null
		});

		if (minCreatedAt == null || conversation.createdAt < minCreatedAt) minCreatedAt = conversation.createdAt;
		if (maxCreatedAt == null || conversation.createdAt > maxCreatedAt) maxCreatedAt = conversation.createdAt;
	}

	rows.sort((a, b) => b.createdAt - a.createdAt);
	job.report = {
		generatedAt: new Date().toISOString(),
		startUnix: job.startUnix,
		endUnixExclusive: job.endUnixExclusive,
		startDate: job.startDate,
		endDate: job.endDate,
		totalRows: rows.length,
		dateBounds: {
			minCreatedDate: minCreatedAt != null ? toIsoDateLabel(minCreatedAt) : null,
			maxCreatedDate: maxCreatedAt != null ? toIsoDateLabel(maxCreatedAt) : null
		},
		rows
	};
	job.phase = 'complete';
	job.status = 'complete';
}

function buildStatusPayload(job: OutgoingReferralJobState) {
	return {
		jobId: job.id,
		instanceId: INSTANCE_ID,
		status: job.status,
		phase: job.phase,
		done: job.status === 'complete' || job.status === 'error' || job.status === 'cancelled',
		startDate: job.startDate,
		endDate: job.endDate,
		progress: {
			conversationPagesFetched: job.conversationPagesFetched,
			conversationsFetched: job.conversationsFetched,
			uniqueConversationSeeds: job.conversations.length,
			contactIds: job.contactIds.length,
			contactsLoaded: job.contactsById.size,
			adminsLoaded: job.adminMap.size
		},
		error: job.error ?? null,
		updatedAt: new Date(job.updatedAtMs).toISOString()
	};
}

async function stepJob(job: OutgoingReferralJobState) {
	const stepStart = Date.now();
	const deadlineMs = stepStart + STEP_BUDGET_MS - STEP_SAFETY_MS;

	job.status = 'running';
	job.updatedAtMs = Date.now();
	try {
		if (job.phase === 'conversations') {
			while (timeLeftMs(deadlineMs) >= MIN_TIME_TO_START_REQUEST_MS) {
				const { conversations, nextCursor } = await fetchConversationsPage(
					job,
					job.conversationStartingAfter,
					deadlineMs
				);
				job.conversationPagesFetched += 1;
				processConversationsPage(job, conversations);
				job.conversationStartingAfter = nextCursor;
				if (!nextCursor) {
					job.contactIds = [
						...new Set(job.conversations.map((conv) => conv.contactId).filter(Boolean) as string[])
					];
					job.contactBatchIndex = 0;
					job.phase = 'contacts';
					break;
				}
				if (conversations.length === 0 && nextCursor) break;
			}
		}

		if (job.phase === 'contacts') {
			while (timeLeftMs(deadlineMs) >= MIN_TIME_TO_START_REQUEST_MS && job.phase === 'contacts') {
				await hydrateContacts(job, deadlineMs);
			}
		}

		if (job.phase === 'admins' && timeLeftMs(deadlineMs) >= MIN_TIME_TO_START_REQUEST_MS) {
			await fetchAdmins(job, deadlineMs);
		}

		if (job.phase === 'finalize') {
			finalize(job);
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
		log.error('job_error', { jobId: job.id, message: job.error, instanceId: INSTANCE_ID });
		return buildStatusPayload(job);
	}
}

function createJob(startDate: string, endDate: string): OutgoingReferralJobState {
	const nowMs = Date.now();
	const startUnix = parseDateInputToUnixStart(startDate);
	const endUnixExclusive = parseDateInputToUnixEndExclusive(endDate);
	if (startUnix == null || endUnixExclusive == null || startUnix >= endUnixExclusive) {
		throw new Error('Invalid date range. Select a valid start and end date.');
	}

	const job: OutgoingReferralJobState = {
		id: makeJobId(),
		status: 'queued',
		phase: 'conversations',
		createdAtMs: nowMs,
		updatedAtMs: nowMs,
		startUnix,
		endUnixExclusive,
		startDate,
		endDate,
		conversationPagesFetched: 0,
		conversationsFetched: 0,
		conversations: [],
		contactIds: [],
		contactsById: new Map(),
		contactBatchIndex: 0,
		adminMap: new Map()
	};
	jobs.set(job.id, job);
	log.info('job_create', { jobId: job.id, startDate, endDate, instanceId: INSTANCE_ID });
	return job;
}

function paginateRows(rows: OutgoingReferralRow[], offsetRaw: unknown, limitRaw: unknown) {
	const offset = Math.max(0, Number(offsetRaw ?? 0) || 0);
	const limit = Math.min(5000, Math.max(1, Number(limitRaw ?? 500) || 500));
	const items = rows.slice(offset, offset + limit);
	const nextOffset = offset + limit < rows.length ? offset + limit : null;
	return { items, nextOffset, total: rows.length };
}

export const POST: RequestHandler = async ({ request }) => {
	cleanExpiredJobs(Date.now());
	let body: any = {};
	try {
		body = await request.json();
	} catch {
		body = {};
	}

	const op = String(body?.op ?? 'create');
	try {
		if (op === 'create') {
			const startDate = normalizeDateInput(body?.startDate);
			const endDate = normalizeDateInput(body?.endDate);
			if (!startDate || !endDate) {
				return new Response(JSON.stringify({ error: 'startDate and endDate are required (YYYY-MM-DD).' }), {
					status: 400,
					headers: { 'Content-Type': 'application/json' }
				});
			}
			const job = createJob(startDate, endDate);
			return new Response(JSON.stringify(buildStatusPayload(job)), {
				headers: { 'Content-Type': 'application/json' }
			});
		}

		if (op === 'step') {
			const jobId = String(body?.jobId ?? '');
			if (!jobId) {
				return new Response(JSON.stringify({ error: 'Missing jobId' }), {
					status: 400,
					headers: { 'Content-Type': 'application/json' }
				});
			}
			const job = jobs.get(jobId);
			if (!job) {
				log.warn('job_missing', { op: 'step', jobId, jobsSize: jobs.size, instanceId: INSTANCE_ID });
				return new Response(JSON.stringify({ error: 'Job not found', jobId, instanceId: INSTANCE_ID }), {
					status: 404,
					headers: { 'Content-Type': 'application/json' }
				});
			}
			if (job.status === 'complete' || job.status === 'error' || job.status === 'cancelled') {
				return new Response(JSON.stringify(buildStatusPayload(job)), {
					headers: { 'Content-Type': 'application/json' }
				});
			}
			const progress = await stepJob(job);
			return new Response(JSON.stringify(progress), {
				headers: { 'Content-Type': 'application/json' }
			});
		}

		if (op === 'cancel') {
			const jobId = String(body?.jobId ?? '');
			const job = jobId ? jobs.get(jobId) : null;
			if (!job) {
				log.warn('job_missing', { op: 'cancel', jobId, jobsSize: jobs.size, instanceId: INSTANCE_ID });
				return new Response(JSON.stringify({ error: 'Job not found', jobId, instanceId: INSTANCE_ID }), {
					status: 404,
					headers: { 'Content-Type': 'application/json' }
				});
			}
			job.status = 'cancelled';
			job.phase = 'complete';
			job.updatedAtMs = Date.now();
			return new Response(JSON.stringify(buildStatusPayload(job)), {
				headers: { 'Content-Type': 'application/json' }
			});
		}

		if (op === 'cleanup') {
			const jobId = String(body?.jobId ?? '');
			if (!jobId) {
				return new Response(JSON.stringify({ error: 'Missing jobId' }), {
					status: 400,
					headers: { 'Content-Type': 'application/json' }
				});
			}
			const deleted = jobs.delete(jobId);
			return new Response(JSON.stringify({ jobId, deleted }), {
				headers: { 'Content-Type': 'application/json' }
			});
		}

		return new Response(
			JSON.stringify({ error: 'Unknown op', details: 'Supported ops: create, step, cancel, cleanup' }),
			{ status: 400, headers: { 'Content-Type': 'application/json' } }
		);
	} catch (err: any) {
		return new Response(
			JSON.stringify({ error: 'sd outgoing referrals request failed', details: err?.message ?? String(err) }),
			{ status: 500, headers: { 'Content-Type': 'application/json' } }
		);
	}
};

export const GET: RequestHandler = async ({ url }) => {
	cleanExpiredJobs(Date.now());
	const jobId = url.searchParams.get('jobId') ?? '';
	if (!jobId) {
		return new Response(
			JSON.stringify({
				error: 'Missing jobId',
				usage: 'GET ?jobId=... (status) or ?jobId=...&view=summary|rows|report&offset=0&limit=500'
			}),
			{ status: 400, headers: { 'Content-Type': 'application/json' } }
		);
	}

	const job = jobs.get(jobId);
	if (!job) {
		log.warn('job_missing', {
			op: 'get',
			jobId,
			view: url.searchParams.get('view') ?? null,
			jobsSize: jobs.size,
			instanceId: INSTANCE_ID
		});
		return new Response(JSON.stringify({ error: 'Job not found', jobId, instanceId: INSTANCE_ID }), {
			status: 404,
			headers: { 'Content-Type': 'application/json' }
		});
	}
	job.updatedAtMs = Date.now();

	const view = url.searchParams.get('view');
	if (!view) {
		return new Response(JSON.stringify(buildStatusPayload(job)), {
			headers: { 'Content-Type': 'application/json' }
		});
	}

	if (job.status !== 'complete' || !job.report) {
		return new Response(
			JSON.stringify({ error: 'Job not complete', status: job.status, phase: job.phase }),
			{ status: 409, headers: { 'Content-Type': 'application/json' } }
		);
	}

	if (view === 'summary') {
		return new Response(
			JSON.stringify({
				generatedAt: job.report.generatedAt,
				startDate: job.report.startDate,
				endDate: job.report.endDate,
				totalRows: job.report.totalRows,
				dateBounds: job.report.dateBounds
			}),
			{ headers: { 'Content-Type': 'application/json' } }
		);
	}

	if (view === 'rows') {
		return new Response(
			JSON.stringify(paginateRows(job.report.rows, url.searchParams.get('offset'), url.searchParams.get('limit'))),
			{ headers: { 'Content-Type': 'application/json' } }
		);
	}

	if (view === 'report') {
		return new Response(JSON.stringify(job.report), {
			headers: { 'Content-Type': 'application/json' }
		});
	}

	return new Response(
		JSON.stringify({ error: 'Unknown view', details: 'Supported views: summary, rows, report' }),
		{ status: 400, headers: { 'Content-Type': 'application/json' } }
	);
};
