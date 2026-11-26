<!--
  Table.svelte — The UI kit's table (card 3074): the page's own <thead> and
  <tbody> (the children), in a frame that scrolls sideways where the table
  is wider than the page, with its `caption`.

  With a caption, the frame is a region named by it (`aria-labelledby`) and
  takes the focus, so it can be scrolled from the keyboard. `stack`: at
  phone width each row is a block, each cell with its own label before it,
  from the cell's `data-label`.

  Card 3087: a row's own header (`<th scope="row">` in the body) is drawn as
  a cell in the foreground weight, and heads its block when stacked; a cell
  or column header with `ui-table-num` is a figure, at the right in tabular
  digits (at the left again once stacked, beside its label). `region`,
  true unless given false: with a caption, the frame is the focusable region
  above; `region={false}` for a table that never scrolls sideways (stacked,
  its cells wrapping), whose frame is then neither a region nor a Tab stop,
  the caption still captioning the table.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		caption,
		captionHidden = false,
		stack = false,
		region = true,
		class: className = '',
		children,
		...rest
	}: {
		caption?: string;
		/** The caption is for a screen reader alone: the page says it already. */
		captionHidden?: boolean;
		stack?: boolean;
		/** With a caption, the frame is a named region that takes the focus (card 3087: false for a table that never scrolls sideways). */
		region?: boolean;
		class?: string;
		children: Snippet;
		id?: string;
		[attribute: `data-${string}`]: unknown;
		[attribute: `aria-${string}`]: unknown;
	} = $props();

	const uid = $props.id();
	const captionId = `ui-table-caption-${uid}`;
</script>

{#if caption && region}
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<div class="ui-table-frame" role="region" aria-labelledby={captionId} tabindex="0">
		<table {...rest} class={['ui-table', stack && 'ui-table-stack', className]}>
			<caption id={captionId} class={['ui-table-caption', captionHidden && 'ui-table-caption-hidden']}>{caption}</caption>
			{@render children()}
		</table>
	</div>
{:else}
	<div class="ui-table-frame">
		<table {...rest} class={['ui-table', stack && 'ui-table-stack', className]}>
			{#if caption}<caption class={['ui-table-caption', captionHidden && 'ui-table-caption-hidden']}>{caption}</caption>{/if}
			{@render children()}
		</table>
	</div>
{/if}

<style>
	.ui-table-frame {
		width: 100%;
		overflow-x: auto;
		border: 1px solid var(--ui-border);
		border-radius: var(--ui-radius-lg);
		background: var(--ui-card);
	}
	.ui-table-frame:focus-visible {
		outline: 2px solid var(--ui-ring);
		outline-offset: 2px;
	}
	.ui-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.875rem;
		color: var(--ui-foreground);
	}
	.ui-table-caption {
		caption-side: top;
		padding: 0.75rem 1rem;
		text-align: left;
		font-weight: 600;
		border-bottom: 1px solid var(--ui-border);
	}
	.ui-table-caption-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
		border: 0;
	}
	.ui-table :global(thead th) {
		height: 2.5rem;
		padding: 0 1rem;
		text-align: left;
		vertical-align: middle;
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--ui-muted-foreground);
		border-bottom: 1px solid var(--ui-border);
		white-space: nowrap;
	}
	.ui-table :global(td) {
		padding: 0.75rem 1rem;
		vertical-align: middle;
		border-bottom: 1px solid var(--ui-border);
		overflow-wrap: anywhere;
	}
	/* A row's own header (`<th scope="row">`, card 3087): a cell in the foreground weight. */
	.ui-table :global(tbody th) {
		padding: 0.75rem 1rem;
		text-align: left;
		vertical-align: middle;
		font-weight: 500;
		border-bottom: 1px solid var(--ui-border);
		overflow-wrap: anywhere;
	}
	/* A figure (card 3087): at the right, its digits of one width so a column of them lines up. */
	.ui-table :global(th.ui-table-num),
	.ui-table :global(td.ui-table-num) {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	.ui-table :global(tbody tr:last-child td),
	.ui-table :global(tbody tr:last-child th) {
		border-bottom: none;
	}
	.ui-table :global(tbody tr) {
		transition: background-color var(--duration-fast) var(--ease-out);
	}
	.ui-table :global(tbody tr:hover) {
		background: color-mix(in srgb, var(--ui-muted) 40%, transparent);
	}

	@media (max-width: 640px) {
		.ui-table-stack :global(thead) {
			position: absolute;
			width: 1px;
			height: 1px;
			overflow: hidden;
			clip: rect(0 0 0 0);
		}
		.ui-table-stack,
		.ui-table-stack :global(tbody),
		.ui-table-stack :global(tr),
		.ui-table-stack :global(td) {
			display: block;
			width: 100%;
		}
		.ui-table-stack :global(tr) {
			padding: 0.5rem 0;
			border-bottom: 1px solid var(--ui-border);
		}
		.ui-table-stack :global(tbody tr:last-child) {
			border-bottom: none;
		}
		.ui-table-stack :global(td) {
			display: flex;
			align-items: center;
			gap: 0.75rem;
			min-height: 2.75rem;
			padding: 0.25rem 1rem;
			border-bottom: none;
		}
		/* The row's header heads its block, alone on its line. */
		.ui-table-stack :global(tbody th) {
			display: block;
			width: 100%;
			padding: 0.5rem 1rem 0.25rem;
			font-weight: 600;
			border-bottom: none;
		}
		.ui-table-stack :global(td.ui-table-num) {
			text-align: left;
		}
		.ui-table-stack :global(td[data-label]::before) {
			content: attr(data-label);
			flex: 0 0 6.5rem;
			font-size: 0.75rem;
			font-weight: 500;
			color: var(--ui-muted-foreground);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.ui-table :global(tbody tr) {
			transition: none;
		}
	}
</style>
