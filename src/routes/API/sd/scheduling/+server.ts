import type { RequestHandler } from '@sveltejs/kit';
import { ONCEHUB_API_KEY, ONCEHUB_API_BASE } from '$env/static/private';
import { intercomRequest } from '$lib/server/intercom-provider';
import {
	isAbortError,
	JOB_TTL_MS,
	MIN_TIME_TO_START_REQUEST_MS,
	STEP_BUDGET_MS,
	STEP_SAFETY_MS,
	timeLeftMs
} from '$lib/server/job-runtime';
import { createReportLogger } from '$lib/server/report-logger';
import { resolveOfflineFixturesEnabled } from '$lib/server/sandbox-mode';
import { buildSyntheticOncehubBookings } from '$lib/testing/sd-synthetic-data';
import {
	SD_EMPLOYER_ATTR_KEY,
	SD_EXCLUDED_EMPLOYERS,
	SD_PROGRAM_ATTR_KEY,
	isExcludedEmployer,
	parseDateInputToUnixEndExclusive,
	parseDateInputToUnixStart,
	parseStringListField,
	toIsoDateLabel
} from '$lib/server/sd-report-utils';

const log = createReportLogger('sd-scheduling');
const ONCEHUB_BASE_URL = (ONCEHUB_API_BASE || 'https://api.oncehub.com/v2').replace(/\/+$/, '');
const ONCEHUB_BASE_URL_WITH_SLASH = `${ONCEHUB_BASE_URL}/`;
const ONCEHUB_BASE_PATH_SEGMENT = new URL(ONCEHUB_BASE_URL_WITH_SLASH).pathname.replace(
	/^\/+|\/+$/g,
	''
);
const ONCEHUB_PAGE_LIMIT = 100;
const ONCEHUB_MAX_PAGES = 80;
const CONTACT_LOOKUP_BATCH = 12;

type JobStatus = 'queued' | 'running' | 'complete' | 'error' | 'cancelled';
type JobPhase = 'bookings' | 'contacts' | 'admins' | 'finalize' | 'complete';

type RawBookingSeed = {
	id: string;
	statusRaw: string;
	createdTime: string | null;
	createdUnix: number | null;
	startingTime: string | null;
	startingUnix: number | null;
	attendees: string[];
	owner: string | null;
};

type DateBasis = 'session' | 'created';
type SchedulingStatus = 'scheduled' | 'completed' | 'no_show' | 'rescheduled' | 'canceled';

type SchedulingRow = {
	sessionId: string;
	createdTime: string | null;
	createdUnix: number | null;
	createdDate: string | null;
	startingTime: string;
	startingUnix: number;
	startingDate: string;
	statusRaw: string;
	status: SchedulingStatus;
	memberEmail: string | null;
	memberId: string | null;
	memberName: string | null;
	employer: string | null;
	programs: string[];
	coachEmail: string | null;
	coachId: string | null;
	coachName: string | null;
	owner: string | null;
};

type SchedulingReport = {
	generatedAt: string;
	dateBasis: DateBasis;
	startDate: string;
	endDate: string;
	startUnix: number;
	endUnixExclusive: number;
	totalRows: number;
	dateBounds: {
		minCreatedDate: string | null;
		maxCreatedDate: string | null;
		minStartingDate: string | null;
		maxStartingDate: string | null;
	};
	availableDateBounds: {
		minCreatedDate: string | null;
		maxCreatedDate: string | null;
		minStartingDate: string | null;
		maxStartingDate: string | null;
	};
	statusCounts: Record<string, number>;
	rows: SchedulingRow[];
};

type SchedulingJobState = {
	id: string;
	status: JobStatus;
	phase: JobPhase;
	createdAtMs: number;
	updatedAtMs: number;
	error?: string;
	startUnix: number;
	endUnixExclusive: number;
	dateBasis: DateBasis;
	startDate: string;
	endDate: string;
	offlineMode: boolean;
	oncehubNextUrl: string | null;
	oncehubUseDateFilters: boolean;
	oncehubFilterField: 'starting_time' | 'creation_time';
	oncehubFilterStartIso: string;
	oncehubFilterEndIso: string;
	oncehubPagesFetched: number;
	oncehubRowsFetched: number;
	rawBookings: RawBookingSeed[];
	memberEmails: string[];
	memberEmailIndex: number;
	contactsByMemberEmail: Map<string, any>;
	adminByEmail: Map<string, { id: string; name: string | null; email: string | null }>;
	report?: SchedulingReport;
};

const jobs = new Map<string, SchedulingJobState>();

function makeJobId() {
	return `sd-scheduling-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeDateInput(raw: unknown): string | null {
	const text = String(raw ?? '').trim();
	if (!text) return null;
	if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
	return text;
}

function normalizeDateBasis(raw: unknown): DateBasis {
	const value = lower(raw);
	if (value === 'created') return 'created';
	return 'session';
}

function cleanExpiredJobs(nowMs: number) {
	for (const [id, job] of jobs.entries()) {
		if (nowMs - job.updatedAtMs > JOB_TTL_MS) {
			jobs.delete(id);
			log.info('job_expired', { jobId: id, ageMs: nowMs - job.updatedAtMs });
		}
	}
}

function toUnixOrNull(raw: unknown): number | null {
	if (typeof raw === 'number' && Number.isFinite(raw)) return Math.floor(raw);
	if (typeof raw === 'string') {
		const parsedMs = Date.parse(raw);
		if (!Number.isNaN(parsedMs)) return Math.floor(parsedMs / 1000);
	}
	return null;
}

function lower(value: unknown): string {
	return String(value ?? '')
		.trim()
		.toLowerCase();
}

function normalizeStatus(
	raw: unknown,
	startingUnix: number | null,
	nowUnix = Math.floor(Date.now() / 1000)
): SchedulingStatus {
	const value = lower(raw);
	if (value === 'completed') return 'completed';
	if (value === 'no_show' || value === 'noshow') return 'no_show';
	if (value === 'rescheduled') return 'rescheduled';
	if (value === 'canceled' || value === 'cancelled') return 'canceled';
	if (value === 'expired') return 'no_show';
	if (value === 'requested' || value === 'scheduled') {
		if (startingUnix != null && startingUnix < nowUnix) return 'no_show';
		return 'scheduled';
	}
	if (startingUnix != null && startingUnix < nowUnix) return 'no_show';
	return 'scheduled';
}

function parseLinkHeaderNext(linkHeader: string | null): string | null {
	if (!linkHeader) return null;
	for (const part of linkHeader.split(',')) {
		const match = part.trim().match(/<([^>]+)>;\s*rel="next"/i);
		if (match?.[1]) return match[1];
	}
	return null;
}

function oncehubHeaders(): Record<string, string> {
	if (!ONCEHUB_API_KEY) {
		throw new Error('ONCEHUB_API_KEY is not set');
	}
	return {
		'API-Key': ONCEHUB_API_KEY,
		Accept: 'application/json'
	};
}

function normalizeOncehubRelativePath(pathOrUrl: string): string {
	const raw = pathOrUrl.trim().replace(/^\/+/, '');
	if (!ONCEHUB_BASE_PATH_SEGMENT) return raw;
	if (raw === ONCEHUB_BASE_PATH_SEGMENT) return '';
	if (raw.startsWith(`${ONCEHUB_BASE_PATH_SEGMENT}/`)) {
		return raw.slice(ONCEHUB_BASE_PATH_SEGMENT.length + 1);
	}
	return raw;
}

function absolutizeOncehubUrl(pathOrUrl: string): string {
	if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
	const clean = normalizeOncehubRelativePath(pathOrUrl);
	return new URL(clean, ONCEHUB_BASE_URL_WITH_SLASH).toString();
}

function oncehubFilterFieldForDateBasis(dateBasis: DateBasis): 'starting_time' | 'creation_time' {
	return dateBasis === 'created' ? 'creation_time' : 'starting_time';
}

function toIsoFromUnix(unix: number): string {
	return new Date(unix * 1000).toISOString();
}

function buildInitialOncehubBookingsUrl(job: SchedulingJobState): string {
	const url = new URL('bookings', ONCEHUB_BASE_URL_WITH_SLASH);
	url.searchParams.set('limit', String(ONCEHUB_PAGE_LIMIT));
	if (job.oncehubUseDateFilters) {
		url.searchParams.set(`${job.oncehubFilterField}.gt`, job.oncehubFilterStartIso);
		url.searchParams.set(`${job.oncehubFilterField}.lt`, job.oncehubFilterEndIso);
	}
	return url.toString();
}

function isOncehubDateFilterQueryError(err: unknown, job: SchedulingJobState): boolean {
	if (!job.oncehubUseDateFilters) return false;
	const message = String((err as any)?.message ?? err ?? '').toLowerCase();
	if (!message.includes('oncehub 400')) return false;
	return (
		message.includes(job.oncehubFilterField) ||
		message.includes('.gt') ||
		message.includes('.lt') ||
		message.includes('query') ||
		message.includes('parameter')
	);
}

function bookingMatchesRequestedWindow(booking: RawBookingSeed, job: SchedulingJobState): boolean {
	const basisUnix = job.dateBasis === 'created' ? booking.createdUnix : booking.startingUnix;
	if (basisUnix == null) return false;
	return basisUnix >= job.startUnix && basisUnix < job.endUnixExclusive;
}

async function fetchOncehubPage(urlOrPath: string, deadlineMs: number): Promise<{ rows: any[]; nextUrl: string | null }> {
	const url = absolutizeOncehubUrl(urlOrPath);
	const requestPath = new URL(url).pathname;
	const timeoutMs = Math.max(1500, Math.min(20_000, timeLeftMs(deadlineMs) - 500));
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, {
			method: 'GET',
			headers: oncehubHeaders(),
			signal: controller.signal
		});
		if (!response.ok) {
			const body = await response.text();
			throw new Error(`OnceHub ${response.status} (${requestPath}): ${body.slice(0, 300)}`);
		}
		const payload = await response.json();
		const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
		const nextUrl = parseLinkHeaderNext(response.headers.get('Link'));
		return { rows, nextUrl };
	} finally {
		clearTimeout(timeout);
	}
}

function pickCoachEmail(attendees: string[]): string | null {
	const match = attendees.find((email) => lower(email).endsWith('@uspm.com'));
	return match ?? null;
}

function pickMemberEmail(attendees: string[]): string | null {
	const match = attendees.find((email) => !lower(email).endsWith('@uspm.com'));
	return match ?? null;
}

async function intercomRequestWithDeadline(path: string, init: RequestInit, deadlineMs: number) {
	return intercomRequest(path, init, {
		deadlineMs,
		maxRetries: 3,
		slowThresholdMs: 5_000
	});
}

async function fetchContactByEmail(email: string, deadlineMs: number): Promise<any | null> {
	try {
		const body = {
			query: {
				operator: 'AND',
				value: [
					{ field: 'role', operator: '=', value: 'user' },
					{ field: 'email', operator: '=', value: email },
					{
						field: `custom_attributes.${SD_EMPLOYER_ATTR_KEY}`,
						operator: 'NIN',
						value: [...SD_EXCLUDED_EMPLOYERS]
					}
				]
			},
			pagination: { per_page: 1 }
		};

		const data = await intercomRequestWithDeadline(
			'/contacts/search',
			{
				method: 'POST',
				body: JSON.stringify(body)
			},
			deadlineMs
		);
		const contacts = data.data ?? data.contacts ?? [];
		if (!Array.isArray(contacts) || contacts.length === 0) return null;
		return contacts[0];
	} catch {
		return null;
	}
}

async function fetchAdminsByEmail(deadlineMs: number) {
	const data = await intercomRequestWithDeadline('/admins', { method: 'GET' }, deadlineMs);
	const admins = data.admins ?? data.data ?? [];
	const map = new Map<string, { id: string; name: string | null; email: string | null }>();
	for (const admin of admins) {
		const email = admin?.email != null ? String(admin.email).trim() : '';
		if (!email) continue;
		map.set(lower(email), {
			id: admin?.id != null ? String(admin.id) : '',
			name: admin?.name != null ? String(admin.name) : null,
			email
		});
	}
	return map;
}

function toRawBookingSeed(raw: any): RawBookingSeed | null {
	const id = raw?.id != null ? String(raw.id) : '';
	if (!id) return null;
	const attendees = Array.isArray(raw?.attendees)
		? raw.attendees.map((value: unknown) => String(value ?? '').trim()).filter((value: string) => value.length > 0)
		: [];
	const createdTimeRaw = raw?.created_time ?? raw?.created_at ?? raw?.creation_time ?? raw?.createdAt ?? null;
	const createdTime = createdTimeRaw != null ? String(createdTimeRaw) : null;
	const startingTime = raw?.starting_time != null ? String(raw.starting_time) : null;
	return {
		id,
		statusRaw: raw?.status != null ? String(raw.status) : 'scheduled',
		createdTime,
		createdUnix: toUnixOrNull(createdTime),
		startingTime,
		startingUnix: toUnixOrNull(startingTime),
		attendees,
		owner: raw?.owner != null ? String(raw.owner) : null
	};
}

function buildStatusPayload(job: SchedulingJobState) {
	return {
		jobId: job.id,
		status: job.status,
		phase: job.phase,
		done: job.status === 'complete' || job.status === 'error' || job.status === 'cancelled',
		startDate: job.startDate,
		endDate: job.endDate,
		dateBasis: job.dateBasis,
		offlineMode: job.offlineMode,
		progress: {
			oncehubPagesFetched: job.oncehubPagesFetched,
			oncehubRowsFetched: job.oncehubRowsFetched,
			oncehubUseDateFilters: job.oncehubUseDateFilters,
			oncehubFilterField: job.oncehubFilterField,
			rawBookings: job.rawBookings.length,
			memberEmails: job.memberEmails.length,
			memberEmailIndex: job.memberEmailIndex,
			contactsLoaded: job.contactsByMemberEmail.size,
			adminsLoaded: job.adminByEmail.size
		},
		error: job.error ?? null,
		updatedAt: new Date(job.updatedAtMs).toISOString()
	};
}

function finalize(job: SchedulingJobState) {
	const nowUnix = Math.floor(Date.now() / 1000);
	const allRows: SchedulingRow[] = [];
	let availableMinCreatedAt: number | null = null;
	let availableMaxCreatedAt: number | null = null;
	let availableMinStartingAt: number | null = null;
	let availableMaxStartingAt: number | null = null;
	const statusCounts: Record<string, number> = {};

	for (const booking of job.rawBookings) {
		if (booking.startingUnix == null) continue;

		const coachEmail = pickCoachEmail(booking.attendees);
		const memberEmail = pickMemberEmail(booking.attendees);
		const contact = memberEmail ? job.contactsByMemberEmail.get(lower(memberEmail)) : null;
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
		const status = normalizeStatus(booking.statusRaw, booking.startingUnix, nowUnix);

		const admin = coachEmail ? job.adminByEmail.get(lower(coachEmail)) : null;
		allRows.push({
			sessionId: booking.id,
			createdTime: booking.createdTime,
			createdUnix: booking.createdUnix,
			createdDate: booking.createdUnix != null ? toIsoDateLabel(booking.createdUnix) : null,
			startingTime: booking.startingTime ?? new Date(booking.startingUnix * 1000).toISOString(),
			startingUnix: booking.startingUnix,
			startingDate: toIsoDateLabel(booking.startingUnix),
			statusRaw: booking.statusRaw,
			status,
			memberEmail: memberEmail ?? null,
			memberId: contact?.id != null ? String(contact.id) : null,
			memberName: contact?.name != null ? String(contact.name) : null,
			employer,
			programs,
			coachEmail: coachEmail ?? null,
			coachId: admin?.id ?? null,
			coachName: admin?.name ?? coachEmail ?? null,
			owner: booking.owner
		});

		if (booking.createdUnix != null) {
			if (availableMinCreatedAt == null || booking.createdUnix < availableMinCreatedAt) {
				availableMinCreatedAt = booking.createdUnix;
			}
			if (availableMaxCreatedAt == null || booking.createdUnix > availableMaxCreatedAt) {
				availableMaxCreatedAt = booking.createdUnix;
			}
		}
		if (availableMinStartingAt == null || booking.startingUnix < availableMinStartingAt) {
			availableMinStartingAt = booking.startingUnix;
		}
		if (availableMaxStartingAt == null || booking.startingUnix > availableMaxStartingAt) {
			availableMaxStartingAt = booking.startingUnix;
		}
	}

	const rows = allRows.filter((row) => {
		const basisUnix = job.dateBasis === 'created' ? row.createdUnix : row.startingUnix;
		if (basisUnix == null) return false;
		return basisUnix >= job.startUnix && basisUnix < job.endUnixExclusive;
	});

	let minCreatedAt: number | null = null;
	let maxCreatedAt: number | null = null;
	let minStartingAt: number | null = null;
	let maxStartingAt: number | null = null;
	for (const row of rows) {
		statusCounts[row.status] = (statusCounts[row.status] ?? 0) + 1;
		if (row.createdUnix != null) {
			if (minCreatedAt == null || row.createdUnix < minCreatedAt) minCreatedAt = row.createdUnix;
			if (maxCreatedAt == null || row.createdUnix > maxCreatedAt) maxCreatedAt = row.createdUnix;
		}
		if (minStartingAt == null || row.startingUnix < minStartingAt) minStartingAt = row.startingUnix;
		if (maxStartingAt == null || row.startingUnix > maxStartingAt) maxStartingAt = row.startingUnix;
	}

	rows.sort((a, b) => {
		const aBasis = job.dateBasis === 'created' ? (a.createdUnix ?? a.startingUnix) : a.startingUnix;
		const bBasis = job.dateBasis === 'created' ? (b.createdUnix ?? b.startingUnix) : b.startingUnix;
		return bBasis - aBasis;
	});
	job.report = {
		generatedAt: new Date().toISOString(),
		dateBasis: job.dateBasis,
		startDate: job.startDate,
		endDate: job.endDate,
		startUnix: job.startUnix,
		endUnixExclusive: job.endUnixExclusive,
		totalRows: rows.length,
		dateBounds: {
			minCreatedDate: minCreatedAt != null ? toIsoDateLabel(minCreatedAt) : null,
			maxCreatedDate: maxCreatedAt != null ? toIsoDateLabel(maxCreatedAt) : null,
			minStartingDate: minStartingAt != null ? toIsoDateLabel(minStartingAt) : null,
			maxStartingDate: maxStartingAt != null ? toIsoDateLabel(maxStartingAt) : null
		},
		availableDateBounds: {
			minCreatedDate: availableMinCreatedAt != null ? toIsoDateLabel(availableMinCreatedAt) : null,
			maxCreatedDate: availableMaxCreatedAt != null ? toIsoDateLabel(availableMaxCreatedAt) : null,
			minStartingDate: availableMinStartingAt != null ? toIsoDateLabel(availableMinStartingAt) : null,
			maxStartingDate: availableMaxStartingAt != null ? toIsoDateLabel(availableMaxStartingAt) : null
		},
		statusCounts,
		rows
	};
	job.phase = 'complete';
	job.status = 'complete';
}

async function stepJob(job: SchedulingJobState) {
	const stepStart = Date.now();
	const deadlineMs = stepStart + STEP_BUDGET_MS - STEP_SAFETY_MS;

	job.status = 'running';
	job.updatedAtMs = Date.now();
	try {
		if (job.phase === 'bookings') {
			if (job.offlineMode) {
				job.rawBookings = buildSyntheticOncehubBookings(Math.floor(Date.now() / 1000))
					.map((row) => toRawBookingSeed(row))
					.filter((row): row is RawBookingSeed => Boolean(row))
					.filter((row) => bookingMatchesRequestedWindow(row, job));
				job.oncehubRowsFetched = job.rawBookings.length;
				job.oncehubPagesFetched = 1;
				job.memberEmails = [
					...new Set(
						job.rawBookings
							.map((booking) => pickMemberEmail(booking.attendees))
							.filter((value): value is string => Boolean(value))
							.map((value) => lower(value))
					)
				];
				job.memberEmailIndex = 0;
				job.phase = 'contacts';
			} else {
				while (timeLeftMs(deadlineMs) >= MIN_TIME_TO_START_REQUEST_MS) {
					if (job.oncehubPagesFetched >= ONCEHUB_MAX_PAGES) {
						job.phase = 'contacts';
						break;
					}

					const url = job.oncehubNextUrl ?? buildInitialOncehubBookingsUrl(job);
					let page: { rows: any[]; nextUrl: string | null };
					try {
						page = await fetchOncehubPage(url, deadlineMs);
					} catch (err) {
						if (!job.oncehubNextUrl && isOncehubDateFilterQueryError(err, job)) {
							job.oncehubUseDateFilters = false;
							log.warn('oncehub_date_filter_fallback', {
								jobId: job.id,
								dateBasis: job.dateBasis,
								filterField: job.oncehubFilterField
							});
							continue;
						}
						throw err;
					}
					job.oncehubPagesFetched += 1;
					job.oncehubRowsFetched += page.rows.length;
					for (const raw of page.rows) {
						const mapped = toRawBookingSeed(raw);
						if (mapped && bookingMatchesRequestedWindow(mapped, job)) job.rawBookings.push(mapped);
					}
					job.oncehubNextUrl = page.nextUrl;
					if (!page.nextUrl) {
						job.phase = 'contacts';
						break;
					}
					if (page.rows.length === 0) break;
				}
				if (job.phase === 'contacts' || !job.oncehubNextUrl) {
					job.memberEmails = [
						...new Set(
							job.rawBookings
								.map((booking) => pickMemberEmail(booking.attendees))
								.filter((value): value is string => Boolean(value))
								.map((value) => lower(value))
						)
					];
					job.memberEmailIndex = 0;
					job.phase = 'contacts';
				}
			}
		}

		if (job.phase === 'contacts') {
			while (timeLeftMs(deadlineMs) >= MIN_TIME_TO_START_REQUEST_MS && job.phase === 'contacts') {
				if (job.memberEmailIndex >= job.memberEmails.length) {
					job.phase = 'admins';
					break;
				}

				const batch = job.memberEmails.slice(
					job.memberEmailIndex,
					job.memberEmailIndex + CONTACT_LOOKUP_BATCH
				);
				const contacts = await Promise.all(
					batch.map((email) => fetchContactByEmail(email, deadlineMs))
				);
				for (let i = 0; i < batch.length; i += 1) {
					const email = batch[i];
					const contact = contacts[i];
					if (contact) job.contactsByMemberEmail.set(lower(email), contact);
				}
				job.memberEmailIndex += batch.length;
			}
		}

		if (job.phase === 'admins' && timeLeftMs(deadlineMs) >= MIN_TIME_TO_START_REQUEST_MS) {
			job.adminByEmail = await fetchAdminsByEmail(deadlineMs);
			job.phase = 'finalize';
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

function createJob(
	startDate: string,
	endDate: string,
	dateBasis: DateBasis,
	offlineMode: boolean
): SchedulingJobState {
	const nowMs = Date.now();
	const startUnix = parseDateInputToUnixStart(startDate);
	const endUnixExclusive = parseDateInputToUnixEndExclusive(endDate);
	if (startUnix == null || endUnixExclusive == null || startUnix >= endUnixExclusive) {
		throw new Error('Invalid date range. Select a valid start and end date.');
	}

	const job: SchedulingJobState = {
		id: makeJobId(),
		status: 'queued',
		phase: 'bookings',
		createdAtMs: nowMs,
		updatedAtMs: nowMs,
		startUnix,
		endUnixExclusive,
		dateBasis,
		startDate,
		endDate,
		offlineMode,
		oncehubNextUrl: null,
		oncehubUseDateFilters: true,
		oncehubFilterField: oncehubFilterFieldForDateBasis(dateBasis),
		oncehubFilterStartIso: toIsoFromUnix(Math.max(0, startUnix - 1)),
		oncehubFilterEndIso: toIsoFromUnix(endUnixExclusive),
		oncehubPagesFetched: 0,
		oncehubRowsFetched: 0,
		rawBookings: [],
		memberEmails: [],
		memberEmailIndex: 0,
		contactsByMemberEmail: new Map(),
		adminByEmail: new Map()
	};
	jobs.set(job.id, job);
	log.info('job_create', {
		jobId: job.id,
		startDate,
		endDate,
		dateBasis,
		offlineMode,
		oncehubFilterField: job.oncehubFilterField,
		oncehubFilterStartIso: job.oncehubFilterStartIso,
		oncehubFilterEndIso: job.oncehubFilterEndIso
	});
	return job;
}

function paginateRows(rows: SchedulingRow[], offsetRaw: unknown, limitRaw: unknown) {
	const offset = Math.max(0, Number(offsetRaw ?? 0) || 0);
	const limit = Math.min(5000, Math.max(1, Number(limitRaw ?? 500) || 500));
	const items = rows.slice(offset, offset + limit);
	const nextOffset = offset + limit < rows.length ? offset + limit : null;
	return { items, nextOffset, total: rows.length };
}

export const POST: RequestHandler = async ({ request, cookies }) => {
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
			const dateBasis = normalizeDateBasis(body?.dateBasis);
			if (!startDate || !endDate) {
				return new Response(JSON.stringify({ error: 'startDate and endDate are required (YYYY-MM-DD).' }), {
					status: 400,
					headers: { 'Content-Type': 'application/json' }
				});
			}
			const offlineMode = resolveOfflineFixturesEnabled({ cookies });
			const job = createJob(startDate, endDate, dateBasis, offlineMode);
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
				error: 'sd scheduling request failed',
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
				dateBasis: job.report.dateBasis,
				startDate: job.report.startDate,
				endDate: job.report.endDate,
				totalRows: job.report.totalRows,
				dateBounds: job.report.dateBounds,
				availableDateBounds: job.report.availableDateBounds,
				statusCounts: job.report.statusCounts
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
