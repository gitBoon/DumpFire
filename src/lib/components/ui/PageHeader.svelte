<!--
  PageHeader.svelte — The top of a page's content, under the shell's header
  (card 3074): the page's <h1>, a line saying what the page is for, and the
  page's main actions in a row at the right (under it on a phone). Anything
  else (the children) goes below, such as the page's tabs.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		title,
		description,
		actions,
		children
	}: {
		title: string;
		description?: string;
		actions?: Snippet;
		children?: Snippet;
	} = $props();
</script>

<div class="ui-page-header">
	<div class="ui-page-header-row">
		<div class="ui-page-header-text">
			<h1 class="ui-page-title">{title}</h1>
			{#if description}<p class="ui-page-description">{description}</p>{/if}
		</div>
		{#if actions}<div class="ui-page-header-actions">{@render actions()}</div>{/if}
	</div>
	{@render children?.()}
</div>

<style>
	.ui-page-header {
		display: flex;
		flex-direction: column;
		gap: var(--space-lg);
		margin-bottom: var(--space-xl);
	}
	.ui-page-header-row {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		justify-content: space-between;
		gap: var(--space-md) var(--space-xl);
	}
	.ui-page-header-text {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		min-width: 0;
	}
	.ui-page-title {
		margin: 0;
		font-size: 1.625rem;
		font-weight: 600;
		line-height: 1.2;
		letter-spacing: -0.025em;
		color: var(--ui-foreground);
	}
	.ui-page-description {
		margin: 0;
		max-width: 48rem;
		font-size: 0.9375rem;
		line-height: 1.5;
		color: var(--ui-muted-foreground);
	}
	.ui-page-header-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-sm);
	}

	@media (max-width: 640px) {
		.ui-page-title {
			font-size: 1.375rem;
		}
	}
</style>
