<script lang="ts">
	import * as Card from '$lib/components/ui/card';

	export let title: string;
</script>

<Card.Root>
	<Card.Header class="pb-3">
		<div class="flex items-center justify-between gap-2">
			<Card.Title class="text-base">{title}</Card.Title>
			<slot name="right" />
		</div>
	</Card.Header>
	<Card.Content>
		<slot />
	</Card.Content>
</Card.Root>
