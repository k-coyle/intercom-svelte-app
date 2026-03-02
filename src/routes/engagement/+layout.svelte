<script lang="ts">
	import AppShell from '$lib/components/app-shell/AppShell.svelte';
	import { engagementNav } from '$lib/components/app-shell/nav';

	export let data: {
		sandboxModeOffline?: boolean;
	};
</script>

<AppShell
	navItems={engagementNav}
	title="Engagement Analytics"
	sandboxModeOffline={!!data?.sandboxModeOffline}
>
	<slot />
</AppShell>
