<!--
  CardHeader.svelte — A card's head (card 3074): its title and description,
  and, in `actions`, what acts on the card, at the right.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	let { actions, children }: { actions?: Snippet; children?: Snippet } = $props();
</script>

<div class="ui-card-header">
	<div class="ui-card-header-text">{@render children?.()}</div>
	{#if actions}<div class="ui-card-header-actions">{@render actions()}</div>{/if}
</div>

<style>
	/* The actions wrap under the title where the card is too narrow for both on one line (card 3076). */
	.ui-card-header {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--space-sm) var(--space-md);
		padding: 0 1.25rem;
	}
	.ui-card-header-text {
		display: flex;
		flex: 1 1 16rem;
		flex-direction: column;
		gap: 0.375rem;
		min-width: 0;
	}
	.ui-card-header-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-sm);
		max-width: 100%;
	}
</style>
