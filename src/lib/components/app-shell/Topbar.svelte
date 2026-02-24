<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import MenuIcon from '@lucide/svelte/icons/menu';
	import SearchIcon from '@lucide/svelte/icons/search';
	import BellIcon from '@lucide/svelte/icons/bell';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import {
		DropdownMenu,
		DropdownMenuContent,
		DropdownMenuItem,
		DropdownMenuLabel,
		DropdownMenuSeparator,
		DropdownMenuTrigger
	} from '$lib/components/ui/dropdown-menu';

	export let title = 'Engagement Analytics';

	const dispatch = createEventDispatcher<{ menu: void }>();
</script>

<header class="border-b bg-background">
	<div class="flex h-14 items-center gap-3 px-4 lg:px-6">
		<Button variant="ghost" size="icon" class="lg:hidden" onclick={() => dispatch('menu')}>
			<MenuIcon class="size-4" />
		</Button>

		<div class="min-w-0">
			<h1 class="truncate text-base font-semibold">{title}</h1>
		</div>

		<div class="hidden min-w-[220px] flex-1 md:block lg:max-w-sm">
			<div class="relative">
				<SearchIcon
					class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
				/>
				<Input class="pl-9" placeholder="Search..." />
			</div>
		</div>

		<div class="ml-auto flex items-center gap-1">
			<Button variant="ghost" size="icon">
				<SettingsIcon class="size-4" />
			</Button>
			<Button variant="ghost" size="icon">
				<BellIcon class="size-4" />
			</Button>

			<DropdownMenu>
				<DropdownMenuTrigger
					class="inline-flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent"
				>
					<span class="grid size-7 place-items-center rounded-full bg-muted text-xs font-semibold"
						>EA</span
					>
					<ChevronDownIcon class="size-4 text-muted-foreground" />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					<DropdownMenuLabel>Account</DropdownMenuLabel>
					<DropdownMenuSeparator />
					<DropdownMenuItem>Profile</DropdownMenuItem>
					<DropdownMenuItem>Settings</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem>Sign out</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	</div>
</header>
