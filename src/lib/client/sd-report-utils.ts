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
