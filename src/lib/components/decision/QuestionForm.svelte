<!--
  QuestionForm.svelte — a participant's clarification question, on both
  participant pages (card 2678, decisions 3, 13 and 21, F4 and F5).

  It says who sees a question before Send (`QUESTION_WHO_SEES`): everyone
  included, without the asker's name; the decider, the author and
  DumpFire's administrators with it; and that in a small decision others may
  guess who asked.

  Always mounted on a participant's page, with `mayAsk`. Where `mayAsk`, a
  labelled textarea of at most 2,000 characters (`QUESTION_TEXT_MAX`), with
  its count, and Send my question, which posts `{ ...extra, question }` as
  JSON to `url`: the signed-in page's route, or the personal link's with the
  token in `extra`, so that no address holds it. Otherwise it draws no
  textarea and says why (`questionsClosedWords`), worked out here from the
  page's questions and the decision's shown status, so that both pages pass
  it data alone (code review F5).

  It lists nothing: the questions are `QuestionsPanel`'s alone (F5). On a
  question sent it says so in its status region, empties the textarea, reads
  the page's data again (`invalidateAll`), so that the panel lists the new
  question and the form closes once the last allowed is asked, and moves the
  focus to the questions' section heading (`headingId`). A refusal (a 409 or
  a 429 among them) is said in the server's words, and what was typed is
  kept; after a 409 the page's data is read again too (code review F6). The status region stays drawn whether or not the form is, only its
  words changing, so nothing said there is lost when the form closes (F4).
-->
<script lang="ts">
	import { tick } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { failureMessage } from '$lib/api';
	import Button from '$lib/components/ui/Button.svelte';
	import { QUESTION_TEXT_MAX, QUESTIONS_PER_PARTICIPANT } from '$lib/decision-rules';
	import type { QuestionView } from '$lib/decision-view-types';
	import { QUESTION_WHO_SEES, questionsClosedWords } from '$lib/decision-words';

	let {
		url,
		extra = {},
		mayAsk,
		questions,
		shownStatus,
		headingId = 'questions-heading'
	}: {
		/** Where Send posts. */
		url: string;
		/** Sent beside the question: the personal link's token. */
		extra?: Record<string, unknown>;
		/** Whether the participant may ask a question now. */
		mayAsk: boolean;
		/** The decision's questions as the page was given them: how many are the participant's own. */
		questions: QuestionView[];
		/** The decision's shown status. */
		shownStatus: string;
		/** The id of the section heading the focus moves to once a question is sent. */
		headingId?: string;
	} = $props();

	const TEXT_MAX = QUESTION_TEXT_MAX;
	const id = $props.id();

	/** Why no question may be asked, where `mayAsk` is false: worked out here from the page's data, so both pages pass data alone (code review F5). */
	const closedWords = $derived(questionsClosedWords(questions.filter((question) => question.own).length, QUESTIONS_PER_PARTICIPANT, shownStatus));

	let question = $state('');
	let sending = $state(false);
	/** What was done, or the last refusal, said in the status region. */
	let said = $state<{ refused: boolean; words: string } | null>(null);

	const ready = $derived(question.trim() !== '' && !sending);

	async function send() {
		if (!ready) return;
		sending = true;
		said = null;
		let sent = false;
		let conflicted = false;
		try {
			const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...extra, question }) });
			if (res.ok) {
				question = '';
				said = { refused: false, words: 'Your question was sent.' };
				sent = true;
			} else {
				said = { refused: true, words: await failureMessage(res, 'Your question was not sent.') };
				conflicted = res.status === 409;
			}
		} catch {
			said = { refused: true, words: 'No answer from the server. It is not known whether your question was sent.' };
		} finally {
			sending = false;
		}
		// A 409 (the decision ruled, or the last allowed question asked, elsewhere): the page's data read again, so the form shows why it is closed, and the text kept (code review F6).
		if (conflicted) await invalidateAll();
		if (!sent) return;
		// The page's data read again: the panel's list, and whether another may be asked.
		await invalidateAll();
		await tick();
		document.getElementById(headingId)?.focus();
	}
</script>

<div class="question-form" data-block="ask">
	{#if mayAsk}
		<p class="who-sees" data-note="question-who-sees">{QUESTION_WHO_SEES}</p>
		<form
			onsubmit={(e) => {
				e.preventDefault();
				send();
			}}
		>
			<label class="ui-label field-label" for="{id}-question">Your question</label>
			<textarea id="{id}-question" class="ui-textarea" rows="3" maxlength={TEXT_MAX} aria-describedby="{id}-question-count" bind:value={question}></textarea>
			<p class="count" id="{id}-question-count">{question.length} of {TEXT_MAX.toLocaleString('en-GB')} characters</p>
			<div class="send-row"><Button type="submit" class="send" data-action="ask" disabled={!ready} aria-busy={sending ? 'true' : undefined}>Send my question</Button></div>
		</form>
	{:else}
		<p class="closed" data-note="questions-closed">{closedWords}</p>
	{/if}

	<!-- Drawn from the start, and whether or not the form is, so a screen reader hears each change of its words (F4). -->
	<p class="said" class:refused={said?.refused} role="status" data-said="ask">{said?.words ?? ''}</p>
</div>

<style>
	.question-form { display: flex; flex-direction: column; gap: var(--space-sm); font-size: 1rem; color: var(--ui-foreground); }
	.question-form p { margin: 0; }
	.who-sees, .closed { font-size: 0.875rem; color: var(--ui-muted-foreground); }
	form { display: flex; flex-direction: column; gap: var(--space-xs); max-width: 48rem; }
	.count { font-size: 0.75rem; color: var(--ui-muted-foreground); text-align: right; }
	.send-row { display: flex; }
	.said { font-size: 0.875rem; color: var(--ui-foreground); }
	/* A refusal: the words in the text colour, marked by the destructive tone. */
	.said.refused { padding-left: 0.625rem; border-left: 3px solid var(--ui-destructive); }
</style>