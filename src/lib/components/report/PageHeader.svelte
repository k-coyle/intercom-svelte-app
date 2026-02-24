<script lang="ts">
	export let title: string;
	export let subtitle: string | undefined = undefined;
</script>

<div class="flex flex-wrap items-start justify-between gap-3">
	<div class="space-y-1">
		<h2 class="text-xl font-semibold tracking-tight">{title}</h2>
		{#if subtitle}
			<p class="text-sm text-muted-foreground">{subtitle}</p>
		{/if}
	</div>
	<div class="flex items-center gap-2">
		<slot name="actions" />
	</div>
</div>
