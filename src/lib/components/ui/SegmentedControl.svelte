<!--
  SegmentedControl.svelte — The UI kit's in-page filter (card 3074): a few
  choices, one of them on, that change what the page shows without leaving
  it. A labelled group of toggle buttons, the one on `aria-pressed="true"`;
  each a button of its own, so Tab reaches each and Enter or Space chooses.
  The value can be bound (`bind:value`), and `onchange` is told of a choice.

  Drawn as the Tabs are: pills in a muted track.
-->
<script lang="ts" module>
	export interface SegmentOption {
		value: string;
		label: string;
	}
</script>

<script lang="ts">
	let {
		options,
		value = $bindable(),
		label,
		size = 'default',
		onchange
	}: {
		options: readonly SegmentOption[];
		value?: string;
		/** Names the group for a screen reader, e.g. "Show". */
		label: string;
		size?: 'sm' | 'default';
		onchange?: (value: string) => void;
	} = $props();

	function choose(next: string) {
		if (next === value) return;
		value = next;
		onchange?.(next);
	}
</script>

<div class={['ui-segmented', size === 'sm' && 'ui-segmented-sm']} role="group" aria-label={label}>
	{#each options as option (option.value)}
		<button
			type="button"
			class="ui-segment"
			aria-pressed={option.value === value}
			data-value={option.value}
			onclick={() => choose(option.value)}
		>
			{option.label}
		</button>
	{/each}
</div>

<style>
	.ui-segmented {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem;
		max-width: 100%;
		padding: 0.25rem;
		border-radius: var(--ui-radius-lg);
		background: var(--ui-surface);
		border: 1px solid var(--ui-border);
	}
	.ui-segment {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 2.25rem;
		padding: 0 0.875rem;
		border: 1px solid transparent;
		border-radius: var(--ui-radius);
		background: transparent;
		color: var(--ui-muted-foreground);
		font-family: var(--font-family);
		font-size: 0.875rem;
		font-weight: 500;
		white-space: nowrap;
		transition:
			background-color var(--duration-fast) var(--ease-out),
			color var(--duration-fast) var(--ease-out),
			box-shadow var(--duration-fast) var(--ease-out);
	}
	.ui-segmented-sm .ui-segment {
		min-height: 1.875rem;
		padding: 0 0.625rem;
		font-size: 0.8125rem;
	}
	.ui-segment:hover {
		color: var(--ui-foreground);
	}
	.ui-segment[aria-pressed='true'] {
		background: var(--ui-background);
		border-color: var(--ui-border);
		color: var(--ui-foreground);
		box-shadow: var(--ui-shadow-sm);
	}
	.ui-segment:focus-visible {
		outline: 2px solid var(--ui-ring);
		outline-offset: 2px;
	}

	@media (pointer: coarse) {
		.ui-segment,
		.ui-segmented-sm .ui-segment {
			min-height: 2.75rem;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.ui-segment {
			transition: none;
		}
	}
</style>
