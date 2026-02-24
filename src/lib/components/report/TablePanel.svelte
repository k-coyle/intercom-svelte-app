<script lang="ts">
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import MoreHorizontalIcon from '@lucide/svelte/icons/more-horizontal';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import type { TableColumn } from './engagementReportConfig';

	export let title: string;
	export let columns: TableColumn[] = [];
	export let rows: Record<string, any>[] = [];
	export let footerText: string = 'Showing 1-50 of 120 entries';
</script>

<Card.Root>
	<Card.Header class="pb-3">
		<Card.Title class="text-base">{title}</Card.Title>
	</Card.Header>
	<Card.Content class="space-y-3">
		<div class="overflow-x-auto">
			<table class="w-full border-collapse">
				<thead>
					<tr class="border-b">
						{#each columns as column}
							<th
								class={`px-2 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground ${column.className ?? ''}`}
							>
								{column.header}
							</th>
						{/each}
					</tr>
				</thead>
				<tbody>
					{#if rows.length}
						{#each rows as row}
							<tr class="border-b text-sm transition-colors hover:bg-muted/40">
								{#each columns as column}
									<td class={`px-2 py-2 ${column.className ?? ''}`}>
										{#if column.key === '__actions'}
											<div class="flex justify-end">
												<Button size="icon" variant="ghost">
													<MoreHorizontalIcon class="size-4" />
												</Button>
											</div>
										{:else}
											{row[column.key] ?? '-'}
										{/if}
									</td>
								{/each}
							</tr>
						{/each}
					{:else}
						<tr>
							<td colspan={columns.length} class="px-2 py-8 text-center text-sm text-muted-foreground">
								No rows available.
							</td>
						</tr>
					{/if}
				</tbody>
			</table>
		</div>

		<div class="flex items-center justify-between gap-2 text-xs text-muted-foreground">
			<span>{footerText}</span>
			<div class="flex items-center gap-1">
				<Button size="icon" variant="ghost">
					<ChevronLeftIcon class="size-4" />
				</Button>
				<Button size="icon" variant="ghost">
					<ChevronRightIcon class="size-4" />
				</Button>
			</div>
		</div>
	</Card.Content>
</Card.Root>
