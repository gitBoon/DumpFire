<!--
  Badge.svelte — The UI kit's badge (card 3074): a short label, a status, a
  count.

  `variant`: default, secondary, outline, destructive, success, warning, info.
  `status`: a decision's shown status, which picks the variant (draft
  secondary, open info, awaiting_ruling warning, ruled success, superseded
  and withdrawn outline; one not known, default) and, with no children, the
  words (STATUS_WORDS). It is kept as `data-status`, which pages and tests
  read the status by.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { STATUS_WORDS } from '$lib/decision-words';

	type Variant = 'default' | 'secondary' | 'outline' | 'destructive' | 'success' | 'warning' | 'info';

	/** Each decision status's look. */
	const STATUS_VARIANTS: Readonly<Record<string, Variant>> = {
		draft: 'secondary',
		open: 'info',
		awaiting_ruling: 'warning',
		ruled: 'success',
		superseded: 'outline',
		withdrawn: 'outline'
	};

	let {
		variant,
		status,
		class: className = '',
		children,
		...rest
	}: {
		variant?: Variant;
		status?: string;
		class?: string;
		children?: Snippet;
		id?: string;
		title?: string;
		[attribute: `data-${string}`]: unknown;
		[attribute: `aria-${string}`]: unknown;
	} = $props();

	const shown = $derived<Variant>(variant ?? (status !== undefined ? (STATUS_VARIANTS[status] ?? 'default') : 'default'));
</script>

<span {...rest} class={['ui-badge', `ui-badge-${shown}`, className]} data-status={status}>
	{#if children}{@render children()}{:else if status !== undefined}{STATUS_WORDS[status] ?? status}{/if}
</span>

<style>
	.ui-badge {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		width: fit-content;
		padding: 0.125rem 0.5rem;
		border: 1px solid transparent;
		border-radius: var(--ui-radius-sm);
		font-size: 0.75rem;
		font-weight: 500;
		line-height: 1.35;
		white-space: nowrap;
		vertical-align: middle;
	}

	.ui-badge-default {
		background: var(--ui-primary);
		color: var(--ui-primary-foreground);
	}
	.ui-badge-secondary {
		background: var(--ui-muted);
		color: var(--ui-foreground);
	}
	.ui-badge-outline {
		border-color: var(--ui-input);
		color: var(--ui-foreground);
	}
	/*
	 * The tones: a faint fill and edge in the tone, and a dot of it before the
	 * words; the words themselves in the text colour, which reads in every theme.
	 */
	.ui-badge-destructive,
	.ui-badge-success,
	.ui-badge-warning,
	.ui-badge-info {
		color: var(--ui-foreground);
	}
	.ui-badge-destructive::before,
	.ui-badge-success::before,
	.ui-badge-warning::before,
	.ui-badge-info::before {
		content: '';
		flex-shrink: 0;
		width: 0.375rem;
		height: 0.375rem;
		border-radius: var(--radius-full);
		background: var(--badge-tone);
	}
	.ui-badge-destructive {
		--badge-tone: var(--ui-destructive);
		background: color-mix(in srgb, var(--ui-destructive) 12%, transparent);
		border-color: color-mix(in srgb, var(--ui-destructive) 35%, transparent);
	}
	.ui-badge-success {
		--badge-tone: var(--ui-success);
		background: color-mix(in srgb, var(--ui-success) 12%, transparent);
		border-color: color-mix(in srgb, var(--ui-success) 35%, transparent);
	}
	.ui-badge-warning {
		--badge-tone: var(--ui-warning);
		background: color-mix(in srgb, var(--ui-warning) 14%, transparent);
		border-color: color-mix(in srgb, var(--ui-warning) 40%, transparent);
	}
	.ui-badge-info {
		--badge-tone: var(--ui-info);
		background: color-mix(in srgb, var(--ui-info) 12%, transparent);
		border-color: color-mix(in srgb, var(--ui-info) 35%, transparent);
	}
</style>
