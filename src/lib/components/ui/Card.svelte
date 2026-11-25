<!--
  Card.svelte — The UI kit's card (card 3074): a raised panel, its parts
  CardHeader, CardTitle, CardDescription, CardContent and CardFooter, each
  set in from the card's edge by the same amount.

  `interactive`: the card is a thing to press or open (a link inside it, or
  the card a link itself with `as="a"`), and rises a little under the pointer.
  Other attributes (`data-*`, `aria-*`, `id`) go on through.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		as = 'div',
		interactive = false,
		href,
		class: className = '',
		children,
		...rest
	}: {
		as?: 'div' | 'section' | 'article' | 'li' | 'a';
		interactive?: boolean;
		/** With `as="a"`. */
		href?: string;
		class?: string;
		children?: Snippet;
		id?: string;
		[attribute: `data-${string}`]: unknown;
		[attribute: `aria-${string}`]: unknown;
	} = $props();
</script>

<svelte:element this={as} {...rest} {href} class={['ui-card', interactive && 'ui-card-interactive', className]}>
	{@render children?.()}
</svelte:element>

<style>
	.ui-card {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
		padding: 1.25rem 0;
		min-width: 0;
		border: 1px solid var(--ui-border);
		border-radius: var(--ui-radius-lg);
		background: var(--ui-card);
		color: var(--ui-foreground);
		box-shadow: var(--ui-shadow-sm);
		text-decoration: none;
	}
	.ui-card-interactive {
		transition:
			transform var(--duration-normal) var(--ease-out),
			box-shadow var(--duration-normal) var(--ease-out),
			border-color var(--duration-normal) var(--ease-out);
	}
	.ui-card-interactive:hover {
		transform: translateY(-2px);
		border-color: color-mix(in srgb, var(--ui-foreground) 20%, transparent);
		box-shadow: var(--ui-shadow);
		color: var(--ui-foreground);
	}
	.ui-card-interactive:focus-visible {
		outline: 2px solid var(--ui-ring);
		outline-offset: 2px;
	}

	@media (prefers-reduced-motion: reduce) {
		.ui-card-interactive {
			transition: none;
		}
		.ui-card-interactive:hover {
			transform: none;
		}
	}
</style>
