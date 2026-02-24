import type { KpiItem } from '$lib/components/report/engagementReportConfig';

export function formatUnixDate(unix: number | null, withTime = false): string {
	if (unix == null) return '-';
	const d = new Date(unix * 1000);
	if (Number.isNaN(d.getTime())) return '-';
	return withTime ? d.toLocaleString() : d.toLocaleDateString();
}

export function formatIsoDate(iso?: string): string {
	if (!iso) return '-';
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return '-';
	return d.toLocaleString();
}

export function buildShareKpi(
	label: string,
	count: number,
	total: number,
	points?: number[]
): KpiItem {
	const share = total > 0 ? `${((count / total) * 100).toFixed(1)}%` : '0.0%';
	return {
		label,
		value: count,
		deltaLabel: 'Share',
		deltaPct: share,
		trend: 'flat',
		points: points ?? [count, count, count]
	};
}
