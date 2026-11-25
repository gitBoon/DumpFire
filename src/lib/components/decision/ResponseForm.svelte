<!--
  A consulted participant's response (card 2677, decisions 11, 21 and 22).

  The choices are large radio cards: in single mode one per option, then "I
  abstain" and "I have no concerns"; in score mode a row of six buttons, 0 to
  5, for each option, a radio group named by its option, with the same two
  choices beside them. Send is offered once the choice is whole: a score for
  every option, in score mode. A comment, and a comment on any option, below;
  each is shown back as text, never as markdown.

  Send posts `{ ...extra, versionNumber, statement, kind, optionId | scores,
  comment, optionComments }` as JSON to `url`: the signed-in page's route, or
  the personal link's with the token in `extra`, so that no address holds it.
  `statement` is `WHO_SEES_STATEMENT_VERSION`, the version of the who-sees
  words the page showed, which the response is recorded under (card 2679,
  decision 25). The
  answer is the response as recorded, which the form shows. A refusal is said
  in the server's words and what was typed is kept; the 409 in
  `STALE_REVISION`'s words alone offers Reload.

  A recorded response given on an older version than `versionNumber` is
  labelled with its version (code review C1): sending it again binds it to
  this one.

  `disabled` draws the form and sends nothing, for card 2697's preview, which
  has no version and nowhere to send: `versionNumber` and `url` are then not
  needed (code review C9).

  Card 2683 (R2, R12, R14): with `surveyQuestions`, the version's survey
  questions are drawn with their inputs (`SurveyQuestions`), under
  `surveyWhoSees`' sentence, and `answers` is sent, keyed by question id,
  built by walking the questions shown, never from the keys typed into; a
  written answer of spaces alone is no answer. A round with no options (a
  survey) offers "I answer the questions" (`answered`) and "I abstain"
  alone; answering a question chooses the first where nothing is chosen yet.
  Send is held until every required question is answered, but to abstain.
  The response recorded is said back with its answers, by prompt.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { failureMessage } from '$lib/api';
	import Button from '$lib/components/ui/Button.svelte';
	import type { OwnResponse, ViewOption, ViewSurveyQuestion } from '$lib/decision-view-types';
	import { STALE_REVISION, WHO_SEES_STATEMENT_VERSION, givenOnWords, responseLines, shownMoment, surveyAnswerLines, surveyWhoSees } from '$lib/decision-words';
	import SurveyQuestions from './SurveyQuestions.svelte';

	type Kind = OwnResponse['kind'];
	type Common = {
		voteMode: 'single' | 'score';
		options: ViewOption[];
		/** Card 2683: the version's survey questions, answered with the response; none by default. */
		surveyQuestions?: ViewSurveyQuestion[];
		/** Card 2683 (R10): the decider's name now, for `surveyWhoSees`; null for none yet. */
		deciderName?: string | null;
		/** Sent with the response, beside it: the personal link's token. */
		extra?: Record<string, unknown>;
		/** The participant's latest response in this round, which the form starts from. */
		initial?: OwnResponse | null;
		/** Reads the page again, after a 409 in STALE_REVISION's words. */
		onReload?: () => void;
		/** Card 3075: a response was recorded; the page reads its data again. None by default. */
		onRecorded?: (response: OwnResponse) => unknown;
	};
	type Props = Common &
		(
			| {
					/** The version the response is for: the one shown. */
					versionNumber: number;
					/** Where Send posts. */
					url: string;
					disabled?: false;
			  }
			| {
					versionNumber?: number;
					url?: string;
					/** Drawn, and never sent (D4). */
					disabled: true;
			  }
		);
	let {
		voteMode,
		options,
		surveyQuestions = [],
		deciderName = null,
		versionNumber,
		url,
		extra = {},
		disabled = false,
		initial = null,
		onReload = () => location.reload(),
		onRecorded = () => {}
	}: Props = $props();

	const start = untrack(() => initial);
	let kind = $state<Kind | null>(start?.kind ?? null);
	let optionId = $state<number | null>(start?.optionId ?? null);
	let scores = $state<Record<string, number>>({ ...(start?.scores ?? {}) });
	let comment = $state(start?.comment ?? '');
	let optionComments = $state<Record<string, string>>({ ...(start?.optionComments ?? {}) });
	// Card 2683: `initial` is this round's response, whose questions a re-publish that only told of a change cannot alter (R7, R8).
	let answers = $state<Record<string, number | string>>({ ...(start?.answers ?? {}) });

	let recorded = $state<OwnResponse | null>(start);
	let sending = $state(false);
	let error = $state('');
	let stale = $state(false);

	/** Card 2683 (R4): a round that puts no options to a vote, and asks survey questions alone. */
	const surveyOnly = $derived(options.length === 0 && surveyQuestions.length > 0);
	/** Card 2683 (R13): whether a question is answered; a written answer of spaces alone is not. */
	const answered = (question: ViewSurveyQuestion) => {
		const value = answers[String(question.questionId)];
		return typeof value === 'number' || (typeof value === 'string' && value.trim() !== '');
	};
	/** Card 2683 (R12): every required question answered, as a vote, no concerns and answers must have them; abstaining need not. */
	const requiredAnswered = $derived(surveyQuestions.every((question) => !question.required || answered(question)));

	/** Whether the choice is whole: one option, a score for every option, or a choice that needs neither; and, but to abstain, the required questions answered. */
	const ready = $derived.by(() => {
		if (kind === null) return false;
		if (kind === 'abstain') return true;
		if (!requiredAnswered) return false;
		if (kind === 'answered') return surveyQuestions.some(answered);
		if (kind !== 'vote') return true;
		return voteMode === 'single' ? optionId !== null : options.every((option) => scores[String(option.optionId)] !== undefined);
	});

	function answer(questionId: number, value: number | string) {
		answers = { ...answers, [String(questionId)]: value };
		if (surveyOnly && kind === null) kind = 'answered';
	}

	function choose(next: Kind, option: number | null = null) {
		kind = next;
		optionId = option;
	}

	function score(option: number, value: number) {
		scores = { ...scores, [String(option)]: value };
		kind = 'vote';
	}

	async function send() {
		if (disabled || url === undefined || versionNumber === undefined || sending || !ready || kind === null) return;
		// The version of the who-sees statement this page showed, from the same bundle as its words (card 2679, decision 25).
		const body: Record<string, unknown> = { ...extra, versionNumber, statement: WHO_SEES_STATEMENT_VERSION, kind };
		if (kind === 'vote' && voteMode === 'single') body.optionId = optionId;
		if (kind === 'vote' && voteMode === 'score') body.scores = Object.fromEntries(options.map((option) => [String(option.optionId), scores[String(option.optionId)]]));
		body.comment = comment;
		body.optionComments = Object.fromEntries(
			options.map((option) => [String(option.optionId), optionComments[String(option.optionId)] ?? '']).filter(([, text]) => text.trim() !== '')
		);
		// Card 2683 (R2): by walking the questions shown, never from the keys typed into; sent only where there are questions.
		if (surveyQuestions.length > 0) {
			body.answers = Object.fromEntries(surveyQuestions.filter(answered).map((question) => [String(question.questionId), answers[String(question.questionId)]]));
		}

		sending = true;
		error = '';
		stale = false;
		try {
			const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
			if (res.ok) {
				const answer = (await res.json()) as { response: OwnResponse; unchanged: boolean };
				recorded = answer.response;
				// Card 3075 (review M1): the page is told, so what it shows of the response (its side column) is read again. Not
				// awaited, and a failed read again is not this form's refusal: the response was recorded.
				void Promise.resolve(onRecorded(answer.response)).catch(() => {});
			} else {
				error = await failureMessage(res, 'Your response was not recorded.');
				// Reload throws away what was chosen: offered only on the stale-version words (2676 C6).
				stale = res.status === 409 && error === STALE_REVISION;
			}
		} catch {
			error = 'No answer from the server. It is not known whether your response was recorded.';
		} finally {
			sending = false;
		}
	}

	/** One radio group per form, named the same on the server and in the browser. */
	const uid = $props.id();
	const name = `response-${uid}`;
</script>

<form
	class="response-form"
	data-disabled={disabled ? 'yes' : 'no'}
	onsubmit={(e) => {
		e.preventDefault();
		send();
	}}
>
	{#if surveyOnly}
		<SurveyQuestions questions={surveyQuestions} {answers} onAnswer={answer} {disabled} whoSees={surveyWhoSees(deciderName ?? 'the decider')} />
		<fieldset class="choices">
			<legend>Your response</legend>
			<label class="choice-card" class:chosen={kind === 'answered'}>
				<input type="radio" name={name} value="answered" checked={kind === 'answered'} {disabled} onchange={() => choose('answered')} />
				<span>I answer the questions</span>
			</label>
			<label class="choice-card" class:chosen={kind === 'abstain'}>
				<input type="radio" name={name} value="abstain" checked={kind === 'abstain'} {disabled} onchange={() => choose('abstain')} />
				<span>I abstain</span>
			</label>
		</fieldset>
	{:else if voteMode === 'single'}
		<fieldset class="choices">
			<legend>Your choice</legend>
			{#each options as option (option.optionId)}
				<label class="choice-card" class:chosen={kind === 'vote' && optionId === option.optionId}>
					<input
						type="radio"
						name={name}
						value="option-{option.optionId}"
						checked={kind === 'vote' && optionId === option.optionId}
						{disabled}
						onchange={() => choose('vote', option.optionId)}
					/>
					<span><strong>Option {option.label}</strong>{option.title ? `: ${option.title}` : ''}</span>
				</label>
			{/each}
			{@render otherChoices()}
		</fieldset>
	{:else}
		<fieldset class="choices">
			<legend>Score each option from 0 to 5</legend>
			{#each options as option (option.optionId)}
				<div class="score-row" role="radiogroup" aria-label="Score for option {option.label}">
					<span class="score-name"><strong>Option {option.label}</strong>{option.title ? `: ${option.title}` : ''}</span>
					<div class="score-buttons">
						{#each [0, 1, 2, 3, 4, 5] as value (value)}
							<button
								type="button"
								role="radio"
								class="score"
								aria-checked={kind === 'vote' && scores[String(option.optionId)] === value ? 'true' : 'false'}
								aria-label="{value} for option {option.label}"
								{disabled}
								onclick={() => score(option.optionId, value)}>{value}</button
							>
						{/each}
					</div>
				</div>
			{/each}
			{@render otherChoices()}
		</fieldset>
	{/if}
	{#if !surveyOnly && surveyQuestions.length > 0}
		<SurveyQuestions questions={surveyQuestions} {answers} onAnswer={answer} {disabled} whoSees={surveyWhoSees(deciderName ?? 'the decider')} />
	{/if}
	{#if kind !== null && kind !== 'abstain' && !requiredAnswered}
		<p class="required-note" data-note="required">Answer every required question to send your response, or abstain.</p>
	{/if}

	<label class="comment">
		<span class="ui-label">Your comment (optional)</span>
		<textarea class="ui-textarea" maxlength="4000" rows="4" bind:value={comment} {disabled}></textarea>
	</label>
	{#if options.length > 0}
		<details class="option-comments">
			<summary>Comment on an option (optional)</summary>
			{#each options as option (option.optionId)}
				<label class="comment">
					<span class="ui-label">Comment on option {option.label}</span>
					<textarea class="ui-textarea" maxlength="2000" rows="3" bind:value={optionComments[String(option.optionId)]} {disabled}></textarea>
				</label>
			{/each}
		</details>
	{/if}

	{#if error}
		<p class="form-error" role="alert">{error}</p>
		{#if stale}<div class="send-row"><Button variant="outline" class="reload" onclick={() => onReload()}>Reload</Button></div>{/if}
	{/if}

	<div class="send-row"><Button type="submit" class="send" disabled={disabled || sending || !ready} aria-busy={sending ? 'true' : undefined}>Send my response</Button></div>

	{#if recorded !== null}
		{@const givenOn = givenOnWords(recorded, versionNumber)}
		<div class="recorded" role="status">
			<p>Your response was recorded on {shownMoment(recorded.createdAt, '')}:</p>
			{#each [...responseLines(recorded, options), ...surveyAnswerLines(recorded.answers, surveyQuestions)] as line, i (i)}<p class="response-line">{line}</p>{/each}
			{#if givenOn !== null}<p class="given-on">{givenOn} Send it again to give it on version {versionNumber}.</p>{/if}
		</div>
	{/if}
</form>

{#snippet otherChoices()}
	<label class="choice-card" class:chosen={kind === 'abstain'}>
		<input type="radio" name={name} value="abstain" checked={kind === 'abstain'} {disabled} onchange={() => choose('abstain')} />
		<span>I abstain</span>
	</label>
	<label class="choice-card" class:chosen={kind === 'no_concerns'}>
		<input type="radio" name={name} value="no_concerns" checked={kind === 'no_concerns'} {disabled} onchange={() => choose('no_concerns')} />
		<span>I have no concerns</span>
	</label>
{/snippet}

<style>
	.response-form { display: flex; flex-direction: column; gap: var(--space-md); font-size: 1rem; color: var(--ui-foreground); }
	.choices { border: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-sm); min-width: 0; }
	.choices legend { font-weight: 600; margin-bottom: var(--space-sm); }
	/* Every tap target 44px tall at least, every input 16px on a touch screen, so a phone does not zoom (decision 22). */
	.choice-card {
		display: flex; align-items: center; gap: var(--space-md); min-height: 44px; padding: var(--space-sm) var(--space-md);
		border: 1px solid var(--ui-border); border-radius: var(--ui-radius-lg); background: var(--ui-card); cursor: pointer;
		transition: border-color var(--duration-fast) var(--ease-out), box-shadow var(--duration-fast) var(--ease-out);
	}
	.choice-card:hover { border-color: var(--ui-input); }
	.choice-card.chosen { border-color: var(--ui-primary); box-shadow: 0 0 0 1px var(--ui-primary); }
	.choice-card input { width: 1.25rem; height: 1.25rem; flex-shrink: 0; accent-color: var(--ui-primary); }
	.score-row { display: flex; flex-direction: column; gap: var(--space-xs); padding: var(--space-sm) 0; border-bottom: 1px solid var(--ui-border); }
	.score-buttons { display: grid; grid-template-columns: repeat(6, minmax(44px, 1fr)); gap: var(--space-xs); max-width: 32rem; }
	/* The scores keep their radio role; drawn as the kit's outline controls, the chosen one filled. */
	.score {
		min-height: 44px; font-size: 1rem; font-weight: 500; font-family: var(--font-family); cursor: pointer;
		border: 1px solid var(--ui-input); border-radius: var(--ui-radius); background: var(--ui-background); color: var(--ui-foreground);
		transition: background-color var(--duration-fast) var(--ease-out);
	}
	.score:hover:not(:disabled) { background: var(--ui-muted); }
	.score:focus-visible { outline: 2px solid var(--ui-ring); outline-offset: 2px; }
	.score:disabled { opacity: 0.5; cursor: not-allowed; }
	.score[aria-checked='true'] { background: var(--ui-primary); border-color: var(--ui-primary); color: var(--ui-primary-foreground); }
	.comment { display: flex; flex-direction: column; gap: var(--space-xs); max-width: 48rem; }
	.option-comments > summary { min-height: 44px; display: flex; align-items: center; cursor: pointer; border-radius: var(--ui-radius-sm); }
	.option-comments > summary:focus-visible { outline: 2px solid var(--ui-ring); outline-offset: 2px; }
	.option-comments .comment { margin-top: var(--space-sm); }
	.send-row { display: flex; }
	/* A refusal: the words in the text colour, marked by the destructive tone. */
	.form-error { margin: 0; padding-left: 0.625rem; border-left: 3px solid var(--ui-destructive); color: var(--ui-foreground); }
	.required-note { margin: 0; font-size: 0.875rem; color: var(--ui-muted-foreground); }
	.recorded {
		padding: var(--space-md);
		border: 1px solid color-mix(in srgb, var(--ui-success) 35%, transparent);
		border-radius: var(--ui-radius-lg);
		background: color-mix(in srgb, var(--ui-success) 8%, var(--ui-background));
	}
	.recorded p { margin: 0 0 var(--space-xs); }
	.given-on { font-weight: 600; }
	.response-line { white-space: pre-wrap; overflow-wrap: anywhere; }
	@media (prefers-reduced-motion: reduce) {
		.choice-card, .score { transition: none; }
	}
</style>