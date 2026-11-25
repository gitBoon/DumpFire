<!--
  CardTitle.svelte — A card's title (card 3074): a heading, h3 unless the
  page's outline needs another `level`.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	let { level = 3, id, children }: { level?: 2 | 3 | 4; id?: string; children?: Snippet } = $props();
</script>

<svelte:element this={`h${level}`} class="ui-card-title" {id}>{@render children?.()}</svelte:element>

<style>
	.ui-card-title {
		margin: 0;
		font-size: 1rem;
		font-weight: 600;
		line-height: 1.3;
		letter-spacing: -0.01em;
		color: var(--ui-foreground);
	}
</style>
