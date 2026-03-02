<script lang="ts">
	import Sidebar from './Sidebar.svelte';
	import Topbar from './Topbar.svelte';
	import type { NavItem } from './nav';

	export let navItems: NavItem[] = [];
	export let title = 'Engagement Analytics';
	export let sandboxModeOffline = false;

	let mobileNavOpen = false;
</script>

<div class="min-h-screen bg-background">
	<div class="flex min-h-screen">
		<aside class="hidden w-60 shrink-0 border-r bg-background lg:block">
			<Sidebar {navItems} {title} />
		</aside>

		<div class="flex min-w-0 flex-1 flex-col">
			<Topbar {title} {sandboxModeOffline} on:menu={() => (mobileNavOpen = true)} />

			<main class="mx-auto w-full max-w-6xl space-y-4 px-4 py-6 lg:px-6">
				<slot />
			</main>
		</div>
	</div>

	{#if mobileNavOpen}
		<button
			type="button"
			class="fixed inset-0 z-40 bg-background/70 lg:hidden"
			aria-label="Close navigation"
			on:click={() => (mobileNavOpen = false)}
		></button>
		<aside class="fixed inset-y-0 left-0 z-50 w-72 border-r bg-background lg:hidden">
			<Sidebar {navItems} {title} />
		</aside>
	{/if}
</div>
