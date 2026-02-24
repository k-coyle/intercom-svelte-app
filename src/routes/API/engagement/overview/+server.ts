import type { RequestHandler } from '@sveltejs/kit';
import {
	extractIntercomContacts,
	extractIntercomConversations,
	intercomPaginate,
	intercomRequest
} from '$lib/server/intercom';
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
import { isQualifyingCoachingSession } from '$lib/server/engagement-rules';

const SPARKLINE_POINTS = 8;

type KpiValue = {
	count: number;
	priorCount: number;
	deltaCount: number;
	deltaPct: number | null;
	sparkline: number[];
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

async function fetchQualifyingSessionTimestamps(
	startUnix: number,
	endUnix: number
): Promise<number[]> {
	const conversations = await intercomPaginate<any>({
		path: '/conversations/search',
		body: {
			query: buildQualifyingSessionsQuery(startUnix, endUnix)
		},
		extractItems: extractIntercomConversations
	});

	const timestamps: number[] = [];
	for (const conversation of conversations) {
		if (!isQualifyingSession(conversation)) continue;

		const createdAt = toNumber(conversation?.created_at);
		if (createdAt == null) continue;
		if (createdAt < startUnix || createdAt >= endUnix) continue;

		timestamps.push(Math.floor(createdAt));
	}

	timestamps.sort((a, b) => a - b);
	return timestamps;
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

		const [values, currentSessionTimestamps, priorSessionTimestamps] = await Promise.all([
			Promise.all(metrics.map((metric) => computeMetric(metric, comparison))),
			fetchQualifyingSessionTimestamps(
				comparison.current.month.monthStartUnix,
				comparison.current.elapsedEndUnix
			),
			fetchQualifyingSessionTimestamps(
				comparison.prior.month.monthStartUnix,
				comparison.prior.elapsedEndUnix
			)
		]);

		const byKey = Object.fromEntries(values.map((value, index) => [metrics[index].key, value]));
		const qualifyingSessionsMtd = computeSessionMetric(
			comparison,
			currentSessionTimestamps,
			priorSessionTimestamps
		);

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
				}
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
