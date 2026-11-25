<!--
  Separator.svelte — A hairline between parts of a page or a row (card 3074).
  Decorative unless told otherwise: a screen reader passes over it. With
  `decorative={false}` it is a `separator`, for a split the reader should
  know of.
-->
<script lang="ts">
	let {
		orientation = 'horizontal',
		decorative = true
	}: {
		orientation?: 'horizontal' | 'vertical';
		decorative?: boolean;
	} = $props();
</script>

<div
	class={['ui-separator', `ui-separator-${orientation}`]}
	role={decorative ? 'none' : 'separator'}
	aria-orientation={decorative ? undefined : orientation}
></div>

<style>
	.ui-separator {
		flex-shrink: 0;
		background: var(--ui-border);
	}
	.ui-separator-horizontal {
		width: 100%;
		height: 1px;
	}
	.ui-separator-vertical {
		width: 1px;
		align-self: stretch;
		min-height: 1rem;
	}
</style>
