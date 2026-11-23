<!--
  LinkedCards.svelte — the cards linked to a decision, on its signed-in page
  (card 2680, decisions 17, 18, 21 and 23; slice 3b).

  It lists the cards the page was given (`linkedCards`: only those on boards
  the viewer can open now, with no count of the rest), each by its id and
  title, linking to the card on its board, with the board's name and an
  Archived mark where it is archived. Who linked a card is never shown.

  Where `mayLink` (an editor of the decision's board, or an administrator
  where it has none, on a decision that is open, closed, ruled or
  superseded, below the cap of 100), a card search: the card window's
  (`/api/cards/search`, by #id or title, debounced 250 ms, the latest answer
  alone kept), each result offered with Link, one already linked shown and
  not offered. The search asks for `editable=1` (card 2718), so it reaches
  only the boards the viewer can edit, where it reached every board they can
  open and offered cards whose link the server then refused (403, `No edit
  access to this board`); a refusal that still comes is said. Where `mayUnlink` (the same
  access, on any decision but a draft, at the cap too), Unlink beside each
  card.

  Card 2687 (R8): where `mayMarkWaiting` (the same editor, on a decision
  open or awaiting its ruling, at the cap too), one toggle beside each card:
  its words fixed, "Waits on this decision", named "Waits on this decision:
  #12 Plan the move", with `aria-pressed` alone saying whether it waits, and
  drawn pressed (a tick in a filled box) or not (an empty box), not by colour
  alone. Where it is not offered, a card whose link is `waits` is marked
  "Waits on this decision" while the decision is shown open or awaiting its
  ruling. It is offered per page, not per card: a card on a board the person
  can only read is refused by the server in its own words, as Unlink is
  (E-L5).

  Link sends `PUT /api/decisions/:id/cards/:cardId` and Unlink `DELETE`, each
  saying it is JSON and carrying no body, so a link already there keeps its
  relation. The toggle sends the same `PUT` with `{"relation": "waits"}` or
  `{"relation": "relates"}`. The answer, `{ outcome?, linkedCards }`, is
  drawn at once, and then the page's data is read again (`invalidateAll`),
  which replaces it. A toggle answered `linked` was pressed on a card
  unlinked meanwhile, which the PUT linked again: that is said plainly. A
  refusal (404, 403, 409 for an archived card, a cap, or a wait on a
  decision already ruled) is said in the server's words (`failureMessage`).
  What was done, or refused, is said in a polite status region that stays
  drawn, only its words changing. After a link the focus goes back to the
  search box, emptied; after an unlink to the next card's Unlink, else the
  one before, else the search box, else the list's empty words. After the
  toggle, done, refused or unanswered, the page's data is read again, the
  words kept, and the focus goes back on that card's toggle, else the search
  box, else the list's empty words, else the first card's toggle, else the
  section's heading; unless the person has moved it elsewhere meanwhile.
-->
<script lang="ts">
	import { onDestroy, tick } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { failureMessage } from '$lib/api';
	import type { LinkedCardView, LinkOutcome } from '$lib/decision-register-types';
	import type { ShownStatus } from '$lib/decision-view-types';

	let {
		decisionId,
		shownStatus,
		cards,
		mayLink,
		mayUnlink,
		mayMarkWaiting
	}: {
		/** The decision the cards are linked to. */
		decisionId: number;
		/** The decision's shown status: a wait holds a card only while it is open or awaiting its ruling (card 2687, R2). */
		shownStatus: ShownStatus;
		/** The linked cards the page was given, on boards the viewer can open. */
		cards: LinkedCardView[];
		/** Whether the viewer may link a card now (`mayLinkCards`). */
		mayLink: boolean;
		/** Whether the viewer may unlink a card now (`mayUnlinkCards`). */
		mayUnlink: boolean;
		/** Whether the viewer may mark a card as waiting, or stop it waiting (`mayMarkWaiting`, card 2687). */
		mayMarkWaiting: boolean;
	} = $props();

	/** Whether a `waits` link holds its card now: the decision is open or awaiting its ruling. */
	const holds = $derived(shownStatus === 'open' || shownStatus === 'awaiting_ruling');

	const id = $props.id();

	/** The page's list, replaced by a write's answer until the page's data, read again, gives it. */
	let shown = $derived<LinkedCardView[]>([...cards]);
	const linkedIds = $derived(new Set(shown.map((card) => card.id)));

	/** One write at a time. */
	let busy = $state(false);
	/** What was done, or the last refusal, said in the status region. */
	let said = $state<{ refused: boolean; words: string } | null>(null);

	let searchBox = $state<HTMLInputElement>();
	let emptyWords = $state<HTMLParagraphElement>();
	let list = $state<HTMLUListElement>();
	let root = $state<HTMLDivElement>();

	// ─── The card search, as the card window's ──────────────────────────────

	type Found = { id: number; title: string; boardName: string; boardEmoji: string; columnName: string };

	let query = $state('');
	let found = $state<Found[]>([]);
	let searching = $state(false);
	/** Why the latest search found nothing to show: refused, or no answer. */
	let searchError = $state('');
	let timer: ReturnType<typeof setTimeout> | null = null;
	/** Which search is the latest: an older, slower answer never replaces a newer one, and a box emptied stays so. */
	let seq = 0;

	function onSearchInput() {
		if (timer) clearTimeout(timer);
		timer = null;
		const mine = ++seq;
		const q = query.trim();
		if (!q) {
			found = [];
			searchError = '';
			searching = false;
			return;
		}
		searching = true;
		timer = setTimeout(async () => {
			timer = null;
			let results: Found[] = [];
			let error = '';
			let res: Response | null = null;
			try {
				// Only cards on boards the viewer can edit: a link is an edit of the card's board.
				res = await fetch(`/api/cards/search?q=${encodeURIComponent(q)}&editable=1`);
			} catch {
				error = 'No answer from the server. The search could not be run.';
			}
			if (res && !res.ok) error = await failureMessage(res, 'The search was refused.');
			else if (res) {
				// An answer that is not a list of cards (a proxy's page) was an answer, not none.
				try {
					const body = await res.json();
					if (Array.isArray(body)) results = body;
					else error = "The server's answer could not be read. The search could not be run.";
				} catch {
					error = "The server's answer could not be read. The search could not be run.";
				}
			}
			if (mine !== seq) return;
			found = results;
			searchError = error;
			searching = false;
		}, 250);
	}

	/** Empties the search, and drops any search still waiting or out. */
	function clearSearch() {
		if (timer) clearTimeout(timer);
		timer = null;
		seq++;
		query = '';
		found = [];
		searchError = '';
		searching = false;
	}

	// A search still waiting when the page is left is not sent.
	onDestroy(() => {
		if (timer) clearTimeout(timer);
	});

	// ─── Link and unlink ─────────────────────────────────────────────────────

	const named = (card: { id: number; title: string }) => `#${card.id} ${card.title}`;

	/** Reads a write's answer: its cards, drawn at once, or null where it cannot be read. */
	async function cardsOf(res: Response): Promise<{ outcome?: LinkOutcome; linkedCards: LinkedCardView[] } | null> {
		try {
			const body = await res.json();
			return Array.isArray(body?.linkedCards) ? body : null;
		} catch {
			return null;
		}
	}

	/** Reads the page's data again; the write's answer is already drawn, so a read that fails changes nothing shown. */
	async function reread() {
		try {
			await invalidateAll();
		} catch {
			// The list drawn is the write's answer until the page is next read.
		}
	}

	async function link(card: Found) {
		if (busy) return;
		busy = true;
		said = null;
		let linked = false;
		try {
			const res = await fetch(`/api/decisions/${decisionId}/cards/${card.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' } });
			if (!res.ok) {
				said = { refused: true, words: await failureMessage(res, `${named(card)} was not linked.`) };
				return;
			}
			const answer = await cardsOf(res);
			if (answer !== null) shown = answer.linkedCards;
			said = { refused: false, words: answer?.outcome === 'unchanged' ? `${named(card)} was already linked.` : `Linked ${named(card)}.` };
			linked = true;
			clearSearch();
		} catch {
			said = { refused: true, words: `No answer from the server. It is not known whether ${named(card)} was linked.` };
		} finally {
			busy = false;
		}
		if (!linked) return;
		await reread();
		await tick();
		searchBox?.focus();
	}

	async function unlink(card: LinkedCardView) {
		if (busy) return;
		busy = true;
		said = null;
		// Where the focus goes once the card has left the list: the next card's Unlink, else the one before.
		const at = shown.findIndex((c) => c.id === card.id);
		const after = shown[at + 1]?.id ?? shown[at - 1]?.id ?? null;
		let unlinked = false;
		try {
			const res = await fetch(`/api/decisions/${decisionId}/cards/${card.id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
			if (!res.ok) {
				said = { refused: true, words: await failureMessage(res, `${named(card)} was not unlinked.`) };
				return;
			}
			const answer = await cardsOf(res);
			shown = answer !== null ? answer.linkedCards : shown.filter((c) => c.id !== card.id);
			said = { refused: false, words: `Unlinked ${named(card)}.` };
			unlinked = true;
		} catch {
			said = { refused: true, words: `No answer from the server. It is not known whether ${named(card)} was unlinked.` };
		} finally {
			busy = false;
		}
		if (!unlinked) return;
		await reread();
		// Once the buttons are enabled again: a disabled one takes no focus.
		await tick();
		const next = after === null ? null : list?.querySelector<HTMLButtonElement>(`button[data-action="unlink"][data-card="${after}"]`);
		(next ?? searchBox ?? emptyWords)?.focus();
	}

	/**
	 * Card 2687 (R7, R8): marks the card as waiting on the decision, or stops
	 * it waiting, with the same PUT and its relation in the body. An answer
	 * `linked` means the card had been unlinked meanwhile and the PUT linked it
	 * again (review P-M1), which is said. Done, refused or unanswered, the
	 * page's data is read again, the words kept (P-L5). The focus goes back to
	 * the card's toggle, as it is lost while the button is disabled; else to
	 * the search box, else the list's empty words, else the first card's
	 * toggle, else the section's heading; and stays where the person has put
	 * it meanwhile (P-L6).
	 */
	async function toggleWaiting(card: LinkedCardView) {
		if (busy) return;
		busy = true;
		said = null;
		const from = document.activeElement;
		const relation = card.relation === 'waits' ? 'relates' : 'waits';
		const asked = relation === 'waits' ? 'marked as waiting' : 'stopped waiting';
		try {
			const res = await fetch(`/api/decisions/${decisionId}/cards/${card.id}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ relation })
			});
			if (!res.ok) {
				said = { refused: true, words: await failureMessage(res, `${named(card)} was not ${asked}.`) };
			} else {
				const answer = await cardsOf(res);
				shown = answer !== null ? answer.linkedCards : shown.map((c) => (c.id === card.id ? { ...c, relation } : c));
				const words =
					answer?.outcome === 'linked'
						? `${named(card)} was no longer linked to this decision: it is linked again, and ${relation === 'waits' ? 'waits on it' : 'does not wait on it'}.`
						: relation === 'waits'
							? `${named(card)} waits on this decision.`
							: `${named(card)} no longer waits on this decision.`;
				said = { refused: false, words };
			}
		} catch {
			said = { refused: true, words: `No answer from the server. It is not known whether ${named(card)} was ${asked}.` };
		} finally {
			busy = false;
		}
		// What is drawn may now be out of date, whatever the answer: the words said are kept.
		await reread();
		// Once the buttons are enabled again: a disabled one takes no focus.
		await tick();
		const now = document.activeElement;
		if (now !== from && now !== null && now !== document.body) return;
		const again = list?.querySelector<HTMLButtonElement>(`button[data-action="wait"][data-card="${card.id}"]`);
		const first = list?.querySelector<HTMLButtonElement>('button[data-action="wait"]');
		(again ?? searchBox ?? emptyWords ?? first ?? headingOf())?.focus();
	}

	/** The heading of the section the list is drawn in, focusable from code: the last place the focus can go. */
	function headingOf(): HTMLElement | null {
		const heading = root?.closest('section')?.querySelector<HTMLElement>('h2, h3') ?? null;
		if (heading && !heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
		return heading;
	}
</script>

<div class="linked-cards" data-part="linked-cards" bind:this={root}>
	{#if shown.length > 0}
		<ul class="cards" bind:this={list}>
			{#each shown as card (card.id)}
				<li class="card-row" data-card-row={card.id}>
					<a class="card-link" href="/board/{card.boardId}?card={card.id}">
						<span class="card-id">#{card.id}</span>
						<span class="card-title">{card.title}</span>
					</a>
					<span class="card-where">{card.boardName}</span>
					{#if card.archived}<span class="archived" data-mark="archived">Archived</span>{/if}
					{#if mayMarkWaiting}
						<!-- Its words and name fixed; aria-pressed alone says whether it waits (review P-M2). -->
						<button
							type="button"
							class="btn-ghost row-action wait-toggle"
							class:pressed={card.relation === 'waits'}
							data-action="wait"
							data-card={card.id}
							aria-pressed={card.relation === 'waits'}
							aria-label="Waits on this decision: {named(card)}"
							disabled={busy}
							onclick={() => toggleWaiting(card)}
							><span class="press-box" aria-hidden="true">{card.relation === 'waits' ? '✓' : ''}</span>Waits on this decision</button
						>
					{:else if card.relation === 'waits' && holds}
						<span class="waits" data-mark="waits">Waits on this decision</span>
					{/if}
					{#if mayUnlink}
						<button
							type="button"
							class="btn-ghost row-action"
							data-action="unlink"
							data-card={card.id}
							aria-label="Unlink {named(card)}"
							disabled={busy}
							onclick={() => unlink(card)}>Unlink</button
						>
					{/if}
				</li>
			{/each}
		</ul>
	{:else}
		<p class="none" tabindex="-1" bind:this={emptyWords}>No cards are linked to this decision.</p>
	{/if}

	{#if mayLink}
		<div class="link-search">
			<label class="small" for="{id}-search">Find a card to link, by #id or title</label>
			<input
				id="{id}-search"
				class="field"
				type="search"
				autocomplete="off"
				aria-describedby="{id}-search-note"
				bind:value={query}
				bind:this={searchBox}
				oninput={onSearchInput}
			/>
			<p class="small" id="{id}-search-note">Cards on every board you can see; one on a board you cannot edit is refused.</p>
			{#if searching}
				<p class="small">Searching…</p>
			{:else if searchError}
				<p class="refused">{searchError}</p>
			{:else if query.trim() && found.length === 0}
				<p class="small">No cards match “{query.trim()}”.</p>
			{:else if found.length > 0}
				<ul class="results" aria-label="Cards found">
					{#each found as result (result.id)}
						<li class="card-row">
							<span class="card-id">#{result.id}</span>
							<span class="card-title">{result.title}</span>
							<span class="card-where">{result.boardEmoji} {result.boardName} / {result.columnName}</span>
							{#if linkedIds.has(result.id)}
								<span class="already">Linked</span>
							{:else}
								<button
									type="button"
									class="btn-primary row-action"
									data-action="link"
									data-card={result.id}
									aria-label="Link {named(result)}"
									disabled={busy}
									onclick={() => link(result)}>Link</button
								>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}

	<p class="status" class:refused={said?.refused} role="status" data-said="link">{said?.words ?? ''}</p>
</div>

<style>
	.linked-cards { display: flex; flex-direction: column; gap: var(--space-sm); }
	.cards, .results { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-xs); }
	.card-row {
		display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-xs) var(--space-sm);
		padding: var(--space-xs) var(--space-sm); border-radius: var(--radius-sm); background: var(--bg-elevated);
	}
	.card-link { min-height: 44px; display: inline-flex; align-items: center; gap: var(--space-xs); flex: 1 1 12rem; min-width: 0; color: var(--text-primary); }
	.card-title { overflow-wrap: anywhere; }
	.card-id { color: var(--text-secondary); font-variant-numeric: tabular-nums; }
	.card-where { font-size: 0.9rem; color: var(--text-secondary); overflow-wrap: anywhere; }
	.archived, .already { font-size: 0.85rem; font-weight: 600; color: var(--text-secondary); }
	.row-action { min-height: 44px; min-width: 44px; font-size: 0.95rem; margin-left: auto; }
	/* The toggle and Unlink sit together at the row's end (card 2687). */
	.row-action + .row-action { margin-left: 0; }
	.waits { font-size: 0.85rem; font-weight: 600; color: var(--text-primary); }
	/* The toggle (review P-M2): pressed is a tick in a filled box and a solid edge, unpressed an empty box and a dashed one, so not colour alone. */
	.wait-toggle { display: inline-flex; align-items: center; gap: var(--space-xs); border: 1px dashed var(--glass-border); }
	.wait-toggle.pressed { border-style: solid; border-color: var(--text-primary); font-weight: 600; }
	.press-box {
		display: inline-flex; align-items: center; justify-content: center; width: 1.1em; height: 1.1em;
		border: 1.5px solid currentColor; border-radius: 3px; font-size: 0.85rem; line-height: 1;
	}
	.wait-toggle.pressed .press-box { background: var(--text-primary); color: var(--bg-elevated); border-color: var(--text-primary); }
	.none { margin: 0; color: var(--text-secondary); }
	.link-search { display: flex; flex-direction: column; gap: var(--space-xs); }
	.small { margin: 0; font-size: 0.9rem; color: var(--text-secondary); }
	.field {
		font-size: 16px; font-family: var(--font-family); padding: var(--space-sm); width: 100%; box-sizing: border-box; min-height: 44px;
		border: 1px solid var(--glass-border); border-radius: var(--radius-sm); background: var(--bg-elevated); color: var(--text-primary);
	}
	.status { margin: 0; font-size: 0.9rem; min-height: 1.2em; }
	.refused { margin: 0; font-size: 0.9rem; color: var(--accent-rose); }
</style>
