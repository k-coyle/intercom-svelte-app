import { fetchJson } from '$lib/client/report-utils';

const SESSIONS_ENDPOINT = '/API/engagement/report/conversations';

export type SessionsReportRow = {
	conversation_id: string;
	created_at: string;
	channel: string;
	service_code: string;
	state: string;
	communication_flag: string;
	bot: boolean;
	teammate_name: string;
	user_name: string;
	employer: string;
};

export type SessionsReportResponse = {
	mode: 'json' | string;
	lookbackDays: number;
	sinceUnix: number;
	filterField: string;
	conversationsFetched: number;
	detailsFetched: number;
	rowsWritten: number;
	skippedMissingUserName: number;
	missingContact: number;
	missingDetails: number;
	preview: SessionsReportRow[];
};

export async function fetchSessionsReport(
	lookbackDays?: number,
	signal?: AbortSignal
): Promise<SessionsReportResponse> {
	const body: Record<string, unknown> = {
		returnMode: 'json'
	};

	if (lookbackDays != null && Number.isFinite(lookbackDays) && lookbackDays > 0) {
		body.lookbackDays = Math.floor(lookbackDays);
	}

	return fetchJson<SessionsReportResponse>(SESSIONS_ENDPOINT, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
		signal
	});
}
