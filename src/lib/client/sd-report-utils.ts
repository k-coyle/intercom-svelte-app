import { downloadCsv } from '$lib/client/report-utils';

export function todayIsoDate(): string {
	return new Date().toISOString().slice(0, 10);
}

export function isoDateDaysAgo(days: number): string {
	const now = new Date();
	now.setUTCDate(now.getUTCDate() - days);
	return now.toISOString().slice(0, 10);
}

export function uniqueSorted(values: Array<string | null | undefined>): string[] {
	return [...new Set(values.filter((value): value is string => Boolean(value && value.trim())).map((value) => value.trim()))]
		.sort((a, b) => a.localeCompare(b));
}

export function uniqueListValues(rows: Array<{ programs?: string[] }>): string[] {
	const set = new Set<string>();
	for (const row of rows) {
		for (const value of row.programs ?? []) {
			const text = String(value ?? '').trim();
			if (!text) continue;
			set.add(text);
		}
	}
	return [...set].sort((a, b) => a.localeCompare(b));
}

export const SD_BLANK_FILTER_LABELS = {
	program: 'No Program',
	employer: 'Unspecified Employer',
	serviceCode: 'Unspecified Service Code',
	coach: 'Unassigned Coach',
	channel: 'Unspecified Channel',
	referralSource: 'Unspecified Referral Source',
	referralReason: 'Unspecified Referral Reason',
	outgoingReferralDestination: 'Unspecified Outgoing Referral'
} as const;

export const SD_FILTER_DEFAULT_OPTIONS = {
	programs: ['Smart Access', 'Preventative Plan', SD_BLANK_FILTER_LABELS.program],
	employers: [
		'World Bank',
		'Work Care',
		'Peoria',
		'Lendlease',
		'Devon Bank',
		'Belmont University',
		'SFG',
		'Counter Health',
		'Del Air',
		'LMI',
		'Vitality',
		SD_BLANK_FILTER_LABELS.employer
	],
	serviceCodes: [
		'Health Coaching',
		'Disease Management',
		'Technical Support',
		'Member Outreach',
		'General Inquiry',
		SD_BLANK_FILTER_LABELS.serviceCode
	],
	coaches: [
		'Andrea Licht',
		'Ashley Goddard',
		'Racquel Royal',
		'Sit-Yen Ang',
		SD_BLANK_FILTER_LABELS.coach
	],
	channels: [
		'Phone',
		'Video Conference',
		'Email',
		'Chat',
		'Pursuit Post via App',
		'Intercom Ticket',
		SD_BLANK_FILTER_LABELS.channel
	],
	directionality: ['Unidirectional', 'Bidirectional', 'Other'],
	referralSources: ['MedStar', 'Member', SD_BLANK_FILTER_LABELS.referralSource],
	referralReasons: [
		'Weight Loss / GLP-1',
		'Hypertension / Hyperlipedema',
		'Pre-Diabetes / Diabetes',
		'Smoking Cessation',
		'Other',
		SD_BLANK_FILTER_LABELS.referralReason
	],
	outgoingReferralDestinations: [
		'Counter Health',
		'Medstar',
		'EAP',
		'None',
		'Mental Health Provider',
		'Medical Health Provider',
		SD_BLANK_FILTER_LABELS.outgoingReferralDestination
	],
	schedulingStatuses: ['scheduled', 'completed', 'no_show', 'rescheduled', 'canceled']
} as const;

export const SD_SERVICE_CODE_ALIASES: Record<string, string> = {
	'health coaching 001': 'Health Coaching',
	'health coaching': 'Health Coaching',
	'disease management 002': 'Disease Management',
	'disease management': 'Disease Management',
	'technical support 003': 'Technical Support',
	'technical support': 'Technical Support',
	'member outreach 004': 'Member Outreach',
	'member outreach': 'Member Outreach',
	'general inquiry 005': 'General Inquiry',
	'general inquiry': 'General Inquiry'
};

export type FilterNormalizeOptions = {
	blankLabel?: string;
	aliases?: Record<string, string>;
};

function filterKey(value: string): string {
	return value.trim().toLocaleLowerCase();
}

export function normalizeFilterValue(
	value: string | number | boolean | null | undefined,
	options: FilterNormalizeOptions = {}
): string {
	const text = String(value ?? '').trim();
	if (!text) return options.blankLabel ?? '';
	return options.aliases?.[filterKey(text)] ?? text;
}

export function valuesOrBlank(values: Array<string | null | undefined> | null | undefined): Array<string | null> {
	const normalized = (values ?? []).map((value) => String(value ?? '').trim()).filter(Boolean);
	return normalized.length > 0 ? normalized : [null];
}

export function mergeFilterOptions(
	defaultOptions: readonly string[],
	discoveredOptions: Array<string | null | undefined>,
	options: FilterNormalizeOptions = {}
): string[] {
	const byKey = new Map<string, string>();
	const add = (raw: string | null | undefined) => {
		const value = normalizeFilterValue(raw, options);
		if (!value) return;
		const key = filterKey(value);
		if (!byKey.has(key)) byKey.set(key, value);
	};

	defaultOptions.forEach(add);
	discoveredOptions.forEach(add);

	return [...byKey.values()].sort((a, b) => a.localeCompare(b));
}

export function retainSelectedFilterValues(selected: string[], availableOptions: string[]): string[] {
	const availableByKey = new Map(availableOptions.map((value) => [filterKey(value), value]));
	const retained: string[] = [];
	const seen = new Set<string>();
	for (const value of selected) {
		const option = availableByKey.get(filterKey(value));
		if (!option) continue;
		const key = filterKey(option);
		if (seen.has(key)) continue;
		seen.add(key);
		retained.push(option);
	}
	return retained;
}

export function matchesSelectedFilter(
	selected: string[],
	value: string | number | boolean | null | undefined,
	options: FilterNormalizeOptions = {}
): boolean {
	if (selected.length === 0) return true;
	const normalized = normalizeFilterValue(value, options);
	if (!normalized) return false;
	const selectedKeys = new Set(selected.map((entry) => filterKey(normalizeFilterValue(entry, options))));
	return selectedKeys.has(filterKey(normalized));
}

export function matchesSelectedListFilter(
	selected: string[],
	values: Array<string | null | undefined> | null | undefined,
	options: FilterNormalizeOptions = {}
): boolean {
	if (selected.length === 0) return true;
	const selectedKeys = new Set(selected.map((entry) => filterKey(normalizeFilterValue(entry, options))));
	return valuesOrBlank(values).some((value) => {
		const normalized = normalizeFilterValue(value, options);
		return normalized.length > 0 && selectedKeys.has(filterKey(normalized));
	});
}

export function csvDateStamp(): string {
	return new Date().toISOString().slice(0, 10);
}

export function exportRowsAsCsv(opts: {
	filenamePrefix: string;
	headers: string[];
	rows: Array<Array<string | number | boolean | null | undefined>>;
}) {
	downloadCsv(`${opts.filenamePrefix}_${csvDateStamp()}.csv`, opts.headers, opts.rows);
}

export function byDateAsc(a: string, b: string): number {
	return a.localeCompare(b);
}

export type ComparisonRangeMode = 'previous' | 'custom';
export type ComparisonTrend = 'higher_is_better' | 'lower_is_better' | 'neutral';

export function shiftIsoDate(isoDate: string, dayDelta: number): string | null {
	const ms = Date.parse(`${isoDate}T00:00:00Z`);
	if (Number.isNaN(ms)) return null;
	const date = new Date(ms);
	date.setUTCDate(date.getUTCDate() + dayDelta);
	return date.toISOString().slice(0, 10);
}

export function previousPeriodRange(startDate: string, endDate: string): { startDate: string; endDate: string } | null {
	const startMs = Date.parse(`${startDate}T00:00:00Z`);
	const endMs = Date.parse(`${endDate}T00:00:00Z`);
	if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs < startMs) return null;
	const periodDays = Math.floor((endMs - startMs) / (24 * 60 * 60 * 1000)) + 1;
	const prevEnd = shiftIsoDate(startDate, -1);
	if (!prevEnd) return null;
	const prevStart = shiftIsoDate(prevEnd, -(periodDays - 1));
	if (!prevStart) return null;
	return { startDate: prevStart, endDate: prevEnd };
}

export function formatSignedNumber(value: number, fractionDigits = 0): string {
	const sign = value > 0 ? '+' : value < 0 ? '-' : '';
	return `${sign}${Math.abs(value).toFixed(fractionDigits)}`;
}

export function computeKpiComparison(currentValue: number, previousValue: number) {
	const delta = currentValue - previousValue;
	const pctChange = previousValue === 0 ? null : (delta / previousValue) * 100;
	return { delta, pctChange };
}

export function comparisonTone(delta: number, trend: ComparisonTrend): 'positive' | 'negative' | 'neutral' {
	if (trend === 'neutral' || delta === 0) return 'neutral';
	if (trend === 'higher_is_better') return delta > 0 ? 'positive' : 'negative';
	return delta < 0 ? 'positive' : 'negative';
}
