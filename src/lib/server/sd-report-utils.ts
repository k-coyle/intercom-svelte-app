import {
	INTERCOM_ATTR_ELIGIBLE_PROGRAMS,
	INTERCOM_ATTR_EMPLOYER,
	INTERCOM_ATTR_ENROLLED_DATE,
	INTERCOM_ATTR_OUTGOING_REFERRAL,
	INTERCOM_ATTR_OUTGOING_REFERRAL_REASON,
	INTERCOM_ATTR_REFERRAL,
	INTERCOM_ATTR_REFERRAL_DATE,
	INTERCOM_ATTR_REFERRAL_REASON,
	INTERCOM_ATTR_REFERRAL_SOURCE,
	INTERCOM_ATTR_REGISTRATION_DATE
} from '$lib/server/intercom-attrs';

export const SD_EXCLUDED_EMPLOYERS = ['STX', 'Test Group', 'USPM'] as const;

export const SD_EMPLOYER_ATTR_KEY = INTERCOM_ATTR_EMPLOYER;
export const SD_PROGRAM_ATTR_KEY = INTERCOM_ATTR_ELIGIBLE_PROGRAMS;
export const SD_ENROLLED_DATE_ATTR_KEY = INTERCOM_ATTR_ENROLLED_DATE;
export const SD_REGISTRATION_DATE_ATTR_KEY = INTERCOM_ATTR_REGISTRATION_DATE;
export const SD_REFERRAL_SOURCE_ATTR_KEYS = [
	INTERCOM_ATTR_REFERRAL_SOURCE,
	INTERCOM_ATTR_REFERRAL
] as const;
export const SD_REFERRAL_DATE_ATTR_KEY = INTERCOM_ATTR_REFERRAL_DATE;
export const SD_REFERRAL_REASON_ATTR_KEY = INTERCOM_ATTR_REFERRAL_REASON;
export const SD_OUTGOING_REFERRAL_ATTR_KEY = INTERCOM_ATTR_OUTGOING_REFERRAL;
export const SD_OUTGOING_REFERRAL_REASON_ATTR_KEY = INTERCOM_ATTR_OUTGOING_REFERRAL_REASON;

export function normalizeText(value: unknown): string {
	return String(value ?? '')
		.trim()
		.toLowerCase();
}

export function isExcludedEmployer(value: unknown): boolean {
	const normalized = normalizeText(value);
	return SD_EXCLUDED_EMPLOYERS.some((entry) => normalizeText(entry) === normalized);
}

export function parseStringListField(raw: unknown): string[] {
	if (Array.isArray(raw)) {
		return raw
			.map((value) => String(value ?? '').trim())
			.filter((value) => value.length > 0);
	}

	if (raw == null) return [];
	const text = String(raw).trim();
	if (!text) return [];

	// Handle serialized array payloads occasionally seen in Intercom custom attributes.
	if (text.startsWith('[') && text.endsWith(']')) {
		try {
			const parsed = JSON.parse(text);
			if (Array.isArray(parsed)) {
				return parsed
					.map((value) => String(value ?? '').trim())
					.filter((value) => value.length > 0);
			}
		} catch {
			// Fall through to delimiter parsing.
		}
	}

	return text
		.split(/[;,|]+/)
		.map((value) => value.trim())
		.filter((value) => value.length > 0);
}

export function toUnixOrNull(raw: unknown): number | null {
	if (typeof raw === 'number' && Number.isFinite(raw)) return Math.floor(raw);

	if (typeof raw === 'string') {
		const text = raw.trim();
		if (!text) return null;

		const asNumber = Number(text);
		if (Number.isFinite(asNumber)) return Math.floor(asNumber);

		const parsedMs = Date.parse(text);
		if (!Number.isNaN(parsedMs)) return Math.floor(parsedMs / 1000);
	}

	return null;
}

export function firstPresentString(rawValues: unknown[]): string | null {
	for (const raw of rawValues) {
		const text = String(raw ?? '').trim();
		if (text) return text;
	}
	return null;
}

export function toIsoDateLabel(unixSeconds: number): string {
	return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

export function parseDateInputToUnixStart(raw: string | null | undefined): number | null {
	const text = String(raw ?? '').trim();
	if (!text) return null;
	const ms = Date.parse(`${text}T00:00:00Z`);
	if (Number.isNaN(ms)) return null;
	return Math.floor(ms / 1000);
}

export function parseDateInputToUnixEndExclusive(raw: string | null | undefined): number | null {
	const start = parseDateInputToUnixStart(raw);
	if (start == null) return null;
	return start + 24 * 60 * 60;
}
