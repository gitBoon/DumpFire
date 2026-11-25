<!--
  EmptyState.svelte — What a list says when it has nothing in it (card 3074):
  an icon (a snippet), a `title` (a heading, h2 unless given a `level`), a line or two (the children) and, in
  `action`, the way on (a Button, a link).
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		title,
		level = 2,
		icon,
		action,
		children,
		...rest
	}: {
		title: string;
		/** The title's heading level, under the page's own headings. */
		level?: 2 | 3 | 4;
		icon?: Snippet;
		action?: Snippet;
		children?: Snippet;
		id?: string;
		[attribute: `data-${string}`]: unknown;
		[attribute: `aria-${string}`]: unknown;
	} = $props();
</script>

<div {...rest} class="ui-empty">
	{#if icon}<div class="ui-empty-icon" aria-hidden="true">{@render icon()}</div>{/if}
	<svelte:element this={`h${level}`} class="ui-empty-title">{title}</svelte:element>
	{#if children}<div class="ui-empty-body">{@render children()}</div>{/if}
	{#if action}<div class="ui-empty-action">{@render action()}</div>{/if}
</div>

<style>
	.ui-empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5rem;
		padding: 3rem 1.5rem;
		border: 1px dashed var(--ui-border);
		border-radius: var(--ui-radius-lg);
		text-align: center;
	}
	.ui-empty-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.75rem;
		height: 2.75rem;
		margin-bottom: 0.25rem;
		border-radius: var(--ui-radius-lg);
		background: var(--ui-muted);
		color: var(--ui-muted-foreground);
		font-size: 1.25rem;
	}
	.ui-empty-title {
		margin: 0;
		font-size: 1rem;
		font-weight: 600;
		letter-spacing: -0.01em;
		color: var(--ui-foreground);
	}
	.ui-empty-body {
		max-width: 28rem;
		font-size: 0.875rem;
		line-height: 1.5;
		color: var(--ui-muted-foreground);
	}
	.ui-empty-action {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: var(--space-sm);
		margin-top: 0.75rem;
	}
</style>
