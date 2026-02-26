<script lang="ts">
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '$lib/components/ui/dropdown-menu';

	type MultiSelectOption = {
		value: string;
		label: string;
	};

	export let placeholder = 'All';
	export let options: MultiSelectOption[] = [];
	export let selected: string[] = [];
	export let disabled = false;

	$: validValues = new Set(options.map((option) => option.value));
	$: selected = selected.filter((value) => validValues.has(value));
	$: selectedCount = selected.length;
	$: selectedLabel =
		selectedCount === 0
			? placeholder
			: selectedCount === 1
				? options.find((option) => option.value === selected[0])?.label ?? selected[0]
				: `${selectedCount} selected`;

	function toggle(value: string, checked: boolean): void {
		if (checked) {
			if (!selected.includes(value)) {
				selected = [...selected, value];
			}
			return;
		}
		selected = selected.filter((current) => current !== value);
	}

	function selectAll(): void {
		selected = options.map((option) => option.value);
	}

	function clearAll(): void {
		selected = [];
	}
</script>

<DropdownMenu>
	<DropdownMenuTrigger
		class="flex h-9 w-full items-center justify-between rounded-md border border-input bg-background px-3 text-sm"
		{disabled}
	>
		<span class="truncate text-left">{selectedLabel}</span>
		<ChevronDownIcon class="ml-2 size-4 shrink-0 text-muted-foreground" />
	</DropdownMenuTrigger>

	<DropdownMenuContent align="start" class="w-[min(20rem,calc(100vw-2rem))] p-2">
		<div class="mb-2 flex items-center justify-between gap-2 text-xs">
			<button
				type="button"
				class="rounded px-2 py-1 text-muted-foreground hover:bg-muted"
				onclick={selectAll}
				disabled={options.length === 0}
			>
				Select all
			</button>
			<button
				type="button"
				class="rounded px-2 py-1 text-muted-foreground hover:bg-muted"
				onclick={clearAll}
				disabled={selectedCount === 0}
			>
				Clear
			</button>
		</div>

		<div class="max-h-60 space-y-1 overflow-y-auto">
			{#if options.length === 0}
				<p class="px-2 py-1 text-xs text-muted-foreground">No options available</p>
			{:else}
				{#each options as option}
					<label
						class="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted"
					>
						<input
							type="checkbox"
							checked={selected.includes(option.value)}
							onchange={(event) =>
								toggle(option.value, (event.currentTarget as HTMLInputElement).checked)}
						/>
						<span class="truncate">{option.label}</span>
					</label>
				{/each}
			{/if}
		</div>
	</DropdownMenuContent>
</DropdownMenu>
