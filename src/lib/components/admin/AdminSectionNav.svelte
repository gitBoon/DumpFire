<!--
  AdminSectionNav.svelte — The admin page's list of its sections (card 3076,
  decisions 2 to 5 and 17), drawn in the page's rail: a link to each section's
  card by its address (/admin#users), grouped as the page is (Access, Data,
  Settings), in page order.

  The section in view is marked (`aria-current="location"`, one link at most):
  where the browser has an IntersectionObserver, each section is watched and
  the first in page order among those in the band under the header is the
  one. A pressed link is marked at once, and stays marked until the reader
  scrolls, as the last short section (Danger Zone) can never reach the top.
  Without the observer nothing is marked until a press, and nothing throws.
  A section drawn again (the panels in a `{#key}`) or drawn late (the held
  list, after its read) is watched as it appears. No smooth scrolling: the
  browser's own jump to the anchor.

  Below 1024px the rail is above the page: the links are one row that
  scrolls sideways within itself, the group names hidden.

  Every administrator's (drawn in no `{#if}`); `held` adds the link to the
  settings held for review while the list holds one.
-->
<script lang="ts">
	import { onMount } from 'svelte';

	let {
		held = false
	}: {
		/** Whether a setting is held for review: the list's link is drawn only then. */
		held?: boolean;
	} = $props();

	type Section = { id: string; label: string };

	/** The sections, grouped and in page order; a group with no name is the page's top or foot. */
	const groups = $derived<{ name: string | null; sections: Section[] }[]>([
		{
			name: null,
			sections: [{ id: 'overview', label: 'Database Overview' }, ...(held ? [{ id: 'settings-held', label: 'Settings held for review' }] : [])]
		},
		{
			name: 'Access',
			sections: [
				{ id: 'two-step', label: 'Two-step sign-in' },
				{ id: 'users', label: 'User Management' },
				{ id: 'teams', label: 'Team Management' },
				{ id: 'people-directory', label: 'People Directory' },
				{ id: 'iso', label: 'ISO 27001:2022 Checklist' }
			]
		},
		{
			name: 'Data',
			sections: [
				{ id: 'boards', label: 'Board Management' },
				{ id: 'backup', label: 'Backup & Restore' },
				{ id: 'scheduled-backups', label: 'Scheduled Backups' }
			]
		},
		{
			name: 'Settings',
			sections: [
				{ id: 'app-url', label: 'Application Settings' },
				{ id: 'mail', label: 'Email / SMTP' }
			]
		},
		{ name: null, sections: [{ id: 'danger-zone', label: 'Danger Zone' }] }
	]);

	/** Every section's id, in page order. */
	const order = $derived(groups.flatMap((group) => group.sections.map((section) => section.id)));

	/** The link pressed, kept until the reader scrolls. */
	let pressed = $state<string | null>(null);
	/** The first section in view, as the observer last said. */
	let seen = $state<string | null>(null);
	const current = $derived(pressed ?? seen);

	/** The keys that scroll the page: any of them hands the mark back to what is in view. */
	const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

	function scrolled() {
		pressed = null;
	}

	let nav = $state<HTMLElement>();

	onMount(() => {
		if (typeof IntersectionObserver === 'undefined') return;
		const inView = new Set<string>();
		/** Each section's element as last watched, by id. */
		const watched = new Map<string, Element>();
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (watched.get(entry.target.id) !== entry.target) continue;
					if (entry.isIntersecting) inView.add(entry.target.id);
					else inView.delete(entry.target.id);
				}
				seen = order.find((id) => inView.has(id)) ?? seen;
			},
			{ rootMargin: '-72px 0px -55% 0px' }
		);
		/** Watch each section's element, and the new one of a section drawn again; let go of one gone. */
		const sync = () => {
			for (const id of order) {
				const element = document.getElementById(id);
				const before = watched.get(id);
				if (element === before) continue;
				if (before) observer.unobserve(before);
				inView.delete(id);
				if (element) {
					watched.set(id, element);
					observer.observe(element);
				} else watched.delete(id);
			}
		};
		sync();
		// A panel drawn again in its {#key}, or the held list drawn after its read (its link with it), is a new element.
		const changes = new MutationObserver(sync);
		changes.observe(nav?.closest('main') ?? document.body, { childList: true, subtree: true });
		return () => {
			changes.disconnect();
			observer.disconnect();
		};
	});
</script>

<svelte:window onwheel={scrolled} ontouchmove={scrolled} onkeydown={(event) => SCROLL_KEYS.has(event.key) && scrolled()} />

<!-- Named by the rail it is drawn in (PageShell's aside, "Admin sections"), not a second time here. -->
<nav class="admin-section-nav" bind:this={nav}>
	{#each groups as group, g (g)}
		<div class="admin-nav-group">
			{#if group.name}<p class="admin-nav-name">{group.name}</p>{/if}
			<ul>
				{#each group.sections as section (section.id)}
					<li>
						<a href="#{section.id}" aria-current={current === section.id ? 'location' : undefined} onclick={() => (pressed = section.id)}>{section.label}</a>
					</li>
				{/each}
			</ul>
		</div>
	{/each}
</nav>

<style>
	.admin-section-nav {
		display: flex;
		flex-direction: column;
		gap: var(--space-md);
		font-size: 0.875rem;
	}
	.admin-nav-name {
		margin: 0 0 0.25rem;
		padding: 0 0.75rem;
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--ui-muted-foreground);
	}
	ul {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	a {
		display: block;
		padding: 0.375rem 0.75rem;
		border-radius: var(--ui-radius);
		color: var(--ui-muted-foreground);
		line-height: 1.4;
		text-decoration: none;
		transition:
			background-color var(--duration-fast) var(--ease-out),
			color var(--duration-fast) var(--ease-out);
	}
	a:hover {
		background: color-mix(in srgb, var(--ui-muted) 60%, transparent);
		color: var(--ui-foreground);
	}
	a[aria-current='location'] {
		background: var(--ui-muted);
		color: var(--ui-foreground);
		font-weight: 500;
	}
	a:focus-visible {
		outline: 2px solid var(--ui-ring);
		outline-offset: 2px;
	}

	/* Above the page: one row of links that scrolls sideways within itself, the group names hidden. */
	@media (max-width: 1023px) {
		.admin-section-nav {
			flex-direction: row;
			gap: 0.25rem;
			padding: 4px;
			overflow-x: auto;
			scrollbar-width: thin;
		}
		.admin-nav-group,
		ul {
			flex-direction: row;
			flex-shrink: 0;
			gap: 0.25rem;
		}
		.admin-nav-group {
			display: flex;
		}
		.admin-nav-name {
			display: none;
		}
		a {
			white-space: nowrap;
			border: 1px solid var(--ui-border);
			border-radius: var(--radius-full);
		}
	}
	/* A finger's room at every width. */
	@media (pointer: coarse) {
		a {
			display: flex;
			align-items: center;
			min-height: 2.75rem;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		a {
			transition: none;
		}
	}
</style>
