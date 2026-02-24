import type { RequestHandler } from '@sveltejs/kit';
import {
	cancelNewParticipantsJob,
	cleanupNewParticipantsJob,
	createNewParticipantsJob,
	getNewParticipantsJobParticipants,
	getNewParticipantsJobReport,
	getNewParticipantsJobStatus,
	getNewParticipantsJobSummary,
	runNewParticipantsJobToCompletion,
	stepNewParticipantsJob
} from '$lib/server/new-participants-job';

const DEFAULT_LOOKBACK_DAYS = 365;

function coerceLegacyLookbackDays(raw: unknown): number {
	const parsed = Number(raw ?? DEFAULT_LOOKBACK_DAYS);
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LOOKBACK_DAYS;
	return Math.min(Math.floor(parsed), DEFAULT_LOOKBACK_DAYS);
}

export const POST: RequestHandler = async ({ request }) => {
	try {
		let body: any = {};
		try {
			body = await request.json();
		} catch {
			body = {};
		}

		const op = body?.op != null ? String(body.op) : '';

		// Legacy compatibility mode for one release cycle:
		// no op => return full report synchronously.
		if (!op) {
			const lookbackDays = coerceLegacyLookbackDays(body?.lookbackDays);
			const report = await runNewParticipantsJobToCompletion(lookbackDays);
			return new Response(JSON.stringify(report), {
				headers: { 'Content-Type': 'application/json' }
			});
		}

		if (op === 'create') {
			const payload = createNewParticipantsJob(body?.lookbackDays);
			return new Response(JSON.stringify(payload), {
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

			const payload = await stepNewParticipantsJob(jobId);
			if (!payload) {
				return new Response(JSON.stringify({ error: 'Job not found', jobId }), {
					status: 404,
					headers: { 'Content-Type': 'application/json' }
				});
			}

			return new Response(JSON.stringify(payload), {
				headers: { 'Content-Type': 'application/json' }
			});
		}

		if (op === 'cancel') {
			const jobId = String(body?.jobId ?? '');
			if (!jobId) {
				return new Response(JSON.stringify({ error: 'Missing jobId' }), {
					status: 400,
					headers: { 'Content-Type': 'application/json' }
				});
			}

			const payload = cancelNewParticipantsJob(jobId);
			if (!payload) {
				return new Response(JSON.stringify({ error: 'Job not found', jobId }), {
					status: 404,
					headers: { 'Content-Type': 'application/json' }
				});
			}

			return new Response(JSON.stringify(payload), {
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

			const deleted = cleanupNewParticipantsJob(jobId);
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
	} catch (e: any) {
		return new Response(
			JSON.stringify({
				error: 'new-participants report failed',
				details: e?.message ?? String(e)
			}),
			{ status: 500, headers: { 'Content-Type': 'application/json' } }
		);
	}
};

export const GET: RequestHandler = async ({ url }) => {
	const jobId = url.searchParams.get('jobId') ?? '';
	if (!jobId) {
		return new Response(
			JSON.stringify({
				error: 'Missing jobId',
				usage:
					'GET ?jobId=... (status) or ?jobId=...&view=summary|participants|report&offset=0&limit=500'
			}),
			{ status: 400, headers: { 'Content-Type': 'application/json' } }
		);
	}

	const status = getNewParticipantsJobStatus(jobId);
	if (!status) {
		return new Response(JSON.stringify({ error: 'Job not found', jobId }), {
			status: 404,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	const view = url.searchParams.get('view');
	if (!view) {
		return new Response(JSON.stringify(status), {
			headers: { 'Content-Type': 'application/json' }
		});
	}

	if (status.status !== 'complete') {
		return new Response(
			JSON.stringify({
				error: 'Job not complete',
				status: status.status,
				phase: status.phase
			}),
			{ status: 409, headers: { 'Content-Type': 'application/json' } }
		);
	}

	if (view === 'summary') {
		const summary = getNewParticipantsJobSummary(jobId);
		if (!summary) {
			return new Response(JSON.stringify({ error: 'Summary unavailable', jobId }), {
				status: 404,
				headers: { 'Content-Type': 'application/json' }
			});
		}

		return new Response(JSON.stringify(summary), {
			headers: { 'Content-Type': 'application/json' }
		});
	}

	if (view === 'participants') {
		const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0));
		const limit = Math.min(5000, Math.max(1, Number(url.searchParams.get('limit') ?? 500)));
		const rows = getNewParticipantsJobParticipants(jobId, offset, limit);

		if (!rows) {
			return new Response(JSON.stringify({ error: 'Rows unavailable', jobId }), {
				status: 404,
				headers: { 'Content-Type': 'application/json' }
			});
		}

		return new Response(JSON.stringify(rows), {
			headers: { 'Content-Type': 'application/json' }
		});
	}

	if (view === 'report') {
		const report = getNewParticipantsJobReport(jobId);
		if (!report) {
			return new Response(JSON.stringify({ error: 'Report unavailable', jobId }), {
				status: 404,
				headers: { 'Content-Type': 'application/json' }
			});
		}

		return new Response(JSON.stringify(report), {
			headers: { 'Content-Type': 'application/json' }
		});
	}

	return new Response(
		JSON.stringify({
			error: 'Unknown view',
			details: 'Supported views: summary, participants, report'
		}),
		{ status: 400, headers: { 'Content-Type': 'application/json' } }
	);
};
