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
	export let footerText: string = 'No rows available.';
	export let pageSize = 20;

	let pageIndex = 0;

	$: safePageSize = Math.max(1, Math.floor(pageSize));
	$: totalRows = rows.length;
	$: totalPages = totalRows > 0 ? Math.ceil(totalRows / safePageSize) : 1;
	$: maxPageIndex = Math.max(0, totalPages - 1);
	$: if (pageIndex > maxPageIndex) pageIndex = maxPageIndex;
	$: if (pageIndex < 0) pageIndex = 0;
	$: start = pageIndex * safePageSize;
	$: endExclusive = Math.min(totalRows, start + safePageSize);
	$: visibleRows = rows.slice(start, endExclusive);
	$: computedFooterText =
		totalRows > 0 ? `Showing ${start + 1}-${endExclusive} of ${totalRows} entries` : footerText;

	function goPrevPage() {
		pageIndex = Math.max(0, pageIndex - 1);
	}

	function goNextPage() {
		pageIndex = Math.min(maxPageIndex, pageIndex + 1);
	}
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
					{#if visibleRows.length}
						{#each visibleRows as row}
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
			<span>{computedFooterText}</span>
			<div class="flex items-center gap-1">
				<Button size="icon" variant="ghost" disabled={pageIndex === 0} onclick={goPrevPage}>
					<ChevronLeftIcon class="size-4" />
				</Button>
				<Button size="icon" variant="ghost" disabled={pageIndex >= maxPageIndex} onclick={goNextPage}>
					<ChevronRightIcon class="size-4" />
				</Button>
			</div>
		</div>
	</Card.Content>
</Card.Root>
