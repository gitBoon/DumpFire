<!--
  ColourSwatches.svelte — a row of preset colours and a colour of one's own:
  the one picker eight places share (card 2546), each of which had its own
  copy: Add Column (`AddColumnModal`), the card's cover (`CardCoverPicker`),
  the card window's New Category (`CardModal`), the dashboard's New Category
  (`BoardContextMenu`), the board's Manage Categories (`CategoryModal`), the
  column header's colour menu (`KanbanColumnHeader`), the dashboard's Manage
  Categories' quick colours (`CategoryManager`) and the card window's label
  forms (`LabelPicker`). The last three offer the presets alone.

  Each swatch is a button named by its colour ("Colour #6366f1": the presets
  have no names of their own in `$lib/colours`), pressed while it is the one
  chosen, with a focus ring. The custom colour is the browser's own picker
  laid over the ✎ swatch you see, so its Tab stop is that swatch, named
  "Custom colour", the ring drawn on the swatch (card 2473's pattern). In
  four of the five copies it sat at no size: a Tab stop with nothing to show.

  Two ways to use it. Bind `value`, and a swatch or the custom picker sets it
  (the forms). Or give `onpick`, and each pick is handed to it, `value` left
  to the caller to change (the cover, which saves each pick and puts it back
  if the server refuses). With `onpick` the custom picker hands its colour
  over as it is closed (`change`), not at every step of a drag, so one cover
  is sent and not dozens.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { drawnColour } from '$lib/colours';

	type Common = {
		/** The presets, in the order drawn. */
		colours: readonly string[];
		/** A swatch's size: tiny 16px (the dashboard's menu, Manage Categories' quick colours), small 20px, normal 24px, large 26px (the cover). */
		size?: 'tiny' | 'small' | 'normal' | 'large';
		/** The group's name, such as "Column colour". */
		label: string;
		/** Whether a colour of one's own is offered. */
		custom?: boolean;
		/** How a swatch is drawn where `drawnColour` would not draw it (a cover's gradient); `drawnColour` otherwise. */
		draw?: (colour: string) => string;
		/** A swatch's name. */
		nameOf?: (colour: string) => string;
		/** Drawn first in the group, such as the cover's No cover. */
		lead?: Snippet;
	};

	/**
	 * The two ways to use it, one or the other. Bound: `bind:value`, and a pick
	 * sets it; `onpick` and `customValue` are a type error. Handed over:
	 * `onpick`, and `value` is read only, the caller's to change; bind it and
	 * nothing is written to it (Svelte makes a prop bindable or not for every
	 * use, so the type cannot refuse that), and `customValue` may say where the
	 * custom picker opens.
	 */
	type Props = Common &
		(
			| {
					/** The colour chosen: its swatch is pressed, and the ✎ swatch is drawn in it. Bound, a pick sets it. */
					value?: string;
					onpick?: undefined;
					customValue?: undefined;
			  }
			| {
					/** The colour chosen: its swatch is pressed, and the ✎ swatch is drawn in it. Read only here. */
					value?: string;
					/** Each pick is handed to this, in place of setting `value`. */
					onpick: (colour: string) => void;
					/** What the custom picker opens on, where that is not `value` (a cover's gradient opens on its first colour). */
					customValue?: string;
			  }
		);

	let {
		colours,
		value = $bindable(''),
		onpick,
		size = 'normal',
		label,
		custom = true,
		customValue,
		draw,
		nameOf = (colour: string) => `Colour ${colour}`,
		lead
	}: Props = $props();

	/** A swatch chosen, or the custom picker's colour taken. */
	function pick(colour: string) {
		if (onpick) onpick(colour);
		else value = colour;
	}
</script>

<div class="color-row" class:tiny={size === 'tiny'} class:small={size === 'small'} class:large={size === 'large'} role="group" aria-label={label}>
	{@render lead?.()}
	{#each colours as colour}
		<button type="button" class="color-swatch" class:active={value === colour} aria-label={nameOf(colour)} aria-pressed={value === colour} style="background: {draw ? draw(colour) : drawnColour(colour)}" onclick={() => pick(colour)}></button>
	{/each}
	{#if custom}
		<label class="color-custom-wrapper">
			{#if onpick}
				<input type="color" value={customValue ?? value} onchange={(e) => pick(e.currentTarget.value)} class="color-native-input" aria-label="Custom colour" />
			{:else}
				<input type="color" bind:value class="color-native-input" aria-label="Custom colour" />
			{/if}
			<span class="color-swatch custom" style="background: {draw ? draw(value) : drawnColour(value)}" aria-hidden="true">✎</span>
		</label>
	{/if}
</div>

<style>
	.color-row { display: flex; flex-wrap: wrap; gap: 6px; }
	.color-row.tiny { gap: 3px; }
	.color-swatch { width: 24px; height: 24px; border-radius: var(--radius-sm); border: 2px solid transparent; cursor: pointer; flex-shrink: 0; transition: all var(--duration-fast) var(--ease-out); }
	.color-row.tiny .color-swatch { width: 16px; height: 16px; border-radius: 3px; }
	.color-row.small .color-swatch { width: 20px; height: 20px; }
	.color-row.large .color-swatch { width: 26px; height: 26px; }
	/* The ✎ swatch is under its picker, which takes the pointer: it grows from its wrapper's hover. */
	.color-swatch:hover, .color-custom-wrapper:hover .color-swatch.custom { transform: scale(1.15); }
	.color-swatch.active { border-color: var(--text-primary); box-shadow: 0 0 8px rgba(255, 255, 255, 0.2); }
	.color-custom-wrapper { position: relative; cursor: pointer; display: inline-flex; }
	/* Laid over the ✎ swatch, the browser's picker taking the click and the Tab stop: never at no size, nor out of the pointer's reach. */
	.color-native-input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; padding: 0; border: 0; opacity: 0; cursor: pointer; }
	.color-native-input:focus-visible + .color-swatch.custom,
	.color-swatch:focus-visible { outline: 2px solid var(--accent-indigo); outline-offset: 2px; }
	.color-swatch.custom {
		display: flex; align-items: center; justify-content: center;
		font-size: 0.6rem; color: white; text-shadow: 0 1px 2px rgba(0,0,0,0.5); cursor: pointer;
	}
	.color-row.tiny .color-swatch.custom { font-size: 0.5rem; }
</style>
