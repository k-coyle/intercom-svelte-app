<script lang="ts">
	export let title: string;
	export let registeredCount: number = 0;
	export let withQualifyingSessionCount: number = 0;
	export let pct: number | null = null;
	export let colorVar: string = 'var(--color-chart-1)';

	$: safePct = Number.isFinite(pct) && pct != null ? Math.max(0, Math.min(100, pct)) : 0;
	$: pctLabel = pct == null ? 'n/a' : `${safePct.toFixed(1)}%`;
</script>

<div class="space-y-2 rounded-md border bg-muted/10 p-3">
	<p class="text-xs font-medium text-muted-foreground">{title}</p>

	<div
		class="relative mx-auto size-32 rounded-full"
		style={`background: conic-gradient(${colorVar} ${safePct}%, var(--muted) 0);`}
	>
		<div class="absolute inset-[14px] rounded-full bg-background"></div>
		<div class="absolute inset-0 flex flex-col items-center justify-center text-center">
			<p class="text-lg font-semibold">{pctLabel}</p>
			<p class="text-[11px] text-muted-foreground">Converted</p>
		</div>
	</div>

	<p class="text-center text-xs text-muted-foreground">
		{withQualifyingSessionCount} / {registeredCount} newly registered members
	</p>
</div>
