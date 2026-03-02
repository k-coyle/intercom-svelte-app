import { env } from '$env/dynamic/private';
import type { Cookies } from '@sveltejs/kit';

export const SANDBOX_MODE_COOKIE = 'engagement_sandbox_mode';
const SANDBOX_MODE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

function isTruthy(raw: string | undefined): boolean {
	if (!raw) return false;
	const value = raw.trim().toLowerCase();
	return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function parseSandboxCookie(raw: string | undefined): boolean | null {
	if (!raw) return null;
	const value = raw.trim().toLowerCase();
	if (value === 'offline' || value === 'sandbox' || value === 'true' || value === '1') return true;
	if (value === 'live' || value === 'false' || value === '0') return false;
	return null;
}

export function resolveOfflineFixturesEnabled(opts: { cookies?: Cookies | null } = {}): boolean {
	const nonProduction = String(env.NODE_ENV ?? '').toLowerCase() !== 'production';
	if (!nonProduction) return false;

	const cookieValue = opts.cookies?.get(SANDBOX_MODE_COOKIE);
	const fromCookie = parseSandboxCookie(cookieValue);
	if (fromCookie != null) return fromCookie;

	return isTruthy(env.USE_OFFLINE_FIXTURES);
}

export function setSandboxModeCookie(cookies: Cookies, enabled: boolean): void {
	cookies.set(SANDBOX_MODE_COOKIE, enabled ? 'offline' : 'live', {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		maxAge: SANDBOX_MODE_COOKIE_MAX_AGE_SECONDS
	});
}

