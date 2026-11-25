<!--
  CardDescription.svelte — The line under a card's title (card 3074).
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	let { children }: { children?: Snippet } = $props();
</script>

<p class="ui-card-description">{@render children?.()}</p>

<style>
	.ui-card-description {
		margin: 0;
		font-size: 0.875rem;
		line-height: 1.45;
		color: var(--ui-muted-foreground);
	}
</style>
