<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import {
		comparisonTone,
		computeKpiComparison,
		formatSignedNumber,
		type ComparisonTrend
	} from '$lib/client/sd-report-utils';

	export let title = '';
	export let value = 0;
	export let valueLabel = '';
	export let comparisonEnabled = false;
	export let comparisonValue: number | null = null;
	export let comparisonTrend: ComparisonTrend = 'higher_is_better';
	export let valueFractionDigits = 0;
	export let deltaFractionDigits = 0;

	$: numericValue = Number.isFinite(Number(value)) ? Number(value) : 0;
	$: comparison =
		comparisonEnabled && comparisonValue != null ? computeKpiComparison(numericValue, comparisonValue) : null;
	$: tone = comparison ? comparisonTone(comparison.delta, comparisonTrend) : 'neutral';
	$: toneClass =
		tone === 'positive'
			? 'text-emerald-700'
			: tone === 'negative'
				? 'text-red-700'
				: 'text-muted-foreground';
</script>

<Card.Root>
	<Card.Header class="pb-2">
		<Card.Description>{title}</Card.Description>
		<Card.Title class="text-3xl">{numericValue.toFixed(valueFractionDigits)}</Card.Title>
		{#if valueLabel}
			<p class="text-xs text-muted-foreground">{valueLabel}</p>
		{/if}
		{#if comparison}
			<p class={`text-xs font-medium ${toneClass}`}>
				{formatSignedNumber(comparison.delta, deltaFractionDigits)}
				{#if comparison.pctChange != null}
					<span class="ml-1">({formatSignedNumber(comparison.pctChange, 1)}%)</span>
				{:else}
					<span class="ml-1">(n/a %)</span>
				{/if}
				<span class="ml-1 text-muted-foreground">vs comparison</span>
			</p>
		{/if}
	</Card.Header>
</Card.Root>
