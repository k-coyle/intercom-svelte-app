export const QUALIFYING_COACHING_CHANNELS = ['Phone', 'Video Conference'] as const;
export const QUALIFYING_COACHING_SERVICE_CODES = [
	'Health Coaching 001',
	'Disease Management 002'
] as const;

function normalizeValue(v: any): string {
	return String(v ?? '')
		.trim()
		.toLowerCase()
		.replace(/[_-]+/g, ' ')
		.replace(/\s+/g, ' ');
}

const NORMALIZED_QUALIFYING_CHANNELS = new Set(
	QUALIFYING_COACHING_CHANNELS.map((value) => normalizeValue(value))
);
const NORMALIZED_QUALIFYING_SERVICE_CODES = new Set(
	QUALIFYING_COACHING_SERVICE_CODES.map((value) => normalizeValue(value))
);

export function isQualifyingCoachingSession(channel: any, serviceCode: any): boolean {
	const ch = normalizeValue(channel);
	const sc = normalizeValue(serviceCode);
	return NORMALIZED_QUALIFYING_CHANNELS.has(ch) && NORMALIZED_QUALIFYING_SERVICE_CODES.has(sc);
}
