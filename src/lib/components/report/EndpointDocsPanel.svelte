<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';

	type EndpointDoc = {
		method: 'GET' | 'POST';
		path: string;
		summary: string;
		arguments?: string[];
		notes?: string;
	};

	type EndpointSection = {
		title: string;
		items: EndpointDoc[];
	};

	export let intro: string =
		'Operational and export endpoints used by reporting jobs. These routes are not directly rendered as report pages.';
	export let sections: EndpointSection[] = [];

	function methodVariant(method: EndpointDoc['method']): 'default' | 'secondary' {
		return method === 'GET' ? 'secondary' : 'default';
	}
</script>

<div class="space-y-4">
	<p class="text-sm text-muted-foreground">{intro}</p>

	{#each sections as section}
		<section class="space-y-2">
			<p class="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
				{section.title}
			</p>
			<div class="space-y-2">
				{#each section.items as endpoint}
					<article class="space-y-2 rounded-lg border bg-muted/10 p-3">
						<div class="flex flex-wrap items-center gap-2">
							<Badge variant={methodVariant(endpoint.method)}>{endpoint.method}</Badge>
							<code class="rounded bg-muted px-2 py-0.5 font-mono text-xs">{endpoint.path}</code>
						</div>

						<p class="text-sm leading-5 text-foreground">{endpoint.summary}</p>

						{#if endpoint.arguments && endpoint.arguments.length > 0}
							<div class="flex flex-wrap gap-1.5">
								{#each endpoint.arguments as arg}
									<span class="rounded border bg-background px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
										{arg}
									</span>
								{/each}
							</div>
						{/if}

						{#if endpoint.notes}
							<p class="text-xs leading-5 text-muted-foreground">{endpoint.notes}</p>
						{/if}
					</article>
				{/each}
			</div>
		</section>
	{/each}
</div>
