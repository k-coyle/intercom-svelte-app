<script lang="ts">
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';

	export let loading: boolean = false;
	export let error: string | null = null;
	export let progressText: string | null = null;

	$: visible = loading || Boolean(error);
</script>

{#if visible}
	<div
		class={`rounded-md border px-3 py-2 text-sm ${
			error ? 'border-destructive/40 text-destructive' : 'border-border text-muted-foreground'
		}`}
	>
		<div class="flex items-center gap-2">
			{#if error}
				<TriangleAlertIcon class="size-4 shrink-0" />
				<span>{error}</span>
			{:else}
				<LoaderCircleIcon class="size-4 shrink-0 animate-spin" />
				<span>{progressText ?? 'Loading report data...'}</span>
			{/if}
		</div>
		{#if loading}
			<div class="mt-2 h-1 w-full overflow-hidden rounded bg-muted">
				<div class="h-full w-1/3 animate-pulse bg-foreground/50"></div>
			</div>
		{/if}
	</div>
{/if}
