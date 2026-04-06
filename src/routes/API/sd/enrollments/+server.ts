import type { RequestHandler } from '@sveltejs/kit';
import { INTERCOM_MAX_PER_PAGE, intercomRequest } from '$lib/server/intercom-provider';
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
	SD_ENROLLED_DATE_ATTR_KEY,
	SD_EXCLUDED_EMPLOYERS,
	SD_PROGRAM_ATTR_KEY,
	SD_REGISTRATION_DATE_ATTR_KEY,
	isExcludedEmployer,
	parseDateInputToUnixEndExclusive,
	parseDateInputToUnixStart,
	parseStringListField,
	toIsoDateLabel,
	toUnixOrNull
} from '$lib/server/sd-report-utils';

const CONTACTS_PER_PAGE = INTERCOM_MAX_PER_PAGE;
const MAX_LOOKBACK_DAYS = 3650;
const log = createReportLogger('sd-enrollments');

type JobStatus = 'queued' | 'running' | 'complete' | 'error' | 'cancelled';
type JobPhase = 'registration-contacts' | 'enrolled-contacts' | 'finalize' | 'complete';

type EnrollmentRow = {
	memberId: string;
	memberName: string | null;
	memberEmail: string | null;
	employer: string | null;
	programs: string[];
	registrationAt: number | null;
	enrolledAt: number | null;
	enrollmentAt: number | null;
	enrollmentDate: string | null;
};

type EnrollmentReport = {
	generatedAt: string;
	startUnix: number;
	endUnixExclusive: number;
	startDate: string;
	endDate: string;
	totalRows: number;
	dateBounds: {
		minEnrollmentDate: string | null;
		maxEnrollmentDate: string | null;
	};
	rows: EnrollmentRow[];
};

type EnrollmentJobState = {
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
	registrationStartingAfter?: string;
	enrolledStartingAfter?: string;
	registrationPagesFetched: number;
	enrolledPagesFetched: number;
	contactsFetched: number;
	contactsById: Map<string, any>;
	report?: EnrollmentReport;
};

const jobs = new Map<string, EnrollmentJobState>();

function makeJobId() {
	return `sd-enrollments-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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

function contactEmail(contact: any): string | null {
	if (typeof contact?.email === 'string' && contact.email.trim()) return contact.email.trim();
	if (Array.isArray(contact?.emails) && contact.emails.length > 0) {
		const value = contact.emails[0]?.value;
		if (typeof value === 'string' && value.trim()) return value.trim();
	}
	return null;
}

function coerceLookbackSafe(startUnix: number, endUnixExclusive: number): boolean {
	const days = (endUnixExclusive - startUnix) / (24 * 60 * 60);
	return Number.isFinite(days) && days > 0 && days <= MAX_LOOKBACK_DAYS;
}

async function intercomRequestWithDeadline(path: string, init: RequestInit, deadlineMs: number) {
	return intercomRequest(path, init, {
		deadlineMs,
		maxRetries: 3,
		slowThresholdMs: 5_000
	});
}

async function fetchContactsPage(
	job: EnrollmentJobState,
	attrKey: string,
	startingAfter: string | undefined,
	deadlineMs: number
): Promise<{ contacts: any[]; nextCursor?: string }> {
	const body: any = {
		query: {
			operator: 'AND',
			value: [
				{ field: 'role', operator: '=', value: 'user' },
				{
					field: `custom_attributes.${SD_EMPLOYER_ATTR_KEY}`,
					operator: 'NIN',
					value: [...SD_EXCLUDED_EMPLOYERS]
				},
				{
					field: `custom_attributes.${attrKey}`,
					operator: '>',
					value: 0
				},
				{
					field: `custom_attributes.${attrKey}`,
					operator: '<',
					value: job.endUnixExclusive
				}
			]
		},
		pagination: {
			per_page: CONTACTS_PER_PAGE
		}
	};

	if (startingAfter) body.pagination.starting_after = startingAfter;

	const data = await intercomRequestWithDeadline(
		'/contacts/search',
		{
			method: 'POST',
			body: JSON.stringify(body)
		},
		deadlineMs
	);

	return {
		contacts: data.data ?? data.contacts ?? [],
		nextCursor: data.pages?.next?.starting_after
	};
}

function processContactsPage(job: EnrollmentJobState, contacts: any[]) {
	for (const contact of contacts) {
		const memberId = contact?.id != null ? String(contact.id) : '';
		if (!memberId) continue;
		job.contactsById.set(memberId, contact);
	}
	job.contactsFetched += contacts.length;
}

function buildStatusPayload(job: EnrollmentJobState) {
	return {
		jobId: job.id,
		status: job.status,
		phase: job.phase,
		done: job.status === 'complete' || job.status === 'error' || job.status === 'cancelled',
		startDate: job.startDate,
		endDate: job.endDate,
		progress: {
			registrationPagesFetched: job.registrationPagesFetched,
			enrolledPagesFetched: job.enrolledPagesFetched,
			contactsFetched: job.contactsFetched,
			dedupedContacts: job.contactsById.size
		},
		error: job.error ?? null,
		updatedAt: new Date(job.updatedAtMs).toISOString()
	};
}

function finalize(job: EnrollmentJobState) {
	const rows: EnrollmentRow[] = [];
	let minEnrollmentAt: number | null = null;
	let maxEnrollmentAt: number | null = null;

	for (const [memberId, contact] of job.contactsById.entries()) {
		const attrs = contact?.custom_attributes ?? {};
		const registrationAt = toUnixOrNull(attrs?.[SD_REGISTRATION_DATE_ATTR_KEY]);
		const enrolledAt = toUnixOrNull(attrs?.[SD_ENROLLED_DATE_ATTR_KEY]);
		const enrollmentCandidates = [registrationAt, enrolledAt].filter(
			(value): value is number => value != null && Number.isFinite(value)
		);
		if (enrollmentCandidates.length === 0) continue;
		const enrollmentAt = Math.min(...enrollmentCandidates);
		if (enrollmentAt >= job.endUnixExclusive) continue;

		const employerRaw = attrs?.[SD_EMPLOYER_ATTR_KEY];
		const employer =
			typeof employerRaw === 'string'
				? employerRaw
				: employerRaw != null
					? String(employerRaw)
					: null;
		if (isExcludedEmployer(employer)) continue;

		const programs = parseStringListField(attrs?.[SD_PROGRAM_ATTR_KEY]);
		const row: EnrollmentRow = {
			memberId,
			memberName: (contact?.name as string) ?? null,
			memberEmail: contactEmail(contact),
			employer,
			programs,
			registrationAt,
			enrolledAt,
			enrollmentAt,
			enrollmentDate: toIsoDateLabel(enrollmentAt)
		};
		rows.push(row);

		if (minEnrollmentAt == null || enrollmentAt < minEnrollmentAt) minEnrollmentAt = enrollmentAt;
		if (maxEnrollmentAt == null || enrollmentAt > maxEnrollmentAt) maxEnrollmentAt = enrollmentAt;
	}

	rows.sort((a, b) => {
		const aTime = a.enrollmentAt ?? 0;
		const bTime = b.enrollmentAt ?? 0;
		return bTime - aTime;
	});

	job.report = {
		generatedAt: new Date().toISOString(),
		startUnix: job.startUnix,
		endUnixExclusive: job.endUnixExclusive,
		startDate: job.startDate,
		endDate: job.endDate,
		totalRows: rows.length,
		dateBounds: {
			minEnrollmentDate: minEnrollmentAt != null ? toIsoDateLabel(minEnrollmentAt) : null,
			maxEnrollmentDate: maxEnrollmentAt != null ? toIsoDateLabel(maxEnrollmentAt) : null
		},
		rows
	};
	job.phase = 'complete';
	job.status = 'complete';
}

async function stepJob(job: EnrollmentJobState) {
	const stepStart = Date.now();
	const deadlineMs = stepStart + STEP_BUDGET_MS - STEP_SAFETY_MS;

	job.status = 'running';
	job.updatedAtMs = Date.now();
	try {
		if (job.phase === 'registration-contacts') {
			while (timeLeftMs(deadlineMs) >= MIN_TIME_TO_START_REQUEST_MS) {
				const { contacts, nextCursor } = await fetchContactsPage(
					job,
					SD_REGISTRATION_DATE_ATTR_KEY,
					job.registrationStartingAfter,
					deadlineMs
				);
				job.registrationPagesFetched += 1;
				processContactsPage(job, contacts);
				job.registrationStartingAfter = nextCursor;
				if (!nextCursor) {
					job.phase = 'enrolled-contacts';
					break;
				}
				if (contacts.length === 0 && nextCursor) break;
			}
		}

		if (job.phase === 'enrolled-contacts') {
			while (timeLeftMs(deadlineMs) >= MIN_TIME_TO_START_REQUEST_MS) {
				const { contacts, nextCursor } = await fetchContactsPage(
					job,
					SD_ENROLLED_DATE_ATTR_KEY,
					job.enrolledStartingAfter,
					deadlineMs
				);
				job.enrolledPagesFetched += 1;
				processContactsPage(job, contacts);
				job.enrolledStartingAfter = nextCursor;
				if (!nextCursor) {
					job.phase = 'finalize';
					break;
				}
				if (contacts.length === 0 && nextCursor) break;
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
		log.error('job_error', { jobId: job.id, message: job.error });
		return buildStatusPayload(job);
	}
}

function createJob(startDate: string, endDate: string): EnrollmentJobState {
	const nowMs = Date.now();
	const startUnix = parseDateInputToUnixStart(startDate);
	const endUnixExclusive = parseDateInputToUnixEndExclusive(endDate);
	if (startUnix == null || endUnixExclusive == null || startUnix >= endUnixExclusive) {
		throw new Error('Invalid date range. Select a valid start and end date.');
	}
	if (!coerceLookbackSafe(startUnix, endUnixExclusive)) {
		throw new Error('Date range is too large. Please select a window under 10 years.');
	}

	const job: EnrollmentJobState = {
		id: makeJobId(),
		status: 'queued',
		phase: 'registration-contacts',
		createdAtMs: nowMs,
		updatedAtMs: nowMs,
		startUnix,
		endUnixExclusive,
		startDate,
		endDate,
		registrationPagesFetched: 0,
		enrolledPagesFetched: 0,
		contactsFetched: 0,
		contactsById: new Map()
	};
	jobs.set(job.id, job);
	log.info('job_create', { jobId: job.id, startDate, endDate });
	return job;
}

function paginateRows(rows: EnrollmentRow[], offsetRaw: unknown, limitRaw: unknown) {
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
				log.warn('job_missing', { op: 'step', jobId, jobsSize: jobs.size });
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
				log.warn('job_missing', { op: 'cancel', jobId, jobsSize: jobs.size });
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
				error: 'sd enrollments request failed',
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
		log.warn('job_missing', {
			op: 'get',
			jobId,
			view: url.searchParams.get('view') ?? null,
			jobsSize: jobs.size
		});
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
