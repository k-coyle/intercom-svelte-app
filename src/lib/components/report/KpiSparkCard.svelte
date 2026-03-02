<script lang="ts">
	import * as Card from '$lib/components/ui/card';

	export let label: string;
	export let value: string | number;
	export let deltaLabel: string;
	export let deltaPct: string;
	export let trend: 'up' | 'down' | 'flat' = 'flat';
	export let showDelta = false;

	$: deltaClass =
		trend === 'up'
			? 'text-emerald-700'
			: trend === 'down'
				? 'text-rose-700'
				: 'text-muted-foreground';

	$: deltaText =
		deltaLabel && deltaPct ? `${deltaLabel}, ${deltaPct}` : (deltaLabel || deltaPct || '');
</script>

<Card.Root>
	<Card.Header class="space-y-1 pb-3 text-center">
		<Card.Description class="text-sm">{label}</Card.Description>
		<Card.Title class="text-3xl leading-none">{value}</Card.Title>
	</Card.Header>
	{#if showDelta}
		<Card.Content class="pt-0 text-center">
			<p class={`text-sm font-medium ${deltaClass}`}>{deltaText}</p>
		</Card.Content>
	{/if}
</Card.Root>
