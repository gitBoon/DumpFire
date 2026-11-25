<!--
  Tabs.svelte — The UI kit's tabs (card 3074), for lists a page shows one of
  at a time, each its own address: a labelled navigation of links, the one
  shown `aria-current="page"`, each with its `data-tab`. A link, not a
  tablist: each tab is a page, reached and shared by its address, as the
  decision register's are.

  Drawn as shadcn's: pills in a muted track, the current one raised.
-->
<script lang="ts" module>
	export interface TabLink {
		id: string;
		label: string;
		href: string;
		/** A count after the label; none where it is null or left out. */
		count?: number | null;
	}
</script>

<script lang="ts">
	let {
		items,
		current,
		label
	}: {
		items: readonly TabLink[];
		/** The `id` of the tab shown. */
		current: string;
		/** Names the navigation for a screen reader, e.g. "Decision lists". */
		label: string;
	} = $props();
</script>

<nav class="ui-tabs" aria-label={label}>
	{#each items as tab (tab.id)}
		<a class="ui-tab" href={tab.href} data-tab={tab.id} aria-current={tab.id === current ? 'page' : undefined}>
			{tab.label}{#if tab.count !== undefined && tab.count !== null}<span class="ui-tab-count"><span class="ui-tab-sr">{' ('}</span>{tab.count}<span class="ui-tab-sr">)</span></span>{/if}
		</a>
	{/each}
</nav>

<style>
	.ui-tabs {
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
	.ui-tab {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		min-height: 2.25rem;
		padding: 0 0.875rem;
		border: 1px solid transparent;
		border-radius: var(--ui-radius);
		color: var(--ui-muted-foreground);
		font-size: 0.875rem;
		font-weight: 500;
		white-space: nowrap;
		text-decoration: none;
		transition:
			background-color var(--duration-fast) var(--ease-out),
			color var(--duration-fast) var(--ease-out),
			box-shadow var(--duration-fast) var(--ease-out);
	}
	.ui-tab:hover {
		color: var(--ui-foreground);
	}
	.ui-tab[aria-current='page'] {
		background: var(--ui-background);
		border-color: var(--ui-border);
		color: var(--ui-foreground);
		box-shadow: var(--ui-shadow-sm);
	}
	.ui-tab:focus-visible {
		outline: 2px solid var(--ui-ring);
		outline-offset: 2px;
	}
	.ui-tab-count {
		min-width: 1.25rem;
		padding: 0 0.375rem;
		border-radius: var(--radius-full);
		border: 1px solid var(--ui-border);
		font-size: 0.75rem;
		font-variant-numeric: tabular-nums;
		line-height: 1.25rem;
		text-align: center;
	}

	/* The count reads as "Open (3)" to a screen reader and in the text; the brackets are not drawn. */
	.ui-tab-sr {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: pre;
	}

	@media (pointer: coarse) {
		.ui-tab {
			min-height: 2.75rem;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.ui-tab {
			transition: none;
		}
	}
</style>
