<!--
  CardContent.svelte — A card's body (card 3074).
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	let { children }: { children?: Snippet } = $props();
</script>

<div class="ui-card-content">{@render children?.()}</div>

<style>
	.ui-card-content {
		padding: 0 1.25rem;
		font-size: 0.875rem;
		min-width: 0;
	}
</style>
