<!--
  Stat.svelte — One figure on a page (card 3074): its `label`, its `value`
  and a `hint` under it. A number counts up to its value as the browser
  draws it, on a page opened from another (`tickUp`; none where the reader
  asks for less motion); on a page the server drew it is shown as it is. `format` writes it (a thousands
  separator, a unit); words are shown as they are.
-->
<script lang="ts">
	import { tickUp } from './motion';

	let {
		label,
		value,
		hint,
		format = (n: number) => String(Math.round(n))
	}: {
		label: string;
		value: number | string;
		hint?: string;
		format?: (n: number) => string;
	} = $props();
</script>

<div class="ui-stat">
	<p class="ui-stat-label">{label}</p>
	{#if typeof value === 'number'}
		<p class="ui-stat-value" data-tick-up use:tickUp={{ value, format }}>{format(value)}</p>
	{:else}
		<p class="ui-stat-value">{value}</p>
	{/if}
	{#if hint}<p class="ui-stat-hint">{hint}</p>{/if}
</div>

<style>
	.ui-stat {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		min-width: 0;
	}
	.ui-stat-label {
		margin: 0;
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--ui-muted-foreground);
	}
	.ui-stat-value {
		margin: 0;
		font-size: 1.75rem;
		font-weight: 600;
		line-height: 1.15;
		letter-spacing: -0.02em;
		font-variant-numeric: tabular-nums;
		color: var(--ui-foreground);
	}
	.ui-stat-hint {
		margin: 0;
		font-size: 0.75rem;
		color: var(--ui-muted-foreground);
	}
</style>
