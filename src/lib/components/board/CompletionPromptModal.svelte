<!--
  CompletionPromptModal.svelte — asks for the two facts a report cannot work
  without, at the one moment they are actually known.

  Shown after a card is moved to Complete, not before: the move has already
  happened and skipping costs nothing. That is deliberate. A required field here
  would be filled in with whatever closes the dialog fastest, and an invented
  summary in a document that goes to senior management is worse than a blank one.

  Two fields only, and both earn their place:

  - **Summary** is quoted verbatim into the report appendix. Writing it now takes
    a few seconds; reconstructing 196 of them from technical card titles a month
    later took about 18 minutes and every one was a guess.
  - **Close reason** is the difference between "we delivered 145 things" and the
    truth. Delivered, not needed, superseded and parked all look identical once a
    card is in the Complete column, so without this a headline count overstates
    what was actually built.
-->
<script lang="ts">
	import { CLOSE_REASONS, SUMMARY_MAX, FIELD_HINTS } from '$lib/reporting';

	/**
	 * @prop cardTitle — the card just completed, for context
	 * @prop summary — two-way bound plain-English summary
	 * @prop closeReason — two-way bound reason the card left the board
	 * @prop remaining — how many more completed cards are queued behind this one
	 * @prop onSave — record what was entered and move to the next card
	 * @prop onSkip — record nothing for this card and move on
	 */
	let {
		cardTitle,
		summary = $bindable(''),
		closeReason = $bindable(''),
		remaining = 0,
		onSave,
		onSkip
	}: {
		cardTitle: string;
		summary: string;
		closeReason: string;
		remaining?: number;
		onSave: () => void;
		onSkip: () => void;
	} = $props();

	// Enter saves, Escape skips — the dialog should never be a reason to reach
	// for the mouse on the way past.
	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			onSave();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			onSkip();
		}
	}
</script>

<svelte:window on:keydown={onKeydown} />

<div class="modal-overlay" role="dialog" aria-modal="true">
	<div class="modal-content completion-modal" role="document">
		<div class="completion-header">
			<span class="completion-icon">✅</span>
			<h2>Completed</h2>
			<p class="completion-task-name">"{cardTitle}"</p>
		</div>

		<div class="form-group">
			<label for="completion-summary">Summary for the report</label>
			<input
				id="completion-summary"
				type="text"
				maxlength={SUMMARY_MAX}
				placeholder="Plain English, about 12 words"
				bind:value={summary}
			/>
			<small>{FIELD_HINTS.summary}</small>
		</div>

		<div class="form-group">
			<label for="completion-reason">Close reason</label>
			<select id="completion-reason" bind:value={closeReason}>
				<option value="">Not recorded</option>
				{#each CLOSE_REASONS as r}<option value={r}>{r}</option>{/each}
			</select>
			<small>{FIELD_HINTS.closeReason}</small>
		</div>

		<div class="modal-actions">
			{#if remaining > 0}
				<span class="completion-remaining">{remaining} more to go</span>
			{/if}
			<button class="btn-ghost" onclick={onSkip}>Skip</button>
			<button class="btn-primary completion-confirm" onclick={onSave}>Save</button>
		</div>
	</div>
</div>

<style>
	.completion-modal { max-width: 460px; }
	.completion-header { text-align: center; margin-bottom: var(--space-lg); }
	.completion-icon { font-size: 2rem; display: block; margin-bottom: var(--space-sm); }
	.completion-task-name {
		font-size: 0.9rem; color: var(--text-secondary);
		font-style: italic; margin-top: var(--space-xs);
	}
	.form-group { margin-top: var(--space-lg); }
	.form-group label {
		display: block; font-size: 0.75rem; font-weight: 600; color: var(--text-secondary);
		text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: var(--space-sm);
	}
	.form-group small {
		display: block; margin-top: 4px; font-size: 0.68rem; line-height: 1.35;
		color: var(--text-tertiary, var(--text-secondary)); opacity: 0.8;
	}
	.modal-actions {
		display: flex; justify-content: flex-end; align-items: center;
		gap: var(--space-md); margin-top: var(--space-xl);
	}
	.completion-remaining {
		margin-right: auto; font-size: 0.72rem;
		color: var(--text-tertiary, var(--text-secondary)); opacity: 0.8;
	}
	.completion-confirm { background: var(--accent-emerald, #10b981) !important; }
</style>
