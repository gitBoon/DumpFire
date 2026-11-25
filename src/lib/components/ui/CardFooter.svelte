<!--
  CardFooter.svelte — A card's foot (card 3074): its buttons, in a row.
  `align="end"` puts them at the right.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	let { align = 'start', children }: { align?: 'start' | 'end' | 'between'; children?: Snippet } = $props();
</script>

<div class={['ui-card-footer', `ui-card-footer-${align}`]}>{@render children?.()}</div>

<style>
	.ui-card-footer {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-sm);
		padding: 0 1.25rem;
	}
	.ui-card-footer-end {
		justify-content: flex-end;
	}
	.ui-card-footer-between {
		justify-content: space-between;
	}
</style>
