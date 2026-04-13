export type BreakdownItem = { label: string; value: number };
export type LineSeriesResult = {
	dates: string[];
	series: Array<{ name: string; values: Array<number | null> }>;
	xAxisLabel: string;
};

export function toUnixStart(isoDate: string): number | null {
	const ms = Date.parse(`${isoDate}T00:00:00Z`);
	if (Number.isNaN(ms)) return null;
	return Math.floor(ms / 1000);
}

export function toUnixEndExclusive(isoDate: string): number | null {
	const start = toUnixStart(isoDate);
	if (start == null) return null;
	return start + 24 * 60 * 60;
}

export function dateInRange(unixSeconds: number | null | undefined, startUnix: number, endUnixExclusive: number): boolean {
	if (unixSeconds == null || !Number.isFinite(unixSeconds)) return false;
	return unixSeconds >= startUnix && unixSeconds < endUnixExclusive;
}

function startOfUtcDay(unix: number): number {
	const date = new Date(unix * 1000);
	return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 1000);
}

function startOfUtcWeek(unix: number): number {
	const date = new Date(unix * 1000);
	const day = (date.getUTCDay() + 6) % 7;
	const aligned = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day));
	return Math.floor(aligned.getTime() / 1000);
}

function startOfUtcMonth(unix: number): number {
	const date = new Date(unix * 1000);
	return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / 1000);
}

function startOfUtcYear(unix: number): number {
	const date = new Date(unix * 1000);
	return Math.floor(Date.UTC(date.getUTCFullYear(), 0, 1) / 1000);
}

function pickGranularity(startUnix: number, endUnixExclusive: number): 'day' | 'week' | 'month' | 'year' {
	const daySpan = (endUnixExclusive - startUnix) / (24 * 60 * 60);
	if (daySpan >= 365) return 'year';
	if (daySpan >= 90) return 'month';
	if (daySpan >= 21) return 'week';
	return 'day';
}

function bucketStartUnix(unix: number, granularity: 'day' | 'week' | 'month' | 'year'): number {
	if (granularity === 'year') return startOfUtcYear(unix);
	if (granularity === 'month') return startOfUtcMonth(unix);
	if (granularity === 'week') return startOfUtcWeek(unix);
	return startOfUtcDay(unix);
}

function nextBucketUnix(unix: number, granularity: 'day' | 'week' | 'month' | 'year'): number {
	if (granularity === 'year') {
		const d = new Date(unix * 1000);
		return Math.floor(Date.UTC(d.getUTCFullYear() + 1, 0, 1) / 1000);
	}
	if (granularity === 'month') {
		const d = new Date(unix * 1000);
		return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000);
	}
	if (granularity === 'week') return unix + 7 * 24 * 60 * 60;
	return unix + 24 * 60 * 60;
}

function bucketLabel(unix: number): string {
	return new Date(unix * 1000).toISOString().slice(0, 10);
}

export function buildBreakdown<T>(rows: T[], getLabels: (row: T) => string[]): BreakdownItem[] {
	const counts = new Map<string, number>();
	for (const row of rows) {
		const labels = getLabels(row);
		for (const label of labels) {
			const text = String(label ?? '').trim() || 'Unspecified';
			counts.set(text, (counts.get(text) ?? 0) + 1);
		}
	}
	return [...counts.entries()]
		.map(([label, value]) => ({ label, value }))
		.sort((a, b) => {
			if (b.value !== a.value) return b.value - a.value;
			return a.label.localeCompare(b.label);
		});
}

export function buildEventDateSeries<T>(
	rows: T[],
	getUnix: (row: T) => number | null,
	getLabels: (row: T) => string[],
	range: { startDate: string; endDate: string }
): LineSeriesResult {
	const startUnix = toUnixStart(range.startDate);
	const endUnixExclusive = toUnixEndExclusive(range.endDate);
	if (startUnix == null || endUnixExclusive == null || endUnixExclusive <= startUnix) {
		return { dates: [], series: [], xAxisLabel: 'Date' };
	}

	const granularity = pickGranularity(startUnix, endUnixExclusive);
	const firstBucket = bucketStartUnix(startUnix, granularity);
	const bucketStarts: number[] = [];
	for (let cursor = firstBucket; cursor < endUnixExclusive; cursor = nextBucketUnix(cursor, granularity)) {
		bucketStarts.push(cursor);
	}
	const labels = bucketStarts.map(bucketLabel);
	const indexByBucket = new Map<number, number>(bucketStarts.map((unix, index) => [unix, index]));
	const totals = new Map<string, number>();

	for (const row of rows) {
		const at = getUnix(row);
		if (!dateInRange(at, startUnix, endUnixExclusive)) continue;
		for (const label of getLabels(row)) {
			const text = String(label ?? '').trim() || 'Unspecified';
			totals.set(text, (totals.get(text) ?? 0) + 1);
		}
	}

	const orderedKeys = [...totals.entries()]
		.sort((a, b) => {
			if (b[1] !== a[1]) return b[1] - a[1];
			return a[0].localeCompare(b[0]);
		})
		.map(([key]) => key);
	const seriesMap = new Map<string, Array<number | null>>();
	for (const key of orderedKeys) {
		seriesMap.set(key, labels.map(() => 0));
	}

	for (const row of rows) {
		const at = getUnix(row);
		if (!dateInRange(at, startUnix, endUnixExclusive) || at == null) continue;
		const bucketUnix = bucketStartUnix(at, granularity);
		const bucketIndex = indexByBucket.get(bucketUnix);
		if (bucketIndex == null) continue;
		for (const label of getLabels(row)) {
			const text = String(label ?? '').trim() || 'Unspecified';
			const values = seriesMap.get(text);
			if (!values) continue;
			values[bucketIndex] = (values[bucketIndex] ?? 0) + 1;
		}
	}

	return {
		dates: labels,
		series: [...seriesMap.entries()].map(([name, values]) => ({ name, values })),
		xAxisLabel: 'Date'
	};
}
