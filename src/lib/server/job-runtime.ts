export const STEP_BUDGET_MS = 20_000;
export const STEP_SAFETY_MS = 1_250;
export const MIN_TIME_TO_START_REQUEST_MS = 4_500;
export const JOB_TTL_MS = 10 * 60 * 1000;

export function timeLeftMs(deadlineMs: number) {
	return deadlineMs - Date.now();
}

export function isAbortError(e: any) {
	return (
		e?.name === 'AbortError' ||
		String(e?.message ?? '')
			.toLowerCase()
			.includes('aborted')
	);
}
