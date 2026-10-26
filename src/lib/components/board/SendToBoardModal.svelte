<!--
  SendToBoardModal.svelte — The board page's Send window (milestone 22, card
  2463, slice S5b): an option, a card in an Options column or any card of an
  ideas board, sent on to another delivery board, to its Options column, where
  it is still an idea, or to its To Do, which commits to it. Committed work is
  never offered it: it is moved, not sent.

  It lists the boards as the server gives them (`GET /api/cards/:id/send`):
  every delivery board the viewer can edit but this one, each with whether it
  has an Options column and the column To Do would commit into. A choice the
  board cannot take is shown and not offered, with why. A card with a
  sub-board is never sent to another board's Options (the S5a review's L6).

  It sends nothing itself: Send hands the choice to the page, which sends it
  through its board state, says a refusal in the server's words and keeps
  this window open on it, or takes the card off the board and closes it. The
  board list takes the focus as it opens, Escape closes it, Tab stays inside
  it, and the focus goes back to what had it (`holdFocus`).
-->
<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { holdFocus } from '$lib/dialog-focus';
	import { failureMessage } from '$lib/api';

	/** A board the card can be sent to, as `GET /api/cards/:id/send` lists it. */
	type Target = { id: number; name: string; emoji: string | null; options: boolean; todo: string | null };

	let {
		card,
		onSend,
		onClose
	}: {
		/** The option: its id, its title, and whether it has a sub-board. */
		card: { id: number; title: string; hasSubBoards: boolean };
		/** Sends it, through the page; true once it is sent, when the page closes this window. */
		onSend: (target: { boardId: number; boardName: string; to: 'options' | 'todo' }) => Promise<boolean>;
		onClose: () => void;
	} = $props();

	let boards = $state<Target[]>([]);
	let loading = $state(true);
	let loadFailure = $state('');
	let boardId = $state<number | null>(null);
	/** The target chosen; none while the board chosen takes neither, so a greyed choice is never shown chosen (the S5b review's P5). */
	let to = $state<'options' | 'todo' | null>('options');
	let sending = $state(false);

	const chosen = $derived(boards.find((b) => b.id === boardId) ?? null);
	/** "To its Options" is offered where the board has one, and never for a card with a sub-board. */
	const optionsOffered = $derived(chosen !== null && chosen.options && !card.hasSubBoards);
	const todoOffered = $derived(chosen !== null && chosen.todo !== null);
	const canSend = $derived(chosen !== null && !sending && ((to === 'options' && optionsOffered) || (to === 'todo' && todoOffered)));

	/** Why "To its Options" is not offered for the board chosen, or null. */
	const optionsWhy = $derived(
		chosen === null || optionsOffered
			? null
			: card.hasSubBoards
				? 'A card with a sub-board is committed work: it can only be committed to a To Do'
				: `"${chosen.name}" has no Options column`
	);

	/** The choice kept where the board chosen takes it, else the first it takes, Options first, else none. */
	function pickTo() {
		if ((to === 'options' && optionsOffered) || (to === 'todo' && todoOffered)) return;
		to = optionsOffered ? 'options' : todoOffered ? 'todo' : null;
	}

	onMount(async () => {
		try {
			const res = await fetch(`/api/cards/${card.id}/send`);
			if (!res.ok) {
				loadFailure = await failureMessage(res, 'The boards it can be sent to could not be read.');
				return;
			}
			const body = (await res.json()) as { boards?: Target[] };
			boards = Array.isArray(body.boards) ? body.boards : [];
			boardId = boards[0]?.id ?? null;
			pickTo();
		} catch {
			loadFailure = 'No answer from the server. The boards it can be sent to could not be read.';
		} finally {
			loading = false;
		}
		// The board list, once it is drawn, takes the focus from Cancel, which held it while the boards were read.
		await tick();
		const list = document.querySelector<HTMLElement>('.send-modal #send-board');
		if (list && document.activeElement?.closest('.send-modal')) list.focus();
	});

	async function send() {
		if (!chosen || !canSend || to === null) return;
		sending = true;
		try {
			await onSend({ boardId: chosen.id, boardName: chosen.name, to });
		} finally {
			sending = false;
		}
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="send-heading">
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div class="modal-content send-modal" onclick={(e) => e.stopPropagation()} role="document" use:holdFocus={{ first: '#send-board, .send-actions .btn-ghost', onEscape: onClose }}>
		<h2 id="send-heading">Send "{card.title}" to another board</h2>
		<p class="send-hint">An idea goes on to a delivery board: into its Options column, still an idea, or into its To Do, which commits to it.</p>
		{#if loading}
			<p class="send-note">Reading the boards…</p>
		{:else if loadFailure}
			<p class="send-note send-failure">{loadFailure}</p>
		{:else if boards.length === 0}
			<p class="send-note">There is no other delivery board you can edit to send it to.</p>
		{:else}
			<div class="form-group">
				<label for="send-board">Board</label>
				<select id="send-board" bind:value={boardId} onchange={pickTo}>
					{#each boards as b (b.id)}
						<option value={b.id}>{b.emoji ?? '📋'} {b.name}</option>
					{/each}
				</select>
			</div>
			<fieldset class="form-group send-to">
				<legend>Send it</legend>
				<label class="send-choice" class:unavailable={!optionsOffered}>
					<input type="radio" name="send-to" value="options" bind:group={to} disabled={!optionsOffered} />
					To its Options
					<span class="send-choice-note">{optionsWhy ?? 'Still an idea, not yet committed to'}</span>
				</label>
				<label class="send-choice" class:unavailable={!todoOffered}>
					<input type="radio" name="send-to" value="todo" bind:group={to} disabled={!todoOffered} />
					Commit to its To Do
					<span class="send-choice-note">
						{#if chosen && chosen.todo === null}
							"{chosen.name}" has no column to commit into: add a To Do column
						{:else if chosen && chosen.todo && chosen.todo.trim().toLowerCase() !== 'to do'}
							Committed into its "{chosen.todo}" column
						{:else}
							Committed to, ready to be started
						{/if}
					</span>
				</label>
			</fieldset>
		{/if}
		<div class="modal-actions send-actions">
			<button class="btn-ghost" onclick={onClose}>Cancel</button>
			<button class="btn-primary" onclick={send} disabled={!canSend}>{sending ? 'Sending…' : 'Send'}</button>
		</div>
	</div>
</div>

<style>
	.send-modal { max-width: 460px; }
	.send-hint { font-size: 0.82rem; color: var(--text-secondary); margin: var(--space-sm) 0 0; line-height: 1.45; }
	.send-note { font-size: 0.85rem; color: var(--text-secondary); margin-top: var(--space-xl); }
	.send-failure { color: var(--accent-rose); }
	.form-group { margin-top: var(--space-xl); }
	.form-group > label, .send-to legend {
		display: block; font-size: 0.75rem; font-weight: 600; color: var(--text-secondary);
		text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: var(--space-sm);
	}
	.form-group select {
		width: 100%; padding: 8px 12px; border-radius: var(--radius-md);
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		color: var(--text-primary); font-family: var(--font-family); font-size: 0.88rem;
	}
	.send-to { border: none; padding: 0; display: flex; flex-direction: column; gap: var(--space-sm); }
	.send-choice { display: grid; grid-template-columns: auto 1fr; column-gap: var(--space-sm); align-items: center; font-size: 0.88rem; cursor: pointer; }
	.send-choice.unavailable { opacity: 0.55; cursor: not-allowed; }
	.send-choice-note { grid-column: 2; font-size: 0.75rem; color: var(--text-tertiary); }
	.modal-actions { display: flex; justify-content: flex-end; gap: var(--space-md); margin-top: var(--space-2xl); }
</style>
