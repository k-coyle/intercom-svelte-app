import { INTERCOM_MAX_PER_PAGE, intercomRequest } from '$lib/server/intercom';
import {
	INTERCOM_ATTR_CHANNEL,
	INTERCOM_ATTR_EMPLOYER,
	INTERCOM_ATTR_ENROLLED_DATE
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
const DEFAULT_LOOKBACK_DAYS = 365;
const MAX_LOOKBACK_DAYS = 365;

const PARTICIPANTS_PER_PAGE = INTERCOM_MAX_PER_PAGE;
const CONVERSATIONS_PER_PAGE = Math.min(100, INTERCOM_MAX_PER_PAGE);
const CONTACT_CHUNK_SIZE = 15;

const PARTICIPANT_DATE_ATTR_KEY = INTERCOM_ATTR_ENROLLED_DATE;
const CLIENT_ATTR_KEY = INTERCOM_ATTR_EMPLOYER;
const CHANNEL_ATTR_KEY = INTERCOM_ATTR_CHANNEL;

const SESSION_CHANNELS = ['Phone', 'Video Conference', 'Email', 'Chat'] as const;
type SessionChannel = (typeof SESSION_CHANNELS)[number];

export interface ParticipantBuckets {
	gt_14_to_21: boolean;
	gt_21_to_28: boolean;
	gt_28: boolean;
}

export interface ParticipantRow {
	memberId: string;
	memberName: string | null;
	memberEmail: string | null;
	client: string | null;
	participantAt: number | null;
	daysSinceParticipant: number | null;
	hasSession: boolean;
	firstSessionAt: number | null;
	lastSessionAt: number | null;
	daysSinceLastSession: number | null;
	coachIds: string[];
	coachNames: string[];
	channelsUsed: SessionChannel[];
	daysWithoutSession: number | null;
	buckets: ParticipantBuckets;
}

export interface NewParticipantsSummary {
	gt_14_to_21: number;
	gt_21_to_28: number;
	gt_28: number;
}

export interface NewParticipantsReport {
	generatedAt: string;
	lookbackDays: number;
	totalParticipants: number;
	summary: NewParticipantsSummary;
	participants: ParticipantRow[];
}

type JobStatus = 'queued' | 'running' | 'complete' | 'error' | 'cancelled';
type JobPhase = 'participants' | 'conversations' | 'admins' | 'finalize' | 'complete';

type ParticipantSeed = {
	memberId: string;
	memberName: string | null;
	memberEmail: string | null;
	client: string | null;
	participantAt: number | null;
	daysSinceParticipant: number | null;
};

type SessionAgg = {
	firstSessionAt: number | null;
	lastSessionAt: number | null;
	coachIds: Set<string>;
	channels: Set<SessionChannel>;
};

type JobState = {
	id: string;
	lookbackDays: number;
	nowUnix: number;
	sinceUnix: number;
	status: JobStatus;
	phase: JobPhase;
	createdAtMs: number;
	updatedAtMs: number;
	error?: string;
	participantsStartingAfter?: string;
	conversationsStartingAfter?: string;
	conversationChunkIndex: number;
	participantPagesFetched: number;
	participantsFetched: number;
	conversationPagesFetched: number;
	conversationsFetched: number;
	conversationsProcessed: number;
	participantsById: Map<string, ParticipantSeed>;
	participantIds: string[];
	sessionsByMember: Map<string, SessionAgg>;
	processedConversationIds: Set<string>;
	adminMap: Map<string, { name: string; email: string | null }>;
	report?: NewParticipantsReport;
};

const jobs = new Map<string, JobState>();

function parseLookbackDays(raw: unknown): number {
	const parsed = Number(raw ?? DEFAULT_LOOKBACK_DAYS);
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LOOKBACK_DAYS;
	return Math.min(MAX_LOOKBACK_DAYS, Math.max(1, Math.floor(parsed)));
}

function makeJobId() {
	return `new-participants-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeValue(v: any): string {
	return String(v ?? '')
		.trim()
		.toLowerCase();
}

function toUnixOrNull(raw: any): number | null {
	if (typeof raw === 'number' && Number.isFinite(raw)) return Math.floor(raw);
	if (typeof raw === 'string') {
		const asNumber = Number(raw);
		if (Number.isFinite(asNumber)) return Math.floor(asNumber);
		const parsed = Date.parse(raw);
		if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
	}
	return null;
}

function contactEmail(contact: any): string | null {
	if (typeof contact?.email === 'string' && contact.email.trim()) return contact.email;
	if (Array.isArray(contact?.emails) && contact.emails.length > 0) {
		const value = contact.emails[0]?.value;
		if (typeof value === 'string' && value.trim()) return value;
	}
	return null;
}

function classifyBuckets(daysWithoutSession: number | null): ParticipantBuckets {
	if (daysWithoutSession == null) {
		return { gt_14_to_21: false, gt_21_to_28: false, gt_28: false };
	}

	if (daysWithoutSession > 28) {
		return { gt_14_to_21: false, gt_21_to_28: false, gt_28: true };
	}

	if (daysWithoutSession > 21) {
		return { gt_14_to_21: false, gt_21_to_28: true, gt_28: false };
	}

	if (daysWithoutSession > 14) {
		return { gt_14_to_21: true, gt_21_to_28: false, gt_28: false };
	}

	return { gt_14_to_21: false, gt_21_to_28: false, gt_28: false };
}

function getProgress(job: JobState) {
	const totalChunks =
		job.participantIds.length === 0 ? 0 : Math.ceil(job.participantIds.length / CONTACT_CHUNK_SIZE);

	return {
		participantPagesFetched: job.participantPagesFetched,
		participantsFetched: job.participantsFetched,
		participantsInScope: job.participantsById.size,
		conversationPagesFetched: job.conversationPagesFetched,
		conversationsFetched: job.conversationsFetched,
		conversationsProcessed: job.conversationsProcessed,
		conversationChunksTotal: totalChunks,
		conversationChunkIndex: job.conversationChunkIndex,
		membersWithSessions: job.sessionsByMember.size
	};
}

function buildStatusPayload(job: JobState) {
	return {
		jobId: job.id,
		status: job.status,
		phase: job.phase,
		done: job.status === 'complete' || job.status === 'error' || job.status === 'cancelled',
		lookbackDays: job.lookbackDays,
		sinceUnix: job.sinceUnix,
		progress: getProgress(job),
		error: job.error ?? null,
		updatedAt: new Date(job.updatedAtMs).toISOString()
	};
}

function cleanExpiredJobs(nowMs: number) {
	for (const [id, job] of jobs.entries()) {
		if (nowMs - job.updatedAtMs > JOB_TTL_MS) {
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

async function fetchParticipantsPage(job: JobState, deadlineMs: number) {
	const body: any = {
		query: {
			operator: 'AND',
			value: [
				{ field: 'role', operator: '=', value: 'user' },
				{
					field: `custom_attributes.${PARTICIPANT_DATE_ATTR_KEY}`,
					operator: '>',
					value: job.sinceUnix
				}
			]
		},
		pagination: {
			per_page: PARTICIPANTS_PER_PAGE
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

	const contacts = data.data ?? data.contacts ?? [];
	const nextCursor: string | undefined = data.pages?.next?.starting_after;
	return { contacts, nextCursor };
}

function processParticipantsPage(job: JobState, contacts: any[]) {
	for (const contact of contacts) {
		const memberId = contact?.id != null ? String(contact.id) : '';
		if (!memberId) continue;

		const attrs = contact.custom_attributes ?? {};
		const participantAt = toUnixOrNull(attrs[PARTICIPANT_DATE_ATTR_KEY]);
		if (participantAt == null || participantAt <= job.sinceUnix) continue;

		const employer = attrs[CLIENT_ATTR_KEY];
		const client =
			typeof employer === 'string' ? employer : employer != null ? String(employer) : null;

		job.participantsById.set(memberId, {
			memberId,
			memberName: (contact.name as string) ?? (contact.external_id as string) ?? null,
			memberEmail: contactEmail(contact),
			client,
			participantAt,
			daysSinceParticipant: (job.nowUnix - participantAt) / SECONDS_PER_DAY
		});
	}
}

async function fetchConversationsPage(job: JobState, deadlineMs: number, chunkIds: string[]) {
	const body: any = {
		query: {
			operator: 'AND',
			value: [
				{ field: 'state', operator: '=', value: 'closed' },
				{ field: 'updated_at', operator: '>', value: job.sinceUnix },
				{ field: 'contact_ids', operator: 'IN', value: chunkIds }
			]
		},
		pagination: {
			per_page: CONVERSATIONS_PER_PAGE
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

function processConversationsPage(job: JobState, conversations: any[]) {
	for (const conv of conversations) {
		try {
			const conversationId = conv?.id != null ? String(conv.id) : null;
			if (conversationId && job.processedConversationIds.has(conversationId)) continue;
			if (conversationId) job.processedConversationIds.add(conversationId);

			const attrs = conv.custom_attributes ?? {};
			const channelValue = String(attrs[CHANNEL_ATTR_KEY] ?? '');
			const normalizedChannel = normalizeValue(channelValue);
			const channel = SESSION_CHANNELS.find((c) => normalizeValue(c) === normalizedChannel);
			if (!channel) continue;

			const stats = conv.statistics ?? {};
			const sessionTime: number | null =
				toUnixOrNull(stats.last_close_at) ??
				toUnixOrNull(stats.last_admin_reply_at) ??
				toUnixOrNull(conv.updated_at) ??
				toUnixOrNull(conv.created_at);
			if (sessionTime == null) continue;

			const teammates = Array.isArray(conv.teammates) ? conv.teammates : [];
			const adminAssigneeId =
				conv.admin_assignee_id != null ? String(conv.admin_assignee_id) : null;
			const fallbackTeammateId = teammates[0]?.id != null ? String(teammates[0].id) : null;
			const coachId = adminAssigneeId ?? fallbackTeammateId;

			const contactsList =
				conv.contacts?.contacts ??
				conv.contacts?.data ??
				(Array.isArray(conv.contacts) ? conv.contacts : []);
			if (!Array.isArray(contactsList) || contactsList.length === 0) continue;

			for (const c of contactsList) {
				const memberId = c?.id != null ? String(c.id) : '';
				if (!memberId || !job.participantsById.has(memberId)) continue;

				let agg = job.sessionsByMember.get(memberId);
				if (!agg) {
					agg = {
						firstSessionAt: null,
						lastSessionAt: null,
						coachIds: new Set<string>(),
						channels: new Set<SessionChannel>()
					};
					job.sessionsByMember.set(memberId, agg);
				}

				if (agg.firstSessionAt == null || sessionTime < agg.firstSessionAt) {
					agg.firstSessionAt = sessionTime;
				}
				if (agg.lastSessionAt == null || sessionTime > agg.lastSessionAt) {
					agg.lastSessionAt = sessionTime;
				}
				if (coachId) agg.coachIds.add(coachId);
				agg.channels.add(channel);

				job.conversationsProcessed += 1;
			}
		} catch {
			// Skip malformed conversation payloads.
		}
	}
}

async function fetchAdminMap(
	deadlineMs: number
): Promise<Map<string, { name: string; email: string | null }>> {
	const map = new Map<string, { name: string; email: string | null }>();

	try {
		const data = await intercomRequestWithDeadline('/admins', { method: 'GET' }, deadlineMs);
		const admins = data.admins ?? data.data ?? [];
		for (const a of admins) {
			const id = a?.id != null ? String(a.id) : '';
			if (!id) continue;
			map.set(id, {
				name: (a.name as string) ?? id,
				email: (a.email as string) ?? null
			});
		}
	} catch {
		// Admin map is best effort; report can still complete using raw IDs.
	}

	return map;
}

function finalize(job: JobState) {
	const participants: ParticipantRow[] = [];
	const summary: NewParticipantsSummary = {
		gt_14_to_21: 0,
		gt_21_to_28: 0,
		gt_28: 0
	};
	const nowUnix = Math.floor(Date.now() / 1000);

	for (const seed of job.participantsById.values()) {
		const agg = job.sessionsByMember.get(seed.memberId);
		const hasSession = Boolean(agg);
		const firstSessionAt = agg?.firstSessionAt ?? null;
		const lastSessionAt = agg?.lastSessionAt ?? null;
		const daysSinceLastSession =
			lastSessionAt != null ? (nowUnix - lastSessionAt) / SECONDS_PER_DAY : null;
		const daysWithoutSession =
			daysSinceLastSession != null ? daysSinceLastSession : seed.daysSinceParticipant;
		const buckets = classifyBuckets(daysWithoutSession);

		const coachIds = agg ? Array.from(agg.coachIds).sort() : [];
		const coachNames = coachIds.map((id) => job.adminMap.get(id)?.name ?? id);
		const channelsUsed = agg ? Array.from(agg.channels).sort() : [];

		if (buckets.gt_14_to_21) summary.gt_14_to_21 += 1;
		if (buckets.gt_21_to_28) summary.gt_21_to_28 += 1;
		if (buckets.gt_28) summary.gt_28 += 1;

		participants.push({
			memberId: seed.memberId,
			memberName: seed.memberName,
			memberEmail: seed.memberEmail,
			client: seed.client,
			participantAt: seed.participantAt,
			daysSinceParticipant: seed.daysSinceParticipant,
			hasSession,
			firstSessionAt,
			lastSessionAt,
			daysSinceLastSession,
			coachIds,
			coachNames,
			channelsUsed,
			daysWithoutSession,
			buckets
		});
	}

	job.report = {
		generatedAt: new Date().toISOString(),
		lookbackDays: job.lookbackDays,
		totalParticipants: participants.length,
		summary,
		participants
	};

	job.status = 'complete';
	job.phase = 'complete';
}

async function stepJob(job: JobState) {
	const stepStart = Date.now();
	const deadlineMs = stepStart + STEP_BUDGET_MS - STEP_SAFETY_MS;

	job.status = 'running';
	job.updatedAtMs = Date.now();

	try {
		if (job.phase === 'participants') {
			while (timeLeftMs(deadlineMs) >= MIN_TIME_TO_START_REQUEST_MS) {
				const { contacts, nextCursor } = await fetchParticipantsPage(job, deadlineMs);
				job.participantPagesFetched += 1;
				job.participantsFetched += contacts.length;
				processParticipantsPage(job, contacts);
				job.participantsStartingAfter = nextCursor;

				if (!nextCursor) {
					job.participantIds = Array.from(job.participantsById.keys());
					job.phase = 'conversations';
					break;
				}

				if (contacts.length === 0 && nextCursor) break;
			}
		}

		if (job.phase === 'conversations') {
			if (job.participantIds.length === 0) {
				job.phase = 'admins';
			}

			while (
				job.phase === 'conversations' &&
				timeLeftMs(deadlineMs) >= MIN_TIME_TO_START_REQUEST_MS
			) {
				const start = job.conversationChunkIndex * CONTACT_CHUNK_SIZE;
				const chunkIds = job.participantIds.slice(start, start + CONTACT_CHUNK_SIZE);

				if (chunkIds.length === 0) {
					job.phase = 'admins';
					break;
				}

				const { conversations, nextCursor } = await fetchConversationsPage(
					job,
					deadlineMs,
					chunkIds
				);
				job.conversationPagesFetched += 1;
				job.conversationsFetched += conversations.length;
				processConversationsPage(job, conversations);
				job.conversationsStartingAfter = nextCursor;

				if (!nextCursor) {
					job.conversationChunkIndex += 1;
					job.conversationsStartingAfter = undefined;
				}

				if (conversations.length === 0 && nextCursor) break;
			}

			const totalChunks =
				job.participantIds.length === 0
					? 0
					: Math.ceil(job.participantIds.length / CONTACT_CHUNK_SIZE);
			if (job.phase === 'conversations' && job.conversationChunkIndex >= totalChunks) {
				job.phase = 'admins';
			}
		}

		if (job.phase === 'admins') {
			if (timeLeftMs(deadlineMs) >= MIN_TIME_TO_START_REQUEST_MS) {
				job.adminMap = await fetchAdminMap(deadlineMs);
				job.phase = 'finalize';
			}
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
		return buildStatusPayload(job);
	}
}

export function createNewParticipantsJob(lookbackDaysRaw: unknown) {
	cleanExpiredJobs(Date.now());

	const lookbackDays = parseLookbackDays(lookbackDaysRaw);
	const nowUnix = Math.floor(Date.now() / 1000);
	const nowMs = Date.now();

	const job: JobState = {
		id: makeJobId(),
		lookbackDays,
		nowUnix,
		sinceUnix: nowUnix - lookbackDays * SECONDS_PER_DAY,
		status: 'queued',
		phase: 'participants',
		createdAtMs: nowMs,
		updatedAtMs: nowMs,
		conversationChunkIndex: 0,
		participantPagesFetched: 0,
		participantsFetched: 0,
		conversationPagesFetched: 0,
		conversationsFetched: 0,
		conversationsProcessed: 0,
		participantsById: new Map(),
		participantIds: [],
		sessionsByMember: new Map(),
		processedConversationIds: new Set(),
		adminMap: new Map()
	};

	jobs.set(job.id, job);
	return buildStatusPayload(job);
}

export async function stepNewParticipantsJob(jobId: string) {
	cleanExpiredJobs(Date.now());
	const job = jobs.get(jobId);
	if (!job) return null;

	if (job.status === 'complete' || job.status === 'error' || job.status === 'cancelled') {
		return buildStatusPayload(job);
	}

	return stepJob(job);
}

export function cancelNewParticipantsJob(jobId: string) {
	const job = jobs.get(jobId);
	if (!job) return null;
	job.status = 'cancelled';
	job.phase = 'complete';
	job.updatedAtMs = Date.now();
	return buildStatusPayload(job);
}

export function cleanupNewParticipantsJob(jobId: string) {
	return jobs.delete(jobId);
}

export function getNewParticipantsJobStatus(jobId: string) {
	cleanExpiredJobs(Date.now());
	const job = jobs.get(jobId);
	if (!job) return null;
	return buildStatusPayload(job);
}

export function getNewParticipantsJobSummary(jobId: string) {
	const job = jobs.get(jobId);
	if (!job || !job.report) return null;
	return {
		generatedAt: job.report.generatedAt,
		lookbackDays: job.report.lookbackDays,
		totalParticipants: job.report.totalParticipants,
		summary: job.report.summary
	};
}

export function getNewParticipantsJobReport(jobId: string) {
	const job = jobs.get(jobId);
	if (!job || !job.report) return null;
	return job.report;
}

export function getNewParticipantsJobParticipants(jobId: string, offset: number, limit: number) {
	const job = jobs.get(jobId);
	if (!job || !job.report) return null;

	const safeOffset = Math.max(0, Math.floor(offset));
	const safeLimit = Math.min(5000, Math.max(1, Math.floor(limit)));
	const items = job.report.participants.slice(safeOffset, safeOffset + safeLimit);
	const nextOffset =
		safeOffset + safeLimit < job.report.participants.length ? safeOffset + safeLimit : null;

	return {
		items,
		nextOffset,
		total: job.report.participants.length
	};
}
