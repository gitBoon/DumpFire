<!--
  Button.svelte — The UI kit's button (card 3074), in shadcn's anatomy.

  A link where it is given an `href`, and a button otherwise, `type="button"`
  unless given another: a button in a form submits only when it says so.
  `data-*`, `aria-*`, `id`, `title`, `tabindex` and `onclick` go on through
  to either; `target`, `rel` and `download` to a link alone, and `name`,
  `value` and `form` to a button alone.

  `variant`: default (the primary action), secondary, outline, ghost,
  destructive, link. `size`: sm (36px), default (40px), lg (44px), icon
  (40px square; give it an `aria-label`). Under a coarse pointer (a touch
  screen) every size is at least 44px high.

  `highlight`: the one primary action of a page. A faint sheen crosses it
  twice as the page opens, then stops; none where the reader asks for less
  motion.

  A link cannot be disabled: a disabled one is drawn as disabled, has no
  `href` and no `onclick`, so it goes nowhere and does nothing. A disabled
  button keeps its `title`, which says why.

  `bind:ref` (card 3075): the element drawn, the button or the link, for a
  page that puts the focus back on it after a dialog or a refusal.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	type Variant = 'default' | 'secondary' | 'outline' | 'ghost' | 'destructive' | 'link';
	type Size = 'sm' | 'default' | 'lg' | 'icon';

	let {
		ref = $bindable(null),
		variant = 'default',
		size = 'default',
		highlight = false,
		href,
		type = 'button',
		disabled = false,
		class: className = '',
		onclick,
		target,
		rel,
		download,
		name,
		value,
		form,
		children,
		...rest
	}: {
		/** The element drawn, with `bind:ref`. */
		ref?: HTMLButtonElement | HTMLAnchorElement | null;
		variant?: Variant;
		size?: Size;
		highlight?: boolean;
		/** Makes it a link. */
		href?: string;
		type?: 'button' | 'submit' | 'reset';
		disabled?: boolean;
		class?: string;
		children?: Snippet;
		onclick?: (event: MouseEvent) => void;
		/** A link's. */
		target?: string;
		rel?: string;
		download?: string | boolean;
		/** A button's. */
		name?: string;
		value?: string;
		form?: string;
		id?: string;
		title?: string;
		tabindex?: number;
		[attribute: `data-${string}`]: unknown;
		[attribute: `aria-${string}`]: unknown;
	} = $props();

	const classes = $derived(['ui-btn', `ui-btn-${variant}`, `ui-btn-size-${size}`, highlight && 'ui-btn-highlight', className]);
</script>

{#if href !== undefined}
	<a
		bind:this={ref}
		{...rest}
		class={classes}
		href={disabled ? undefined : href}
		{target}
		{rel}
		{download}
		aria-disabled={disabled ? 'true' : undefined}
		role={disabled ? 'link' : undefined}
		tabindex={disabled ? -1 : rest.tabindex}
		onclick={disabled ? undefined : onclick}
	>
		{@render children?.()}
	</a>
{:else}
	<button bind:this={ref} {...rest} class={classes} {type} {disabled} {name} {value} {form} {onclick}>
		{@render children?.()}
	</button>
{/if}

<style>
	.ui-btn {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		flex-shrink: 0;
		height: 2.5rem;
		padding: 0 1rem;
		border: 1px solid transparent;
		border-radius: var(--ui-radius);
		font-family: var(--font-family);
		font-size: 0.875rem;
		font-weight: 500;
		line-height: 1;
		white-space: nowrap;
		text-decoration: none;
		cursor: pointer;
		user-select: none;
		transition:
			background-color var(--duration-fast) var(--ease-out),
			border-color var(--duration-fast) var(--ease-out),
			color var(--duration-fast) var(--ease-out),
			box-shadow var(--duration-fast) var(--ease-out),
			transform var(--duration-fast) var(--ease-out);
	}
	.ui-btn:focus-visible {
		outline: 2px solid var(--ui-ring);
		outline-offset: 2px;
	}
	.ui-btn:active:not(:disabled):not([aria-disabled='true']) {
		transform: translateY(0.5px) scale(0.985);
	}
	.ui-btn:disabled,
	.ui-btn[aria-disabled='true'] {
		opacity: 0.5;
		cursor: not-allowed;
		box-shadow: none;
	}

	/* Sizes */
	.ui-btn-size-sm {
		height: 2.25rem;
		padding: 0 0.75rem;
		gap: 0.375rem;
		font-size: 0.8125rem;
	}
	.ui-btn-size-lg {
		height: 2.75rem;
		padding: 0 1.5rem;
	}
	.ui-btn-size-icon {
		width: 2.5rem;
		padding: 0;
	}
	@media (pointer: coarse) {
		.ui-btn {
			min-height: 2.75rem;
		}
		.ui-btn-size-icon {
			min-width: 2.75rem;
		}
	}

	/* Variants */
	.ui-btn-default {
		background: var(--ui-primary);
		color: var(--ui-primary-foreground);
		box-shadow: var(--ui-shadow-sm);
	}
	.ui-btn-default:hover {
		background: var(--ui-primary-hover);
		color: var(--ui-primary-foreground);
	}

	.ui-btn-secondary {
		background: var(--ui-muted);
		color: var(--ui-foreground);
	}
	.ui-btn-secondary:hover {
		background: color-mix(in srgb, var(--ui-muted) 70%, var(--ui-background));
		color: var(--ui-foreground);
	}

	.ui-btn-outline {
		background: var(--ui-background);
		border-color: var(--ui-input);
		color: var(--ui-foreground);
		box-shadow: var(--ui-shadow-sm);
	}
	.ui-btn-outline:hover {
		background: var(--ui-muted);
		color: var(--ui-foreground);
	}

	.ui-btn-ghost {
		background: transparent;
		color: var(--ui-foreground);
	}
	.ui-btn-ghost:hover {
		background: var(--ui-muted);
		color: var(--ui-foreground);
	}

	.ui-btn-destructive {
		background: color-mix(in srgb, var(--ui-destructive) 82%, #000);
		color: #fff;
		box-shadow: var(--ui-shadow-sm);
	}
	.ui-btn-destructive:hover {
		background: color-mix(in srgb, var(--ui-destructive) 72%, #000);
		color: #fff;
	}

	.ui-btn-link {
		background: transparent;
		color: color-mix(in srgb, var(--ui-primary) 40%, var(--ui-foreground));
		text-decoration: underline;
		text-underline-offset: 4px;
	}
	.ui-btn-link:hover {
		color: var(--ui-foreground);
		text-decoration: underline;
	}

	/* The page's one primary action: a faint sheen crosses it twice, then stops. */
	.ui-btn-highlight {
		overflow: hidden;
		isolation: isolate;
	}
	.ui-btn-highlight::after {
		content: '';
		position: absolute;
		inset: 0;
		z-index: -1;
		background: linear-gradient(105deg, transparent 30%, rgba(255, 255, 255, 0.22) 50%, transparent 70%);
		transform: translateX(-100%);
		pointer-events: none;
		animation: ui-sheen 1.6s var(--ease-out) 0.8s 2 both;
	}
	@keyframes ui-sheen {
		from {
			transform: translateX(-100%);
		}
		to {
			transform: translateX(100%);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.ui-btn {
			transition: none;
		}
		.ui-btn:active:not(:disabled):not([aria-disabled='true']) {
			transform: none;
		}
		.ui-btn-highlight::after {
			animation: none;
			display: none;
		}
	}
</style>
