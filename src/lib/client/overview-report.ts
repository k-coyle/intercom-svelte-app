import { fetchJson } from '$lib/client/report-utils';

const OVERVIEW_ENDPOINT = '/API/engagement/overview';

export type OverviewKpi = {
	count: number;
	priorCount: number;
	deltaCount: number;
	deltaPct: number | null;
	sparkline: number[];
};

export type RegistrationConversionSnapshot = {
	registeredCount: number;
	withQualifyingSessionCount: number;
	pct: number | null;
};

export type ServiceCodeSessionRow = {
	serviceCode: string;
	count: number;
	sharePct: number;
};

export type OverviewResponse = {
	monthYearLabel: string;
	timeZone: string;
	window: {
		monthStart: string;
		monthEnd: string;
		elapsedEnd: string;
		elapsedDays: number;
		priorMonthStart: string;
		priorMonthEnd: string;
		priorElapsedEnd: string;
		priorElapsedDays: number;
	};
	kpis: {
		newRegistrationsMtd: OverviewKpi;
		newEnrolleesMtd: OverviewKpi;
		qualifyingSessionsMtd: OverviewKpi;
	};
	enrollmentSnapshot: {
		newlyRegisteredWithQualifyingSessionMtd: {
			current: RegistrationConversionSnapshot;
			prior: RegistrationConversionSnapshot;
		};
	};
	caseloadTrends: {
		sessionsByServiceCodeMtd: ServiceCodeSessionRow[];
	};
};

export async function fetchOverviewReport(
	monthYearLabel?: string,
	signal?: AbortSignal
): Promise<OverviewResponse> {
	const params = new URLSearchParams();
	if (monthYearLabel && monthYearLabel.trim()) {
		params.set('monthYearLabel', monthYearLabel.trim());
	}

	const url = params.size > 0 ? `${OVERVIEW_ENDPOINT}?${params.toString()}` : OVERVIEW_ENDPOINT;
	return fetchJson<OverviewResponse>(url, { signal });
}
