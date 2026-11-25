<!--
  PageShell.svelte — The one frame of every page around the board (card 3074):
  the fixed header and the page's <main>.

  The header is what the pages each drew for themselves: the DumpFire logo,
  a link home; the page's crumbs (a snippet) or its title; the page's own
  actions (a snippet); and the Theme menu, a HeaderMenu holding
  ThemeMenuItems, as every page has had it since card 2471.

  <main> is as wide as `width` says: `full` (up to --ui-content-max),
  `reading` (--ui-reading-max) or `narrow`. Its foot stops above the user
  badge (--user-badge-space, card 2239). The page's own <h1> is in the page,
  not here: the shell draws none.

  With a `rail`, the page and the rail sit side by side from 1024px up, the
  rail --ui-rail wide and held below the header as the page scrolls; below
  1024px they stack, the rail after the page or, with `railPosition="start"`,
  before it. The document follows what is drawn (card 3076): a rail at the end
  comes after the page, and one at the start (a list of the page's sections,
  its filters) before it, so the keyboard and a screen reader meet it first,
  as navigation is met.

  `bare` (card 3075): the header holds the fire and "DumpFire" as plain
  text, not a link, and nothing else: no crumbs, title, actions or Theme
  menu, even when given. For a page that must link nowhere, such as a
  personal decision link held by someone outside DumpFire. `main` and the
  rail are as without it.

  It also brings in the kit's field classes (ui-field.css).
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import HeaderMenu from '$lib/components/HeaderMenu.svelte';
	import ThemeMenuItems from '$lib/components/ThemeMenuItems.svelte';
	import { theme, themeIcon } from '$lib/stores/theme';
	import './ui-field.css';

	/** A side column and the name a screen reader gives it: neither is given without the other. */
	type Rail =
		| {
				/** A side column: filters, a summary, what goes alongside the page. */
				rail: Snippet;
				/** Names the rail for a screen reader, e.g. "Filters". */
				railLabel: string;
				/** Which side the rail is on from 1024px up, and whether it is above or below the page beneath that. */
				railPosition?: 'start' | 'end';
		  }
		| { rail?: undefined; railLabel?: undefined; railPosition?: undefined };

	let {
		title,
		crumbs,
		actions,
		rail,
		railPosition = 'end',
		railLabel,
		width = 'full',
		bare = false,
		children
	}: {
		/** The header with the name alone, as plain text: no link, crumbs, actions or Theme menu. */
		bare?: boolean;
		/** The page's name in the header, where there are no crumbs. */
		title?: string;
		/** The header's crumbs, in place of `title`. */
		crumbs?: Snippet;
		/** The page's own controls in the header, before the Theme menu. */
		actions?: Snippet;
		width?: 'full' | 'reading' | 'narrow';
		children: Snippet;
	} & Rail = $props();
</script>

<div class="ui-shell">
	<header class="ui-shell-header">
		<div class="ui-shell-header-inner">
			{#if bare}
				<span class="ui-shell-logo ui-shell-logo-bare">
					<span class="ui-shell-fire" aria-hidden="true">🔥</span>
					<span class="ui-shell-brand">DumpFire</span>
				</span>
			{:else}
				<a href="/" class="ui-shell-logo" title="Back to DumpFire">
					<span class="ui-shell-fire" aria-hidden="true">🔥</span>
					<span class="ui-shell-brand">DumpFire</span>
				</a>
				<span class="ui-shell-divider" aria-hidden="true"></span>
				<div class="ui-shell-crumbs">
					{#if crumbs}
						{@render crumbs()}
					{:else if title}
						<p class="ui-shell-title">{title}</p>
					{/if}
				</div>
				{#if actions}
					<div class="ui-shell-actions">{@render actions()}</div>
				{/if}
				<HeaderMenu label="Theme" triggerClass="btn-ghost" triggerTitle="Change theme">
					{#snippet trigger()}<span aria-hidden="true">{themeIcon($theme)}</span>{/snippet}
					<ThemeMenuItems heading={false} />
				</HeaderMenu>
			{/if}
		</div>
	</header>

	<main class={['ui-shell-main', `ui-shell-${width}`, rail && 'ui-shell-grid', rail && railPosition === 'start' && 'ui-shell-rail-start']}>
		{#if rail && railPosition === 'start'}
			<aside class="ui-shell-rail" aria-label={railLabel}>{@render rail()}</aside>
			<div class="ui-shell-content">{@render children()}</div>
		{:else if rail}
			<div class="ui-shell-content">{@render children()}</div>
			<aside class="ui-shell-rail" aria-label={railLabel}>{@render rail()}</aside>
		{:else}
			{@render children()}
		{/if}
	</main>
</div>

<style>
	.ui-shell {
		min-height: 100vh;
		padding-top: 64px;
		color: var(--ui-foreground);
	}

	/* The header: fixed, 64px, over the page as it scrolls, as each page's own was. */
	.ui-shell-header {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		z-index: 200;
		height: 64px;
		border-bottom: 1px solid var(--ui-border);
		background: color-mix(in srgb, var(--ui-background) 82%, transparent);
		backdrop-filter: blur(12px) saturate(1.4);
		-webkit-backdrop-filter: blur(12px) saturate(1.4);
	}
	.ui-shell-header-inner {
		max-width: var(--ui-content-max);
		height: 100%;
		margin: 0 auto;
		padding: 0 var(--space-2xl);
		display: flex;
		align-items: center;
		gap: var(--space-md);
	}
	.ui-shell-logo {
		display: inline-flex;
		align-items: center;
		gap: var(--space-sm);
		flex-shrink: 0;
		padding: var(--space-xs) var(--space-sm);
		margin-left: calc(-1 * var(--space-sm));
		border-radius: var(--ui-radius);
		color: var(--ui-foreground);
		font-size: 1.05rem;
		font-weight: 700;
		letter-spacing: -0.01em;
		text-decoration: none;
		transition: background var(--duration-fast) var(--ease-out);
	}
	.ui-shell-logo:hover {
		color: var(--ui-foreground);
		background: var(--ui-muted);
	}
	/* The bare header's name is text, not a link: no hover. */
	.ui-shell-logo-bare:hover {
		background: none;
	}
	.ui-shell-logo:focus-visible {
		outline: 2px solid var(--ui-ring);
		outline-offset: 2px;
	}
	.ui-shell-fire {
		font-size: 1.3rem;
		line-height: 1;
	}
	.ui-shell-divider {
		flex-shrink: 0;
		width: 1px;
		height: 1.25rem;
		background: var(--ui-border);
	}
	/* Long crumbs are cut off; 4px of room inside the cut keeps a crumb link's focus ring whole. */
	.ui-shell-crumbs {
		flex: 1;
		min-width: 0;
		padding: 4px;
		margin: -4px;
		display: flex;
		align-items: center;
		gap: var(--space-sm);
		overflow: hidden;
		font-size: 0.875rem;
		color: var(--ui-muted-foreground);
		white-space: nowrap;
	}
	.ui-shell-title {
		margin: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		font-weight: 500;
		color: var(--ui-foreground);
	}
	.ui-shell-actions {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
		flex-shrink: 0;
	}

	/* The page. Its foot stops above the user badge (card 2239). */
	.ui-shell-main {
		margin: 0 auto;
		padding: var(--space-2xl) var(--space-2xl) var(--user-badge-space);
	}
	.ui-shell-full {
		max-width: var(--ui-content-max);
	}
	.ui-shell-reading {
		max-width: var(--ui-reading-max);
	}
	.ui-shell-narrow {
		max-width: 48rem;
	}

	/* With a rail: stacked under 1024px in the document's order, the rail after the page unless it is put first. */
	.ui-shell-grid {
		display: flex;
		flex-direction: column;
		gap: var(--space-xl);
	}
	.ui-shell-content {
		min-width: 0;
	}

	@media (min-width: 1024px) {
		.ui-shell-grid {
			display: grid;
			grid-template-columns: minmax(0, 1fr) var(--ui-rail);
			align-items: start;
			gap: var(--space-2xl);
		}
		.ui-shell-grid.ui-shell-rail-start {
			grid-template-columns: var(--ui-rail) minmax(0, 1fr);
		}
		/* Held below the header and clear of the user badge; 4px of room keeps a focus ring inside it whole. */
		.ui-shell-rail {
			position: sticky;
			top: calc(64px + var(--space-xl));
			max-height: calc(100vh - 64px - var(--space-xl) - var(--user-badge-space));
			overflow-y: auto;
			padding: 4px;
			margin: -4px;
		}
	}

	@media (max-width: 640px) {
		.ui-shell-header-inner {
			padding: 0 var(--space-md);
			gap: var(--space-sm);
		}
		.ui-shell-brand {
			display: none;
		}
		/* With nothing else in the header, the name has the room. */
		.ui-shell-logo-bare .ui-shell-brand {
			display: inline;
		}
		.ui-shell-main {
			padding: var(--space-md) var(--space-md) var(--user-badge-space);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.ui-shell-logo {
			transition: none;
		}
	}
</style>
