<script lang="ts">
	import AppShell from '$lib/components/app-shell/AppShell.svelte';
	import { sdNav } from '$lib/components/app-shell/nav';

	export let data: {
		sandboxModeOffline?: boolean;
	};
</script>

<AppShell
	navItems={sdNav}
	title="Service Delivery Analytics"
	sandboxModeOffline={!!data?.sandboxModeOffline}
>
	<slot />
</AppShell>
