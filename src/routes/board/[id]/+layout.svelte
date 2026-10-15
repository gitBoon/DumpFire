<script lang="ts">
	/**
	 * The board page, made afresh for each board (card 2184).
	 *
	 * SvelteKit keeps a page's component when only its params change, so a
	 * sub-board badge, a breadcrumb, a link in the card window, or Back and
	 * Forward between two boards showed the second board in the first board's
	 * page: its live stream still the first board's, and its selection, panels,
	 * search, filters and card window carried over. Keyed on the board, the
	 * page is destroyed, which closes the first board's stream, and made again,
	 * which opens the second's, with all else empty.
	 *
	 * The key is the board, not the address: a `?card=` link on the same board,
	 * `invalidateAll()` and SvelteKit's `replaceState` keep the page, its
	 * stream, its drag state and its scroll. The new page's `afterNavigate`
	 * opens the card a link to another board names (card 2164).
	 */
	import type { Snippet } from 'svelte';
	import { page } from '$app/state';

	let { children }: { children: Snippet } = $props();
</script>

{#key page.params.id}{@render children()}{/key}
