import type { RequestHandler } from '@sveltejs/kit';
import {
	fetchContactsByIds,
	INTERCOM_MAX_PER_PAGE,
	intercomRequest
} from '$lib/server/intercom-provider';
import { isQualifyingCoachingSession } from '$lib/server/engagement-rules';
import { INTERCOM_ATTR_CHANNEL, INTERCOM_ATTR_SERVICE_CODE } from '$lib/server/intercom-attrs';
import {
	isAbortError,
	JOB_TTL_MS,
	MIN_TIME_TO_START_REQUEST_MS,
	STEP_BUDGET_MS,
	STEP_SAFETY_MS,
	timeLeftMs
} from '$lib/server/job-runtime';
import { createReportLogger } from '$lib/server/report-logger';
import {
	SD_EMPLOYER_ATTR_KEY,
	SD_PROGRAM_ATTR_KEY,
	isExcludedEmployer,
	parseDateInputToUnixEndExclusive,
	parseDateInputToUnixStart,
	parseStringListField,
	toIsoDateLabel
} from '$lib/server/sd-report-utils';

const CONVERSATIONS_PER_PAGE = Math.min(100, INTERCOM_MAX_PER_PAGE);
const DETAIL_FETCH_CONCURRENCY = 6;
const CONTACT_BATCH_SIZE = 50;
const CONTACT_FETCH_CONCURRENCY = 6;
const log = createReportLogger('sd-coaching-activity');

type JobStatus = 'queued' | 'running' | 'complete' | 'error' | 'cancelled';
type JobPhase = 'conversations' | 'details' | 'contacts' | 'admins' | 'finalize' | 'complete';

type AuthorEntry = {
	createdAt: number;
	authorType: string;
	authorId: string | null;
};

type ConversationSeed = {
	conversationId: string;
	createdAt: number;
	channel: string | null;
	serviceCode: string | null;
	state: string | null;
	adminAssigneeId: string | null;
	contactId: string | null;
};

type CoachingRow = {
	conversationId: string;
	createdAt: number;
	createdDate: string;
	memberId: string | null;
	memberName: string | null;
	memberEmail: string | null;
	programs: string[];
	employer: string | null;
	channel: string | null;
	serviceCode: string | null;
	coachId: string | null;
	coachName: string | null;
	directionality: 'Unidirectional' | 'Bidirectional' | 'Other';
	state: string | null;
};

type CoachingReport = {
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
	rows: CoachingRow[];
};

type CoachingJobState = {
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
	detailIndex: number;
	detailsById: Map<string, any>;
	contactIds: string[];
	contactsById: Map<string, any>;
	contactBatchIndex: number;
	adminMap: Map<string, { id: string; name: string | null; email: string | null }>;
	report?: CoachingReport;
};

const jobs = new Map<string, CoachingJobState>();

function makeJobId() {
	return `sd-coaching-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function cleanExpiredJobs(nowMs: number) {
	for (const [id, job] of jobs.entries()) {
		if (nowMs - job.updatedAtMs > JOB_TTL_MS) {
			jobs.delete(id);
			log.info('job_expired', { jobId: id, ageMs: nowMs - job.updatedAtMs });
		}
	}
}

function normalizeDateInput(raw: unknown): string | null {
	const text = String(raw ?? '').trim();
	if (!text) return null;
	if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
	return text;
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
	if (id == null) return null;
	return String(id);
}

function collectAuthorEntries(conv: any): AuthorEntry[] {
	const entries: AuthorEntry[] = [];

	if (conv?.source?.author?.type && conv?.source?.created_at) {
		entries.push({
			createdAt: Number(conv.source.created_at) || 0,
			authorType: String(conv.source.author.type),
			authorId: conv.source.author?.id != null ? String(conv.source.author.id) : null
		});
	}

	if (conv?.conversation_message?.author?.type && conv?.conversation_message?.created_at) {
		entries.push({
			createdAt: Number(conv.conversation_message.created_at) || 0,
			authorType: String(conv.conversation_message.author.type),
			authorId:
				conv.conversation_message.author?.id != null
					? String(conv.conversation_message.author.id)
					: null
		});
	}

	const partsContainer = conv?.conversation_parts;
	const parts =
		partsContainer?.conversation_parts ??
		partsContainer?.data ??
		(Array.isArray(partsContainer) ? partsContainer : []);

	if (Array.isArray(parts)) {
		for (const part of parts) {
			if (!part?.author?.type || !part?.created_at) continue;
			entries.push({
				createdAt: Number(part.created_at) || 0,
				authorType: String(part.author.type),
				authorId: part.author?.id != null ? String(part.author.id) : null
			});
		}
	}

	return entries.filter((entry) => Number.isFinite(entry.createdAt) && entry.createdAt > 0);
}

function hasAuthorType(entries: AuthorEntry[], targetType: string): boolean {
	const target = targetType.toLowerCase();
	return entries.some((entry) => String(entry.authorType).toLowerCase() === target);
}

function getLastAdminId(entries: AuthorEntry[]): string | null {
	let best: AuthorEntry | null = null;
	for (const entry of entries) {
		if (String(entry.authorType).toLowerCase() !== 'admin') continue;
		if (!entry.authorId) continue;
		if (!best || entry.createdAt > best.createdAt) best = entry;
	}
	return best?.authorId ?? null;
}

function computeDirectionality(
	entries: AuthorEntry[],
	channel: string | null,
	serviceCode: string | null
): 'Unidirectional' | 'Bidirectional' | 'Other' {
	const hasContact = hasAuthorType(entries, 'contact');
	const hasAdmin = hasAuthorType(entries, 'admin');

	if ((hasContact && hasAdmin) || isQualifyingCoachingSession(channel, serviceCode)) {
		return 'Bidirectional';
	}

	if (hasAdmin && !hasContact) {
		return 'Unidirectional';
	}

	return 'Other';
}

async function fetchConversationsPage(
	job: CoachingJobState,
	startingAfter: string | undefined,
	deadlineMs: number
): Promise<{ conversations: any[]; nextCursor?: string }> {
	const body: any = {
		query: {
			operator: 'AND',
			value: [
				{ field: 'state', operator: '=', value: 'closed' },
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

function processConversationsPage(job: CoachingJobState, conversations: any[]) {
	for (const conv of conversations) {
		const conversationId = conv?.id != null ? String(conv.id) : '';
		if (!conversationId) continue;

		const attrs = conv?.custom_attributes ?? {};
		const createdAt = Number(conv?.created_at ?? 0) || 0;
		if (!Number.isFinite(createdAt) || createdAt <= 0) continue;

		job.conversations.push({
			conversationId,
			createdAt,
			channel: attrs?.[INTERCOM_ATTR_CHANNEL] != null ? String(attrs[INTERCOM_ATTR_CHANNEL]) : null,
			serviceCode:
				attrs?.[INTERCOM_ATTR_SERVICE_CODE] != null
					? String(attrs[INTERCOM_ATTR_SERVICE_CODE])
					: null,
			state: conv?.state != null ? String(conv.state) : null,
			adminAssigneeId: conv?.admin_assignee_id != null ? String(conv.admin_assignee_id) : null,
			contactId: getPrimaryContactId(conv)
		});
	}
	job.conversationsFetched += conversations.length;
}

async function fetchConversationDetail(conversationId: string, deadlineMs: number): Promise<any | null> {
	try {
		return await intercomRequestWithDeadline(
			`/conversations/${conversationId}`,
			{ method: 'GET' },
			deadlineMs
		);
	} catch {
		// Offline fixture mode does not currently mock this endpoint.
		return null;
	}
}

async function hydrateConversationDetails(job: CoachingJobState, deadlineMs: number) {
	if (job.detailIndex >= job.conversations.length) {
		job.phase = 'contacts';
		return;
	}

	const slice = job.conversations.slice(job.detailIndex, job.detailIndex + DETAIL_FETCH_CONCURRENCY);
	const details = await Promise.all(
		slice.map((item) => fetchConversationDetail(item.conversationId, deadlineMs))
	);

	for (let i = 0; i < slice.length; i += 1) {
		const item = slice[i];
		const detail = details[i];
		if (detail) {
			job.detailsById.set(item.conversationId, detail);
		}
	}

	job.detailIndex += slice.length;
	if (job.detailIndex >= job.conversations.length) {
		const contactIdSet = new Set<string>();
		for (const conv of job.conversations) {
			const detail = job.detailsById.get(conv.conversationId);
			const contactId = getPrimaryContactId(detail) ?? conv.contactId;
			if (contactId) contactIdSet.add(contactId);
		}
		job.contactIds = [...contactIdSet];
		job.contactBatchIndex = 0;
		job.phase = 'contacts';
	}
}

async function hydrateContacts(job: CoachingJobState, deadlineMs: number) {
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

async function fetchAdmins(job: CoachingJobState, deadlineMs: number) {
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

function contactEmail(contact: any): string | null {
	if (typeof contact?.email === 'string' && contact.email.trim()) return contact.email.trim();
	if (Array.isArray(contact?.emails) && contact.emails.length > 0) {
		const value = contact.emails[0]?.value;
		if (typeof value === 'string' && value.trim()) return value.trim();
	}
	return null;
}

function finalize(job: CoachingJobState) {
	const rows: CoachingRow[] = [];
	let minCreatedAt: number | null = null;
	let maxCreatedAt: number | null = null;

	for (const conversation of job.conversations) {
		const detail = job.detailsById.get(conversation.conversationId);
		const source = detail ?? conversation;
		const contactId = getPrimaryContactId(source) ?? conversation.contactId;
		const contact = contactId ? job.contactsById.get(contactId) : null;
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

		const programs = parseStringListField(attrs?.[SD_PROGRAM_ATTR_KEY]);
		const entries = collectAuthorEntries(source);
		const channel = conversation.channel;
		const serviceCode = conversation.serviceCode;
		const directionality = computeDirectionality(entries, channel, serviceCode);
		const lastAdminId = getLastAdminId(entries) ?? conversation.adminAssigneeId;
		const coachName = lastAdminId ? (job.adminMap.get(lastAdminId)?.name ?? lastAdminId) : null;

		const row: CoachingRow = {
			conversationId: conversation.conversationId,
			createdAt: conversation.createdAt,
			createdDate: toIsoDateLabel(conversation.createdAt),
			memberId: contactId ?? null,
			memberName: contact?.name != null ? String(contact.name) : null,
			memberEmail: contactEmail(contact),
			programs,
			employer,
			channel,
			serviceCode,
			coachId: lastAdminId,
			coachName,
			directionality,
			state: conversation.state
		};
		rows.push(row);

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

function buildStatusPayload(job: CoachingJobState) {
	return {
		jobId: job.id,
		status: job.status,
		phase: job.phase,
		done: job.status === 'complete' || job.status === 'error' || job.status === 'cancelled',
		startDate: job.startDate,
		endDate: job.endDate,
		progress: {
			conversationPagesFetched: job.conversationPagesFetched,
			conversationsFetched: job.conversationsFetched,
			uniqueConversationSeeds: job.conversations.length,
			detailsLoaded: job.detailsById.size,
			contactIds: job.contactIds.length,
			contactsLoaded: job.contactsById.size,
			adminsLoaded: job.adminMap.size
		},
		error: job.error ?? null,
		updatedAt: new Date(job.updatedAtMs).toISOString()
	};
}

async function stepJob(job: CoachingJobState) {
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
					job.phase = 'details';
					break;
				}
				if (conversations.length === 0 && nextCursor) break;
			}
		}

		if (job.phase === 'details') {
			while (timeLeftMs(deadlineMs) >= MIN_TIME_TO_START_REQUEST_MS && job.phase === 'details') {
				await hydrateConversationDetails(job, deadlineMs);
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
		log.error('job_error', { jobId: job.id, message: job.error });
		return buildStatusPayload(job);
	}
}

function createJob(startDate: string, endDate: string): CoachingJobState {
	const nowMs = Date.now();
	const startUnix = parseDateInputToUnixStart(startDate);
	const endUnixExclusive = parseDateInputToUnixEndExclusive(endDate);
	if (startUnix == null || endUnixExclusive == null || startUnix >= endUnixExclusive) {
		throw new Error('Invalid date range. Select a valid start and end date.');
	}

	const job: CoachingJobState = {
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
		detailIndex: 0,
		detailsById: new Map(),
		contactIds: [],
		contactsById: new Map(),
		contactBatchIndex: 0,
		adminMap: new Map()
	};
	jobs.set(job.id, job);
	log.info('job_create', { jobId: job.id, startDate, endDate });
	return job;
}

function paginateRows(rows: CoachingRow[], offsetRaw: unknown, limitRaw: unknown) {
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
			const progress = await stepJob(job);
			return new Response(JSON.stringify(progress), {
				headers: { 'Content-Type': 'application/json' }
			});
		}

		if (op === 'cancel') {
			const jobId = String(body?.jobId ?? '');
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
			JSON.stringify({
				error: 'Unknown op',
				details: 'Supported ops: create, step, cancel, cleanup'
			}),
			{ status: 400, headers: { 'Content-Type': 'application/json' } }
		);
	} catch (err: any) {
		return new Response(
			JSON.stringify({
				error: 'sd coaching activity request failed',
				details: err?.message ?? String(err)
			}),
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
		return new Response(JSON.stringify({ error: 'Job not found', jobId }), {
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
			JSON.stringify({
				error: 'Job not complete',
				status: job.status,
				phase: job.phase
			}),
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
		JSON.stringify({
			error: 'Unknown view',
			details: 'Supported views: summary, rows, report'
		}),
		{ status: 400, headers: { 'Content-Type': 'application/json' } }
	);
};
