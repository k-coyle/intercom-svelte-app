<script lang="ts">
	import { page } from '$app/stores';
	import { Button } from '$lib/components/ui/button';
	import type { NavItem } from './nav';
	import { sdDefinitionsByRoute } from './sd-definitions';

	export let navItems: NavItem[] = [];
	export let title = 'Engagement';

	function isActive(href: string, pathname: string): boolean {
		if (href === '/engagement') return pathname === href;
		return pathname.startsWith(href);
	}

	function definitionsForPath(pathname: string) {
		const entries = Object.entries(sdDefinitionsByRoute).filter(([route]) => pathname.startsWith(route));
		if (entries.length === 0) return [];
		entries.sort((a, b) => b[0].length - a[0].length);
		return entries[0]?.[1] ?? [];
	}

	$: activeDefinitions = definitionsForPath($page.url.pathname);
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

	{#if activeDefinitions.length > 0}
		<div class="mt-2 border-t px-3 py-3">
			<p class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Definitions</p>
			<div class="mt-2 space-y-2">
				{#each activeDefinitions as item}
					<div class="rounded-md border bg-muted/20 px-2 py-1.5">
						<p class="text-xs font-medium">{item.term}</p>
						<p class="text-[11px] text-muted-foreground">{item.description}</p>
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>
