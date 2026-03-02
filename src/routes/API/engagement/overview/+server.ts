import type { RequestHandler } from '@sveltejs/kit';
import {
	extractIntercomContacts,
	extractIntercomConversations,
	intercomPaginate,
	intercomRequest
} from '$lib/server/intercom-provider';
import {
	INTERCOM_ATTR_CHANNEL,
	INTERCOM_ATTR_ENROLLED_DATE,
	INTERCOM_ATTR_REGISTRATION_DATE,
	INTERCOM_ATTR_SERVICE_CODE
} from '$lib/server/intercom-attrs';
import {
	REPORT_TIMEZONE,
	computeElapsedEndUnixForMonth,
	computeMonthComparisonWindow
} from '$lib/server/report-time';
import {
	isQualifyingCoachingSession,
	STANDARD_REPORT_SESSION_CHANNELS
} from '$lib/server/engagement-rules';

const SPARKLINE_POINTS = 8;

type KpiValue = {
	count: number;
	priorCount: number;
	deltaCount: number;
	deltaPct: number | null;
	sparkline: number[];
};

type QualifyingSessionRecord = {
	createdAt: number;
	memberId: string;
	serviceCode: string;
};

type RegistrationConversionSnapshot = {
	registeredCount: number;
	withQualifyingSessionCount: number;
	pct: number | null;
};

type ServiceCodeSessionRow = {
	serviceCode: string;
	count: number;
	sharePct: number;
};

type ServiceCodeSessionRecord = {
	serviceCode: string;
};

type MetricConfig = {
	key: 'newRegistrationsMtd' | 'newEnrolleesMtd';
	path: '/contacts/search';
	extractItems: (data: any) => any[];
	buildQuery: (startUnix: number, endUnix: number) => any;
};

function toNumber(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string') {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
}

function parseTotalCount(data: any): number | null {
	const parsed = toNumber(data?.total_count ?? data?.total);
	if (parsed == null) return null;
	return Math.max(0, Math.floor(parsed));
}

async function runCountQuery(
	path: '/contacts/search' | '/conversations/search',
	query: any,
	extractItems: (data: any) => any[]
): Promise<number> {
	const data = await intercomRequest(path, {
		method: 'POST',
		body: JSON.stringify({
			query,
			pagination: {
				per_page: 1
			}
		})
	});

	const total = parseTotalCount(data);
	if (total != null) return total;

	return extractItems(data).length;
}

function computeSparklineDays(elapsedDays: number, points = SPARKLINE_POINTS): number[] {
	if (elapsedDays <= 0) return [0];

	const days = new Set<number>();
	for (let i = 1; i <= points; i += 1) {
		const day = Math.max(1, Math.ceil((i * elapsedDays) / points));
		days.add(day);
	}
	days.add(elapsedDays);

	return Array.from(days).sort((a, b) => a - b);
}

function computeDeltaPct(count: number, priorCount: number): number | null {
	if (priorCount === 0) return count === 0 ? 0 : null;
	const pct = ((count - priorCount) / priorCount) * 100;
	return Number(pct.toFixed(2));
}

function buildContactDateRangeQuery(attrKey: string, startUnix: number, endUnix: number) {
	return {
		operator: 'AND',
		value: [
			{ field: 'role', operator: '=', value: 'user' },
			{ field: `custom_attributes.${attrKey}`, operator: '>', value: startUnix - 1 },
			{ field: `custom_attributes.${attrKey}`, operator: '<', value: endUnix }
		]
	};
}

function buildQualifyingSessionsQuery(startUnix: number, endUnix: number) {
	return {
		operator: 'AND',
		value: [
			{ field: 'created_at', operator: '>', value: startUnix - 1 },
			{ field: 'created_at', operator: '<', value: endUnix }
		]
	};
}

function isQualifyingSession(conversation: any): boolean {
	const attrs = conversation?.custom_attributes ?? {};
	return isQualifyingCoachingSession(
		attrs[INTERCOM_ATTR_CHANNEL],
		attrs[INTERCOM_ATTR_SERVICE_CODE]
	);
}

function normalizeText(value: unknown): string {
	return String(value ?? '')
		.trim()
		.toLowerCase()
		.replace(/[_-]+/g, ' ')
		.replace(/\s+/g, ' ');
}

const NORMALIZED_SESSION_CHANNELS = new Set(
	STANDARD_REPORT_SESSION_CHANNELS.map((channel) => normalizeText(channel))
);

function isStandardSessionChannel(channel: unknown): boolean {
	return NORMALIZED_SESSION_CHANNELS.has(normalizeText(channel));
}

function normalizeServiceCode(value: unknown): string {
	const normalized = String(value ?? '').trim();
	return normalized.length > 0 ? normalized : 'Unspecified';
}

async function fetchQualifyingSessions(
	startUnix: number,
	endUnix: number
): Promise<QualifyingSessionRecord[]> {
	const conversations = await intercomPaginate<any>({
		path: '/conversations/search',
		body: {
			query: buildQualifyingSessionsQuery(startUnix, endUnix)
		},
		extractItems: extractIntercomConversations
	});

	const sessions: QualifyingSessionRecord[] = [];
	const seenConversationIds = new Set<string>();
	for (const conversation of conversations) {
		const conversationId = conversation?.id != null ? String(conversation.id) : '';
		if (conversationId) {
			if (seenConversationIds.has(conversationId)) continue;
			seenConversationIds.add(conversationId);
		}

		if (!isQualifyingSession(conversation)) continue;

		const createdAt = toNumber(conversation?.created_at);
		if (createdAt == null) continue;
		if (createdAt < startUnix || createdAt >= endUnix) continue;

		const memberId = String(
			conversation?.contacts?.contacts?.[0]?.id ?? conversation?.contacts?.data?.[0]?.id ?? ''
		);
		if (!memberId) continue;

		sessions.push({
			createdAt: Math.floor(createdAt),
			memberId,
			serviceCode: normalizeServiceCode(
				conversation?.custom_attributes?.[INTERCOM_ATTR_SERVICE_CODE]
			)
		});
	}

	sessions.sort((a, b) => a.createdAt - b.createdAt);
	return sessions;
}

async function fetchAllChannelSessionsByServiceCode(
	startUnix: number,
	endUnix: number
): Promise<ServiceCodeSessionRecord[]> {
	const conversations = await intercomPaginate<any>({
		path: '/conversations/search',
		body: {
			query: buildQualifyingSessionsQuery(startUnix, endUnix)
		},
		extractItems: extractIntercomConversations
	});

	const sessions: ServiceCodeSessionRecord[] = [];
	const seenConversationIds = new Set<string>();
	for (const conversation of conversations) {
		const conversationId = conversation?.id != null ? String(conversation.id) : '';
		if (conversationId) {
			if (seenConversationIds.has(conversationId)) continue;
			seenConversationIds.add(conversationId);
		}

		if (String(conversation?.state ?? '').toLowerCase() !== 'closed') continue;

		const createdAt = toNumber(conversation?.created_at);
		if (createdAt == null) continue;
		if (createdAt < startUnix || createdAt >= endUnix) continue;

		const channel = conversation?.custom_attributes?.[INTERCOM_ATTR_CHANNEL];
		if (!isStandardSessionChannel(channel)) continue;

		sessions.push({
			serviceCode: normalizeServiceCode(
				conversation?.custom_attributes?.[INTERCOM_ATTR_SERVICE_CODE]
			)
		});
	}

	return sessions;
}

async function fetchContactIdsByDateRange(
	attrKey: string,
	startUnix: number,
	endUnix: number
): Promise<Set<string>> {
	const contacts = await intercomPaginate<any>({
		path: '/contacts/search',
		body: {
			query: buildContactDateRangeQuery(attrKey, startUnix, endUnix)
		},
		extractItems: extractIntercomContacts
	});

	const ids = new Set<string>();
	for (const contact of contacts) {
		if (contact?.role && String(contact.role) !== 'user') continue;
		const id = String(contact?.id ?? '');
		if (!id) continue;
		ids.add(id);
	}
	return ids;
}

function countTimestampsBefore(sortedTimestamps: number[], endUnix: number): number {
	let lo = 0;
	let hi = sortedTimestamps.length;

	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (sortedTimestamps[mid] < endUnix) lo = mid + 1;
		else hi = mid;
	}

	return lo;
}

async function computeMetric(
	config: MetricConfig,
	comparison: ReturnType<typeof computeMonthComparisonWindow>
): Promise<KpiValue> {
	const sparklineDays = computeSparklineDays(comparison.current.elapsedDays, SPARKLINE_POINTS);
	const sparkline: number[] = [];

	for (const day of sparklineDays) {
		const pointEndUnix = computeElapsedEndUnixForMonth(
			comparison.current.month,
			day,
			comparison.timeZone
		);
		const count = await runCountQuery(
			config.path,
			config.buildQuery(comparison.current.month.monthStartUnix, pointEndUnix),
			config.extractItems
		);
		sparkline.push(count);
	}

	const count = sparkline[sparkline.length - 1] ?? 0;
	const priorCount = await runCountQuery(
		config.path,
		config.buildQuery(comparison.prior.month.monthStartUnix, comparison.prior.elapsedEndUnix),
		config.extractItems
	);

	return {
		count,
		priorCount,
		deltaCount: count - priorCount,
		deltaPct: computeDeltaPct(count, priorCount),
		sparkline
	};
}

function computeSessionMetric(
	comparison: ReturnType<typeof computeMonthComparisonWindow>,
	currentSessionTimestamps: number[],
	priorSessionTimestamps: number[]
): KpiValue {
	const sparklineDays = computeSparklineDays(comparison.current.elapsedDays, SPARKLINE_POINTS);
	const sparkline = sparklineDays.map((day) => {
		const pointEndUnix = computeElapsedEndUnixForMonth(
			comparison.current.month,
			day,
			comparison.timeZone
		);
		return countTimestampsBefore(currentSessionTimestamps, pointEndUnix);
	});

	const count = currentSessionTimestamps.length;
	const priorCount = priorSessionTimestamps.length;

	return {
		count,
		priorCount,
		deltaCount: count - priorCount,
		deltaPct: computeDeltaPct(count, priorCount),
		sparkline
	};
}

function computeRegistrationConversionSnapshot(
	registeredIds: Set<string>,
	sessions: QualifyingSessionRecord[]
): RegistrationConversionSnapshot {
	const memberIdsWithSessions = new Set<string>(sessions.map((session) => session.memberId));
	let withQualifyingSessionCount = 0;
	for (const registeredId of registeredIds) {
		if (memberIdsWithSessions.has(registeredId)) withQualifyingSessionCount += 1;
	}

	const registeredCount = registeredIds.size;
	const pct =
		registeredCount === 0
			? null
			: Number(((withQualifyingSessionCount / registeredCount) * 100).toFixed(2));

	return {
		registeredCount,
		withQualifyingSessionCount,
		pct
	};
}

function computeServiceCodeSessionRows(
	sessions: ServiceCodeSessionRecord[]
): ServiceCodeSessionRow[] {
	const counts = new Map<string, number>();
	for (const session of sessions) {
		counts.set(session.serviceCode, (counts.get(session.serviceCode) ?? 0) + 1);
	}

	const total = sessions.length;
	return [...counts.entries()]
		.map(([serviceCode, count]) => ({
			serviceCode,
			count,
			sharePct: total === 0 ? 0 : Number(((count / total) * 100).toFixed(2))
		}))
		.sort((a, b) => {
			if (b.count !== a.count) return b.count - a.count;
			return a.serviceCode.localeCompare(b.serviceCode);
		});
}

export const GET: RequestHandler = async ({ url }) => {
	try {
		const monthYearLabelInput = url.searchParams.get('monthYearLabel');

		const comparison = computeMonthComparisonWindow(monthYearLabelInput, {
			timeZone: REPORT_TIMEZONE
		});

		const metrics: MetricConfig[] = [
			{
				key: 'newRegistrationsMtd',
				path: '/contacts/search',
				extractItems: extractIntercomContacts,
				buildQuery: (startUnix, endUnix) =>
					buildContactDateRangeQuery(INTERCOM_ATTR_REGISTRATION_DATE, startUnix, endUnix)
			},
			{
				key: 'newEnrolleesMtd',
				path: '/contacts/search',
				extractItems: extractIntercomContacts,
				buildQuery: (startUnix, endUnix) =>
					buildContactDateRangeQuery(INTERCOM_ATTR_ENROLLED_DATE, startUnix, endUnix)
			}
		];

		const [
			values,
			currentSessions,
			priorSessions,
			currentAllChannelSessions,
			currentRegistrationIds,
			priorRegistrationIds
		] = await Promise.all([
			Promise.all(metrics.map((metric) => computeMetric(metric, comparison))),
			fetchQualifyingSessions(
				comparison.current.month.monthStartUnix,
				comparison.current.elapsedEndUnix
			),
			fetchQualifyingSessions(
				comparison.prior.month.monthStartUnix,
				comparison.prior.elapsedEndUnix
			),
			fetchAllChannelSessionsByServiceCode(
				comparison.current.month.monthStartUnix,
				comparison.current.elapsedEndUnix
			),
			fetchContactIdsByDateRange(
				INTERCOM_ATTR_REGISTRATION_DATE,
				comparison.current.month.monthStartUnix,
				comparison.current.elapsedEndUnix
			),
			fetchContactIdsByDateRange(
				INTERCOM_ATTR_REGISTRATION_DATE,
				comparison.prior.month.monthStartUnix,
				comparison.prior.elapsedEndUnix
			)
		]);

		const currentSessionTimestamps = currentSessions.map((session) => session.createdAt);
		const priorSessionTimestamps = priorSessions.map((session) => session.createdAt);

		const byKey = Object.fromEntries(values.map((value, index) => [metrics[index].key, value]));
		const qualifyingSessionsMtd = computeSessionMetric(
			comparison,
			currentSessionTimestamps,
			priorSessionTimestamps
		);
		const enrollmentSnapshot = {
			newlyRegisteredWithQualifyingSessionMtd: {
				current: computeRegistrationConversionSnapshot(
					currentRegistrationIds,
					currentSessions
				),
				prior: computeRegistrationConversionSnapshot(
					priorRegistrationIds,
					priorSessions
				)
			}
		};
		const caseloadTrends = {
			sessionsByServiceCodeMtd: computeServiceCodeSessionRows(
				currentAllChannelSessions
			)
		};

		return new Response(
			JSON.stringify({
				monthYearLabel: comparison.current.month.monthYearLabel,
				timeZone: comparison.timeZone,
				window: {
					monthStart: comparison.current.month.monthStartISO,
					monthEnd: comparison.current.month.monthEndISO,
					elapsedEnd: comparison.current.elapsedEndISO,
					elapsedDays: comparison.current.elapsedDays,
					priorMonthStart: comparison.prior.month.monthStartISO,
					priorMonthEnd: comparison.prior.month.monthEndISO,
					priorElapsedEnd: comparison.prior.elapsedEndISO,
					priorElapsedDays: comparison.prior.elapsedDays
				},
				kpis: {
					newRegistrationsMtd: byKey.newRegistrationsMtd,
					newEnrolleesMtd: byKey.newEnrolleesMtd,
					qualifyingSessionsMtd
				},
				enrollmentSnapshot,
				caseloadTrends
			}),
			{ headers: { 'Content-Type': 'application/json' } }
		);
	} catch (e: any) {
		const message = e?.message ?? String(e);
		const isMonthLabelError = message.includes('monthYearLabel');
		return new Response(
			JSON.stringify({
				error: 'overview report failed',
				details: message
			}),
			{
				status: isMonthLabelError ? 400 : 500,
				headers: { 'Content-Type': 'application/json' }
			}
		);
	}
};
