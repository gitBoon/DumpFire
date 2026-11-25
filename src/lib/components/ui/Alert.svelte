<!--
  Alert.svelte — The UI kit's alert (card 3074): a boxed message in the page,
  its icon, its `title` and its body (the children).

  `variant`: default, info, success, warning, destructive; each has its own
  icon unless given one (`icon`). `live`: it says something that has just
  happened, and is announced: `role="alert"`. A message that is simply on
  the page has no role, so it is not read out again on every change.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		variant = 'default',
		live = false,
		title,
		icon,
		class: className = '',
		children,
		...rest
	}: {
		variant?: 'default' | 'info' | 'success' | 'warning' | 'destructive';
		live?: boolean;
		title?: Snippet;
		icon?: Snippet;
		class?: string;
		children?: Snippet;
		id?: string;
		[attribute: `data-${string}`]: unknown;
		[attribute: `aria-${string}`]: unknown;
	} = $props();
</script>

<div {...rest} class={['ui-alert', `ui-alert-${variant}`, className]} role={live ? 'alert' : undefined}>
	<span class="ui-alert-icon" aria-hidden="true">
		{#if icon}
			{@render icon()}
		{:else}
			<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
				{#if variant === 'success'}
					<circle cx="8" cy="8" r="6.25" /><path d="M5.5 8.2l1.7 1.7 3.3-3.6" />
				{:else if variant === 'warning'}
					<path d="M8 2.2l6.1 10.6a.6.6 0 01-.5.9H2.4a.6.6 0 01-.5-.9L8 2.2z" /><path d="M8 6.5v3" /><path d="M8 11.6h.01" />
				{:else if variant === 'destructive'}
					<circle cx="8" cy="8" r="6.25" /><path d="M8 4.9v3.6" /><path d="M8 11h.01" />
				{:else}
					<circle cx="8" cy="8" r="6.25" /><path d="M8 7.4v3.6" /><path d="M8 5h.01" />
				{/if}
			</svg>
		{/if}
	</span>
	<div class="ui-alert-text">
		{#if title}<p class="ui-alert-title">{@render title()}</p>{/if}
		{#if children}<div class="ui-alert-body">{@render children()}</div>{/if}
	</div>
</div>

<style>
	.ui-alert {
		display: grid;
		grid-template-columns: 1rem minmax(0, 1fr);
		gap: 0.25rem 0.75rem;
		align-items: start;
		padding: 0.75rem 1rem;
		border: 1px solid var(--ui-border);
		border-radius: var(--ui-radius-lg);
		background: var(--ui-card);
		color: var(--ui-foreground);
		font-size: 0.875rem;
		line-height: 1.5;
	}
	.ui-alert-icon {
		display: flex;
		height: 1.3125rem;
		align-items: center;
		color: var(--ui-muted-foreground);
	}
	.ui-alert-text {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		min-width: 0;
	}
	.ui-alert-title {
		margin: 0;
		font-weight: 500;
		letter-spacing: -0.005em;
	}
	.ui-alert-body {
		color: var(--ui-muted-foreground);
	}

	.ui-alert-info {
		border-color: color-mix(in srgb, var(--ui-info) 35%, transparent);
		background: color-mix(in srgb, var(--ui-info) 6%, var(--ui-background));
	}
	.ui-alert-info .ui-alert-icon {
		color: var(--ui-info);
	}
	.ui-alert-success {
		border-color: color-mix(in srgb, var(--ui-success) 35%, transparent);
		background: color-mix(in srgb, var(--ui-success) 6%, var(--ui-background));
	}
	.ui-alert-success .ui-alert-icon {
		color: var(--ui-success);
	}
	.ui-alert-warning {
		border-color: color-mix(in srgb, var(--ui-warning) 40%, transparent);
		background: color-mix(in srgb, var(--ui-warning) 7%, var(--ui-background));
	}
	.ui-alert-warning .ui-alert-icon {
		color: var(--ui-warning);
	}
	.ui-alert-destructive {
		border-color: color-mix(in srgb, var(--ui-destructive) 40%, transparent);
		background: color-mix(in srgb, var(--ui-destructive) 6%, var(--ui-background));
	}
	/* The icon carries the tone; the words stay in the text colours, which read in every theme. */
	.ui-alert-destructive .ui-alert-icon {
		color: var(--ui-destructive);
	}
</style>
