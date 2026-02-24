<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';

	export let label: string;
	export let value: string | number;
	export let deltaLabel: string;
	export let deltaPct: string;
	export let trend: 'up' | 'down' | 'flat' = 'flat';
	export let points: number[] = [];

	function buildPolyline(values: number[]): string {
		if (!values.length) return '0,16 120,16';
		if (values.length === 1) return `0,16 120,16`;

		const min = Math.min(...values);
		const max = Math.max(...values);
		const span = max - min || 1;
		const width = 120;
		const height = 32;
		const step = width / (values.length - 1);

		return values
			.map((value, index) => {
				const x = index * step;
				const normalized = (value - min) / span;
				const y = height - normalized * (height - 3) - 1;
				return `${x.toFixed(1)},${y.toFixed(1)}`;
			})
			.join(' ');
	}

	$: polyline = buildPolyline(points);

	$: deltaClass =
		trend === 'up'
			? 'bg-emerald-100 text-emerald-700'
			: trend === 'down'
				? 'bg-rose-100 text-rose-700'
				: 'bg-muted text-muted-foreground';
</script>

<Card.Root>
	<Card.Header class="space-y-3 pb-2">
		<div class="flex items-start justify-between gap-2">
			<Card.Description class="text-sm">{label}</Card.Description>
			<Badge class={deltaClass}>{deltaLabel} {deltaPct}</Badge>
		</div>
		<Card.Title class="text-2xl">{value}</Card.Title>
	</Card.Header>
	<Card.Content class="space-y-2">
		<svg viewBox="0 0 120 32" class="h-8 w-full text-muted-foreground">
			<polyline
				points={polyline}
				fill="none"
				stroke="currentColor"
				stroke-width="1.75"
				stroke-linecap="round"
				stroke-linejoin="round"
			/>
		</svg>
		<p class="text-xs text-muted-foreground">MTD</p>
	</Card.Content>
</Card.Root>
