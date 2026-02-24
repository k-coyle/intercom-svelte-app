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
		type TableColumn,
		type ReportKey
	} from './engagementReportConfig';

	export let reportKey: ReportKey = 'overview';
	export let disableFallback: boolean = false;
	export let topKpisOverride: KpiItem[] | null = null;
	export let bottomLeftLinesOverride: string[] | null = null;
	export let bottomRightTableOverride: {
		title?: string;
		columns?: TableColumn[];
		rows?: Record<string, any>[];
		footerText?: string;
	} | null = null;

	$: config = engagementReportConfig[reportKey] as EngagementReportLayout;
	$: blankKpis = config.topKpis.map((kpi) => ({
		label: kpi.label,
		value: '--',
		deltaLabel: '--',
		deltaPct: '--',
		trend: 'flat' as const,
		points: []
	}));
	$: effectiveTopKpis = topKpisOverride ?? (disableFallback ? blankKpis : config.topKpis);
	$: bottomLeftLines = bottomLeftLinesOverride ?? (disableFallback ? [] : config.bottomLeftPanel.lines);
	$: tableConfig = {
		title: bottomRightTableOverride?.title ?? config.bottomRightTable.title,
		columns: bottomRightTableOverride?.columns ?? config.bottomRightTable.columns,
		rows: bottomRightTableOverride?.rows ?? (disableFallback ? [] : config.bottomRightTable.rows),
		footerText:
			bottomRightTableOverride?.footerText ??
			(disableFallback ? 'No data loaded.' : config.bottomRightTable.footerText)
	};
</script>

<div class="space-y-4">
	<PageHeader title={config.pageTitle} subtitle={config.pageSubtitle} />

	<KpiRow items={effectiveTopKpis} />

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
				{#each bottomLeftLines as line}
					<li>{line}</li>
				{/each}
			</ul>
		</PanelCard>

		<TablePanel
			title={tableConfig.title}
			columns={tableConfig.columns}
			rows={tableConfig.rows}
			footerText={tableConfig.footerText ?? 'Showing 1-50 of 120 entries'}
		/>
	</div>
</div>
