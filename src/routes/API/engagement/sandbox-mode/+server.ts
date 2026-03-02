import type { RequestHandler } from '@sveltejs/kit';
import { resolveOfflineFixturesEnabled, setSandboxModeCookie } from '$lib/server/sandbox-mode';

export const GET: RequestHandler = async ({ cookies }) => {
	const enabled = resolveOfflineFixturesEnabled({ cookies });
	return new Response(JSON.stringify({ enabled }), {
		headers: { 'Content-Type': 'application/json' }
	});
};

export const POST: RequestHandler = async ({ request, cookies }) => {
	let body: any = {};
	try {
		body = await request.json();
	} catch {
		body = {};
	}

	if (typeof body?.enabled !== 'boolean') {
		return new Response(JSON.stringify({ error: 'enabled must be a boolean' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	setSandboxModeCookie(cookies, body.enabled);

	return new Response(JSON.stringify({ enabled: body.enabled }), {
		headers: { 'Content-Type': 'application/json' }
	});
};

