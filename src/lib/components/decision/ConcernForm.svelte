<!--
  ConcernForm.svelte — a participant's concern about a ruling, on both
  participant pages (card 2679, decisions 4 and 24, F5).

  It says who sees a concern (`CONCERN_WHO_SEES`): the decider and DumpFire's
  administrators, by name, and never a release of the results. It lists the
  participant's own concerns, oldest first, each as text, never markdown.

  Where `mayRaise` (a reached participant of a ruled decision, within 90 days
  of the ruling), a labelled textarea of at most 4,000 characters, with its
  count, and Send. Send posts `{ ...extra, comment }` as JSON to `url`: the
  signed-in page's route, or the personal link's with the token in `extra`,
  so that no address holds it. The answer is `{ concern: { comment,
  createdAt } }`, which joins the list, the textarea emptied, and then the
  page's data is read again (`invalidateAll`): the list and `mayRaise` are
  the page's, so the form goes once the last concern allowed is raised (code
  review F9). A refusal (a 409
  or a 429 among them) is said in the server's words, and what was typed is
  kept. What was done, or refused, is said in a status region that stays
  drawn, only its words changing.
-->
<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { failureMessage } from '$lib/api';
	import Button from '$lib/components/ui/Button.svelte';
	import { DECISION_TEXT_MAX } from '$lib/decision-rules';
	import type { OwnConcern } from '$lib/decision-view-types';
	import { CONCERN_WHO_SEES, shownMoment } from '$lib/decision-words';

	let {
		url,
		extra = {},
		concerns = [],
		mayRaise
	}: {
		/** Where Send posts. */
		url: string;
		/** Sent beside the concern: the personal link's token. */
		extra?: Record<string, unknown>;
		/** The participant's own concerns, oldest first, as the page was given them. */
		concerns?: OwnConcern[];
		/** Whether a concern may be raised now. */
		mayRaise: boolean;
	} = $props();

	const TEXT_MAX = DECISION_TEXT_MAX;
	const id = $props.id();

	/** The page's list, with a concern just recorded added until the page's data, read again, gives it (code review F9). */
	let raised = $derived<OwnConcern[]>([...concerns]);
	let comment = $state('');
	let sending = $state(false);
	/** What was done, or the last refusal, said in the status region. */
	let said = $state<{ refused: boolean; words: string } | null>(null);

	const ready = $derived(comment.trim() !== '' && !sending);

	async function send() {
		if (!ready) return;
		sending = true;
		said = null;
		let recorded = false;
		try {
			const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...extra, comment }) });
			if (res.ok) {
				const answer = (await res.json()) as { concern: OwnConcern };
				raised = [...raised, answer.concern];
				comment = '';
				said = { refused: false, words: `Your concern was recorded on ${shownMoment(answer.concern.createdAt, '')}.` };
				recorded = true;
			} else {
				said = { refused: true, words: await failureMessage(res, 'Your concern was not recorded.') };
			}
		} catch {
			said = { refused: true, words: 'No answer from the server. It is not known whether your concern was recorded.' };
		} finally {
			sending = false;
		}
		// The page's data read again: its list, and whether another may be raised, so that no form is offered past the last.
		if (recorded) await invalidateAll();
	}
</script>

<div class="concern-form" data-block="concern">
	<p class="who-sees" data-note="concern-who-sees">{CONCERN_WHO_SEES}</p>

	{#if raised.length > 0}
		<h3>Your concerns</h3>
		<ul class="concerns" data-list="concerns">
			{#each raised as concern, index (index)}
				<li><span class="when">{shownMoment(concern.createdAt, '')}:</span> <span class="text">{concern.comment}</span></li>
			{/each}
		</ul>
	{/if}

	{#if mayRaise}
		<form
			onsubmit={(e) => {
				e.preventDefault();
				send();
			}}
		>
			<label class="ui-label field-label" for="{id}-concern">Your concern about the ruling</label>
			<textarea id="{id}-concern" class="ui-textarea" rows="4" maxlength={TEXT_MAX} aria-describedby="{id}-concern-count" bind:value={comment}></textarea>
			<p class="count" id="{id}-concern-count">{comment.length} of {TEXT_MAX.toLocaleString('en-GB')} characters</p>
			<div class="send-row"><Button type="submit" class="send" data-action="concern" disabled={!ready} aria-busy={sending ? 'true' : undefined}>Send my concern</Button></div>
		</form>
	{/if}

	<!-- Drawn from the start, so a screen reader hears each change of its words. -->
	<p class="said" class:refused={said?.refused} role="status" data-said="concern">{said?.words ?? ''}</p>
</div>

<style>
	.concern-form { display: flex; flex-direction: column; gap: var(--space-sm); font-size: 1rem; color: var(--ui-foreground); }
	.concern-form p { margin: 0; }
	.who-sees { font-size: 0.875rem; color: var(--ui-muted-foreground); }
	h3 { font-size: 1rem; font-weight: 600; margin: var(--space-xs) 0 0; }
	.concerns { margin: 0; padding-left: var(--space-lg); display: flex; flex-direction: column; gap: var(--space-xs); }
	.when { font-weight: 600; }
	.text { white-space: pre-wrap; overflow-wrap: anywhere; }
	form { display: flex; flex-direction: column; gap: var(--space-xs); max-width: 48rem; }
	.count { font-size: 0.75rem; color: var(--ui-muted-foreground); text-align: right; }
	.send-row { display: flex; }
	.said { font-size: 0.875rem; color: var(--ui-foreground); }
	/* A refusal: the words in the text colour, marked by the destructive tone. */
	.said.refused { padding-left: 0.625rem; border-left: 3px solid var(--ui-destructive); }
</style>