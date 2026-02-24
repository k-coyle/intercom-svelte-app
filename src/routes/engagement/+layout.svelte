<script lang="ts">
	import AppShell from '$lib/components/app-shell/AppShell.svelte';
	import { engagementNav } from '$lib/components/app-shell/nav';
</script>

<AppShell navItems={engagementNav} title="Engagement Analytics">
	<slot />
</AppShell>
