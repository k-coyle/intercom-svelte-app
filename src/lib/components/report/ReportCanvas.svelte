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
	export let hideMidLeftPanel: boolean = false;
	export let hideMidRightPanel: boolean = false;
	export let hideBottomLeftPanel: boolean = false;
	export let topKpisOverride: KpiItem[] | null = null;
	export let pageSubtitleOverride: string | null = null;
	export let pageMetaLinesOverride: string[] | null = null;
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
	$: showKpiDeltas = reportKey === 'overview' || reportKey === 'billing';
	$: showMidLeftPanel = !hideMidLeftPanel;
	$: showMidRightPanel = !hideMidRightPanel;
	$: showBottomLeftPanel = !hideBottomLeftPanel;
	$: pageSubtitle = pageSubtitleOverride ?? config.pageSubtitle;
	$: pageMetaLines = pageMetaLinesOverride ?? [];
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
	<PageHeader title={config.pageTitle} subtitle={pageSubtitle} />
	{#if pageMetaLines.length > 0}
		<div class="rounded-md border bg-muted/15 px-3 py-2">
			<div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
				{#each pageMetaLines as line}
					<p>{line}</p>
				{/each}
			</div>
		</div>
	{/if}

	<KpiRow items={effectiveTopKpis} showDelta={showKpiDeltas} />

	<div class={`grid gap-4 ${showMidLeftPanel && showMidRightPanel ? 'lg:grid-cols-2' : 'grid-cols-1'}`}>
		{#if showMidLeftPanel}
			<PanelCard title={config.midLeftPanel.title}>
				{#if $$slots.midLeft}
					<slot name="midLeft" />
				{:else if config.midLeftPanel.kind === 'trend'}
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
		{/if}

		{#if showMidRightPanel}
			<PanelCard title={config.midRightPanel.title}>
				{#if $$slots.midRight}
					<slot name="midRight" />
				{:else if config.midRightPanel.kind === 'trend'}
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
		{/if}
	</div>

	<div class="space-y-4">
		{#if showBottomLeftPanel}
			<PanelCard title={config.bottomLeftPanel.title}>
				{#if $$slots.bottomLeft}
					<slot name="bottomLeft" />
				{:else}
					<ul class="space-y-2 text-sm text-muted-foreground">
						{#each bottomLeftLines as line}
							<li>{line}</li>
						{/each}
					</ul>
				{/if}
			</PanelCard>
		{/if}

		{#if reportKey !== 'overview'}
			<TablePanel
				title={tableConfig.title}
				columns={tableConfig.columns}
				rows={tableConfig.rows}
				footerText={tableConfig.footerText ?? 'No rows available.'}
				pageSize={20}
			/>
		{/if}
	</div>
</div>
