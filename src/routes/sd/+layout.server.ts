import type { LayoutServerLoad } from './$types';
import { resolveOfflineFixturesEnabled } from '$lib/server/sandbox-mode';

export const load: LayoutServerLoad = async ({ cookies }) => {
	return {
		sandboxModeOffline: resolveOfflineFixturesEnabled({ cookies })
	};
};
