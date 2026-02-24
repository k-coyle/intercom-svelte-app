<script lang="ts">
	import { page } from '$app/stores';
	import { Button } from '$lib/components/ui/button';
	import type { NavItem } from './nav';

	export let navItems: NavItem[] = [];
	export let title = 'Engagement';

	function isActive(href: string, pathname: string): boolean {
		if (href === '/engagement') return pathname === href;
		return pathname.startsWith(href);
	}
</script>

<div class="flex h-full flex-col">
	<div class="border-b px-4 py-4">
		<p class="text-xs font-medium tracking-wide text-muted-foreground">Analytics</p>
		<p class="text-sm font-semibold">{title}</p>
	</div>

	<nav class="space-y-1 px-2 py-3">
		{#each navItems as item}
			{@const active = isActive(item.href, $page.url.pathname)}
			<Button
				href={item.href}
				variant="ghost"
				class={`w-full justify-start gap-2 ${
					active ? 'bg-muted text-foreground' : 'text-muted-foreground'
				}`}
			>
				<svelte:component this={item.icon} class="size-4" />
				<span>{item.label}</span>
			</Button>
		{/each}
	</nav>
</div>
