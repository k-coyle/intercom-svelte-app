<script lang="ts">
	import KpiRow from './KpiRow.svelte';
	import PageHeader from './PageHeader.svelte';
	import PanelCard from './PanelCard.svelte';
	import TablePanel from './TablePanel.svelte';
	import TrendPanel from './TrendPanel.svelte';
	import {
		engagementReportConfig,
		type EngagementReportLayout,
		type KpiItem,
		type ReportKey
	} from './engagementReportConfig';

	export let reportKey: ReportKey = 'overview';
	export let topKpisOverride: KpiItem[] | null = null;

	$: config = engagementReportConfig[reportKey] as EngagementReportLayout;
</script>

<div class="space-y-4">
	<PageHeader title={config.pageTitle} subtitle={config.pageSubtitle} />

	<KpiRow items={topKpisOverride ?? config.topKpis} />

	<div class="grid gap-4 lg:grid-cols-2">
		<PanelCard title={config.midLeftPanel.title}>
			{#if config.midLeftPanel.kind === 'trend'}
				<TrendPanel
					title={config.midLeftPanel.title}
					timeframe={config.midLeftPanel.timeframe ?? 'Last 30 days'}
				/>
			{:else}
				<ul class="space-y-2 text-sm text-muted-foreground">
					{#each config.midLeftPanel.lines as line}
						<li>{line}</li>
					{/each}
				</ul>
			{/if}
		</PanelCard>

		<PanelCard title={config.midRightPanel.title}>
			{#if config.midRightPanel.kind === 'trend'}
				<TrendPanel
					title={config.midRightPanel.title}
					timeframe={config.midRightPanel.timeframe ?? 'Last 30 days'}
				/>
			{:else}
				<ul class="space-y-2 text-sm text-muted-foreground">
					{#each config.midRightPanel.lines as line}
						<li>{line}</li>
					{/each}
				</ul>
			{/if}
		</PanelCard>
	</div>

	<div class="grid gap-4 lg:grid-cols-2">
		<PanelCard title={config.bottomLeftPanel.title}>
			<ul class="space-y-2 text-sm text-muted-foreground">
				{#each config.bottomLeftPanel.lines as line}
					<li>{line}</li>
				{/each}
			</ul>
		</PanelCard>

		<TablePanel
			title={config.bottomRightTable.title}
			columns={config.bottomRightTable.columns}
			rows={config.bottomRightTable.rows}
			footerText={config.bottomRightTable.footerText ?? 'Showing 1-50 of 120 entries'}
		/>
	</div>
</div>
