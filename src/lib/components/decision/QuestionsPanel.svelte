<!--
  QuestionsPanel.svelte — a decision's clarification questions and their
  answers, on both participant pages (card 2678, decisions 2, 3, 8, 19 and
  21, F4 to F6). The one list of them: the question form lists none (F5).

  Oldest first, each as the viewer was given it (`QuestionView`): its text
  as typed, never markdown (`pre-wrap`, with an id its controls are
  described by); "Your question" on the viewer's own; who asked and when
  where given (the author, the decider and administrators), and when on the
  viewer's own; `ASKED_BY_AGENT` where given; "Asked about version N" where
  older than the version shown. Then the answer a person stands behind, with
  who gave it in which role and when, and `AgentLabel reviewed` on a
  published agent's draft; or, for the author, the decider and
  administrators, an agent's unpublished draft under `AgentLabel`; or the
  words for one not answered (yet, or before the ruling or the withdrawal).

  Where `mayAnswer` (signed in, the author or the decider, who alone are
  given a question's id): under each open question a labelled textarea of at
  most 4,000 characters with its count, and Send answer, posting
  `{ answer }` as JSON; under each agent's draft, Publish, posting `{}` to
  `…/publish`, and a labelled textarea and Replace, posting
  `{ answer, replacesDraft: true }`. Each control is named after the question
  it answers and described by the question's text (F6).

  One status region for every control, drawn from the start. After an
  answer, a publish or a replacement it says so, the page's data is read
  again (`invalidateAll`), and the focus moves to the new answer. A refusal
  is said in the server's words and what was typed is kept; after a 409
  (another tab or answerer got there first) the data is read again too, and
  text typed for a question now answered is kept, read-only, beside it, so
  that nothing typed is lost. The focus then moves to that kept text, or
  else to the question's answer or its text (`tabindex="-1"`), so that it is
  not lost with a control the data read again took away (code review F1). A
  publish clears any replacement typed for the draft it published.
-->
<script lang="ts">
	import { tick } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { failureMessage } from '$lib/api';
	import Button from '$lib/components/ui/Button.svelte';
	import { DECISION_TEXT_MAX } from '$lib/decision-rules';
	import type { QuestionView } from '$lib/decision-view-types';
	import {
		ASKED_BY_AGENT,
		answerFieldName,
		answeredByWords,
		askedInWords,
		publishDraftName,
		replaceDraftName,
		replaceFieldName,
		sendAnswerName,
		shownMoment,
		unansweredWords
	} from '$lib/decision-words';
	import AgentLabel from './AgentLabel.svelte';

	let {
		questions,
		decisionId,
		mayAnswer = false,
		shownVersion
	}: {
		/** The decision's questions as the viewer was given them, oldest first. */
		questions: QuestionView[];
		/** The decision's id, signed in alone: the answer routes' address. */
		decisionId?: number;
		/** Whether the viewer may answer now: the answer, publish and replace controls. Never by a personal link. */
		mayAnswer?: boolean;
		/** The version the page shows. */
		shownVersion?: number;
	} = $props();

	const TEXT_MAX = DECISION_TEXT_MAX;
	const uid = $props.id();

	/** What was typed, by question id: an answer, and a replacement of an agent's draft. Kept across a refusal and a reading again. */
	let answers = $state<Record<number, string>>({});
	let replacements = $state<Record<number, string>>({});
	/** The question whose write is in flight. */
	let busy = $state<number | null>(null);
	/** What was done, or the last refusal, said in the status region. */
	let said = $state<{ refused: boolean; words: string } | null>(null);

	const controls = $derived(mayAnswer && decisionId !== undefined);
	/** The element ids of a question's text, and of its answer, which the focus moves to. */
	const textId = (key: number | string) => `${uid}-question-${key}`;
	const answerId = (key: number) => `${uid}-answer-${key}`;
	/** The id of the read-only field that keeps what was typed for a question answered elsewhere. */
	const unsentId = (key: number | string) => `${uid}-unsent-${key}`;

	/**
	 * What a write's answer does: on success the data read again and the focus
	 * on the new answer; on a 409 the data read again and the focus on what was
	 * typed, kept in its "not sent" field, or else on the question's answer or
	 * its text (code review F1); the words said either way.
	 */
	async function settle(res: Response, questionId: number, done: string, clear: () => void) {
		if (res.ok) {
			clear();
			said = { refused: false, words: done };
			await invalidateAll();
			await tick();
			document.getElementById(answerId(questionId))?.focus();
			return;
		}
		said = { refused: true, words: await failureMessage(res, 'Nothing was changed.') };
		if (res.status !== 409) return;
		// Another tab or answerer got there first: the question as it is now, what was typed kept, and the focus not lost with the control that went.
		await invalidateAll();
		await tick();
		const target = document.getElementById(unsentId(questionId)) ?? document.getElementById(answerId(questionId)) ?? document.getElementById(textId(questionId));
		target?.focus();
	}

	const unreached = () => {
		said = { refused: true, words: 'No answer from the server. It is not known whether the answer was saved.' };
	};

	async function sendAnswer(questionId: number) {
		const answer = answers[questionId] ?? '';
		if (busy !== null || answer.trim() === '') return;
		busy = questionId;
		said = null;
		try {
			const res = await fetch(`/api/decisions/${decisionId}/questions/${questionId}/answer`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ answer })
			});
			await settle(res, questionId, 'Your answer was saved.', () => delete answers[questionId]);
		} catch {
			unreached();
		} finally {
			busy = null;
		}
	}

	async function publishDraft(questionId: number) {
		if (busy !== null) return;
		busy = questionId;
		said = null;
		try {
			const res = await fetch(`/api/decisions/${decisionId}/questions/${questionId}/publish`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({})
			});
			// Published: a replacement typed for it is no longer taken, and is not kept as "not sent" (code review F1).
			await settle(res, questionId, "The agent's answer was published.", () => delete replacements[questionId]);
		} catch {
			unreached();
		} finally {
			busy = null;
		}
	}

	async function replaceDraft(questionId: number) {
		const answer = replacements[questionId] ?? '';
		if (busy !== null || answer.trim() === '') return;
		busy = questionId;
		said = null;
		try {
			const res = await fetch(`/api/decisions/${decisionId}/questions/${questionId}/answer`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ answer, replacesDraft: true })
			});
			await settle(res, questionId, "Your answer replaced the agent's.", () => delete replacements[questionId]);
		} catch {
			unreached();
		} finally {
			busy = null;
		}
	}

	/** Text typed for a question that no longer takes it (answered elsewhere), kept so that it is not lost. */
	function unsentFor(question: QuestionView): string {
		if (question.id === undefined) return '';
		// Answered: nothing more is taken. A draft waiting: the plain answer is not. Open with no draft: there is nothing to replace.
		if (question.answer !== null) return answers[question.id] || replacements[question.id] || '';
		return (question.draft !== undefined ? answers[question.id] : replacements[question.id]) || '';
	}
</script>

<div class="questions-panel" data-block="questions">
	{#if questions.length === 0}
		<p class="none">No questions have been asked yet.</p>
	{:else}
		<ol class="question-list" data-list="questions">
			{#each questions as question, index (question.id ?? `n${index}`)}
				{@const n = index + 1}
				{@const key = question.id ?? `n${index}`}
				{@const askedIn = askedInWords(question.askedInVersion, shownVersion)}
				<li class="question" data-question={n}>
					<p class="question-head">
						<span class="number">Question {n}</span>
						{#if question.own}<span class="own" data-note="own">Your question</span>{/if}
						{#if question.askerName !== undefined}<span class="asker" data-note="asker">Asked by {question.askerName}</span>{/if}
						{#if question.askedAt !== undefined}<span class="when">{shownMoment(question.askedAt, '')}</span>{/if}
					</p>
					{#if question.askedByAgent}<p class="asked-by-agent" data-note="asked-by-agent">{ASKED_BY_AGENT}</p>{/if}
					<p class="text" id={textId(key)} tabindex="-1" data-text="question">{question.question}</p>
					{#if askedIn !== null}<p class="asked-in" data-note="asked-in">{askedIn}</p>{/if}

					{#if question.answer !== null}
						<div class="answer" id={question.id === undefined ? undefined : answerId(question.id)} tabindex="-1" data-block="answer">
							<p class="answer-by">
								{answeredByWords(question.answer.answererName, question.answer.answererRole)}, {shownMoment(question.answer.answeredAt, '')}
							</p>
							{#if question.answer.agentDrafted}<AgentLabel reviewed />{/if}
							<p class="text" data-text="answer">{question.answer.text}</p>
						</div>
					{:else if question.draft !== undefined}
						<div class="draft" data-block="draft">
							<AgentLabel />
							<p class="answer-by">Through the API key of {question.draft.drafterName}, {shownMoment(question.draft.draftedAt, '')}</p>
							<p class="text" data-text="draft">{question.draft.text}</p>
						</div>
						{#if controls && question.id !== undefined}
							{@const qid = question.id}
							<div class="controls">
								<div class="control-row">
									<Button
										class="control"
										data-action="publish"
										aria-label={publishDraftName(n)}
										aria-describedby={textId(key)}
										disabled={busy !== null}
										onclick={() => publishDraft(qid)}>Publish the agent's answer</Button
									>
								</div>
								<form
									onsubmit={(e) => {
										e.preventDefault();
										replaceDraft(qid);
									}}
								>
									<label class="ui-label field-label" for="{uid}-replace-{qid}">{replaceFieldName(n)}</label>
									<textarea
										id="{uid}-replace-{qid}"
										class="ui-textarea"
										rows="3"
										maxlength={TEXT_MAX}
										aria-describedby="{textId(key)} {uid}-replace-{qid}-count"
										bind:value={() => replacements[qid] ?? '', (value) => (replacements[qid] = value)}
									></textarea>
									<p class="count" id="{uid}-replace-{qid}-count">{(replacements[qid] ?? '').length} of {TEXT_MAX.toLocaleString('en-GB')} characters</p>
									<div class="control-row">
										<Button
											type="submit"
											variant="outline"
											class="control"
											data-action="replace"
											aria-label={replaceDraftName(n)}
											aria-describedby={textId(key)}
											disabled={busy !== null || (replacements[qid] ?? '').trim() === ''}>Replace the agent's answer</Button
										>
									</div>
								</form>
							</div>
						{/if}
					{:else}
						<p class="unanswered" data-note="unanswered">{unansweredWords(question.closedUnanswered)}</p>
						{#if controls && question.id !== undefined}
							{@const qid = question.id}
							<form
								class="controls"
								onsubmit={(e) => {
									e.preventDefault();
									sendAnswer(qid);
								}}
							>
								<label class="ui-label field-label" for="{uid}-answer-field-{qid}">{answerFieldName(n)}</label>
								<textarea
									id="{uid}-answer-field-{qid}"
									class="ui-textarea"
									rows="3"
									maxlength={TEXT_MAX}
									aria-describedby="{textId(key)} {uid}-answer-field-{qid}-count"
									bind:value={() => answers[qid] ?? '', (value) => (answers[qid] = value)}
								></textarea>
								<p class="count" id="{uid}-answer-field-{qid}-count">{(answers[qid] ?? '').length} of {TEXT_MAX.toLocaleString('en-GB')} characters</p>
								<div class="control-row">
									<Button
										type="submit"
										class="control"
										data-action="answer"
										aria-label={sendAnswerName(n)}
										aria-describedby={textId(key)}
										disabled={busy !== null || (answers[qid] ?? '').trim() === ''}>Send answer</Button
									>
								</div>
							</form>
						{/if}
					{/if}

					{#if unsentFor(question) !== ''}
						<!-- Typed here before the question was answered elsewhere: kept, so that nothing typed is lost (F4). -->
						<div class="unsent" data-block="unsent">
							<label class="ui-label field-label" for={unsentId(key)}>Your answer to question {n}, not sent</label>
							<textarea id={unsentId(key)} class="ui-textarea" rows="3" readonly value={unsentFor(question)}></textarea>
						</div>
					{/if}
				</li>
			{/each}
		</ol>
	{/if}

	<!-- One region for every control, drawn from the start, so a screen reader hears each change of its words (F4). -->
	<p class="said" class:refused={said?.refused} role="status" data-said="questions">{said?.words ?? ''}</p>
</div>

<style>
	.questions-panel { display: flex; flex-direction: column; gap: var(--space-sm); font-size: 1rem; color: var(--ui-foreground); }
	.questions-panel p { margin: 0; }
	.none { font-size: 0.875rem; color: var(--ui-muted-foreground); }
	.question-list { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: var(--space-md); }
	.question {
		display: flex; flex-direction: column; gap: var(--space-xs); min-width: 0;
		padding: 1rem 1.25rem;
		border: 1px solid var(--ui-border); border-radius: var(--ui-radius-lg);
		background: var(--ui-card); box-shadow: var(--ui-shadow-sm);
	}
	/* A long name with no break wraps at phone width rather than pushing the page sideways (code review F8). */
	.question-head { display: flex; flex-wrap: wrap; gap: var(--space-xs) var(--space-sm); font-size: 0.8125rem; color: var(--ui-muted-foreground); overflow-wrap: anywhere; min-width: 0; }
	.number { font-weight: 600; color: var(--ui-foreground); }
	.own { font-weight: 600; color: var(--ui-foreground); }
	.asked-by-agent, .asked-in, .unanswered, .answer-by { font-size: 0.8125rem; color: var(--ui-muted-foreground); }
	.answer-by { overflow-wrap: anywhere; min-width: 0; }
	/* As typed, never markup (decision 3). */
	.text { white-space: pre-wrap; overflow-wrap: anywhere; max-width: 80ch; }
	.answer, .draft { display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-xs); padding-left: var(--space-md); border-left: 3px solid var(--ui-border); }
	.answer:focus, .text:focus { outline: 2px solid var(--ui-ring); outline-offset: 2px; }
	.controls { display: flex; flex-direction: column; gap: var(--space-xs); max-width: 48rem; }
	form { display: flex; flex-direction: column; gap: var(--space-xs); }
	/* Read-only: the muted fill (the kit has no read-only look of its own). */
	.ui-textarea[readonly] { background: var(--ui-muted); }
	.count { font-size: 0.75rem; color: var(--ui-muted-foreground); text-align: right; }
	.control-row { display: flex; }
	.unsent { display: flex; flex-direction: column; gap: var(--space-xs); max-width: 48rem; }
	.said { font-size: 0.875rem; color: var(--ui-foreground); }
	/* A refusal: the words in the text colour, marked by the destructive tone. */
	.said.refused { padding-left: 0.625rem; border-left: 3px solid var(--ui-destructive); }
</style>