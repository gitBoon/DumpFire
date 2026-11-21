<!--
  SurveyQuestions.svelte — a decision's survey questions as its participants
  read and answer them (card 2683, R3, R10, R14, slice S3b).

  Each question in the version's order, numbered, with "(required)" where it
  must be answered, the agent label where an agent wrote it and no person has
  reviewed it (`survey.<questionId>`, R16), and its help as markdown through
  the sanitising renderer. The prompt and every choice are plain text.

  With `onAnswer` it draws the inputs, for `ResponseForm`: a choice question's
  choices as large radios, a scale question's numbers 1 to its top as radios
  with the words at each end, and a written answer's box (at most 2,000
  characters) with `SURVEY_TEXT_NOTE` under it (R14). What is chosen or typed
  is handed up by question id (`onAnswer`); the form keeps it and sends it.
  An optional choice or scale question answered has a Clear control, which
  hands up `''`, unanswered, as a written answer emptied is.
  `disabled` draws the inputs and takes nothing, for the preview. Without
  `onAnswer` it draws the questions alone, with no input: for an informed
  participant, anyone else who may view the decision, and a consulted one
  once responses are closed.

  `whoSees`, where given, is `surveyWhoSees`' sentence (R10), said above the
  questions: whoever decides and the administrators see the answers, with
  names, and nobody else, never as totals. It fetches and posts nothing, and
  shows no one's answers but those it is handed.
-->
<script lang="ts">
	import type { PublishedSurveyQuestion } from '$lib/decision-view-types';
	import { SURVEY_TEXT_NOTE } from '$lib/decision-words';
	import AgentLabel from './AgentLabel.svelte';
	import MarkdownBlock from './MarkdownBlock.svelte';

	let {
		questions,
		answers = {},
		onAnswer,
		disabled = false,
		whoSees = null
	}: {
		/** The questions, as the version shown published them. */
		questions: (PublishedSurveyQuestion & { agentDrafted?: boolean })[];
		/** What is answered so far, by question id: a choice's index, a scale's number or a written answer. */
		answers?: Record<string, number | string>;
		/** Given: the inputs are drawn, and each answer is handed up by question id. */
		onAnswer?: (questionId: number, value: number | string) => void;
		/** The inputs drawn, and nothing taken (the preview). */
		disabled?: boolean;
		/** `surveyWhoSees`' sentence, said above the questions; null for none. */
		whoSees?: string | null;
	} = $props();

	const uid = $props.id();
	const inputs = $derived(onAnswer !== undefined);
	const answerOf = (questionId: number) => answers[String(questionId)];
	const scalePoints = (max: number) => Array.from({ length: max }, (_, index) => index + 1);
	/**
	 * Code review F8: an optional choice or scale question answered can be left unanswered again, as a written answer
	 * can be emptied: its answer is handed up as `''`, which the form reads as unanswered and does not send.
	 */
	const clearable = (question: PublishedSurveyQuestion) =>
		inputs && !disabled && !question.required && question.kind !== 'text' && typeof answerOf(question.questionId) === 'number';
</script>

<div class="survey" data-survey={inputs ? 'answer' : 'read'}>
	{#if whoSees !== null}
		<p class="survey-who-sees" data-note="survey-who-sees">{whoSees}</p>
	{/if}
	{#each questions as question, index (question.questionId)}
		{@const name = `${uid}-q${question.questionId}`}
		<fieldset class="survey-question" data-question={question.questionId} data-kind={question.kind}>
			<legend class="prompt" id="{name}-prompt">{index + 1}. {question.prompt}{question.required ? ' (required)' : ''}</legend>
			{#if question.agentDrafted}<AgentLabel tag="p" data-flag="survey.{question.questionId}" />{/if}
			{#if question.help !== ''}<MarkdownBlock text={question.help} />{/if}

			{#if question.kind === 'choice'}
				{#if inputs}
					{#each question.choices ?? [] as choice, i (i)}
						<label class="choice-card" class:chosen={answerOf(question.questionId) === i}>
							<input
								type="radio"
								{name}
								value={String(i)}
								checked={answerOf(question.questionId) === i}
								{disabled}
								onchange={() => onAnswer?.(question.questionId, i)}
							/>
							<span>{choice}</span>
						</label>
					{/each}
				{:else}
					<ul class="survey-choices">
						{#each question.choices ?? [] as choice, i (i)}<li>{choice}</li>{/each}
					</ul>
				{/if}
			{:else if question.kind === 'scale' && question.scale !== undefined}
				{@const scale = question.scale}
				<p class="scale-ends" id="{name}-ends">
					A number from 1{scale.lowLabel ? ` (${scale.lowLabel})` : ''} to {scale.max}{scale.highLabel ? ` (${scale.highLabel})` : ''}.
				</p>
				{#if inputs}
					<div class="scale-points">
						{#each scalePoints(scale.max) as value (value)}
							<label class="scale-point" class:chosen={answerOf(question.questionId) === value}>
								<input
									type="radio"
									{name}
									value={String(value)}
									aria-label="{value} of {scale.max}{value === 1 && scale.lowLabel ? `, ${scale.lowLabel}` : ''}{value === scale.max && scale.highLabel ? `, ${scale.highLabel}` : ''}"
									aria-describedby="{name}-ends"
									checked={answerOf(question.questionId) === value}
									{disabled}
									onchange={() => onAnswer?.(question.questionId, value)}
								/>
								<span aria-hidden="true">{value}</span>
							</label>
						{/each}
					</div>
				{/if}
			{:else if question.kind === 'text'}
				{#if inputs}
					{@const typed = answerOf(question.questionId)}
					<textarea
						rows="3"
						maxlength="2000"
						aria-labelledby="{name}-prompt"
						aria-describedby="{name}-note"
						value={typeof typed === 'string' ? typed : ''}
						{disabled}
						oninput={(e) => onAnswer?.(question.questionId, e.currentTarget.value)}
					></textarea>
					<p class="survey-note" id="{name}-note" data-note="survey-text">{SURVEY_TEXT_NOTE}</p>
				{:else}
					<p class="survey-kind">A short written answer.</p>
				{/if}
			{/if}
			{#if clearable(question)}
				<button
					type="button"
					class="clear"
					data-action="clear-answer"
					aria-label="Clear the answer to question {index + 1}"
					onclick={() => onAnswer?.(question.questionId, '')}>Clear</button
				>
			{/if}
		</fieldset>
	{/each}
</div>

<style>
	.survey { display: flex; flex-direction: column; gap: var(--space-md); min-width: 0; }
	.survey-who-sees { margin: 0; font-size: 0.9rem; color: var(--text-secondary); }
	.survey-question { border: 1px solid var(--glass-border); border-radius: var(--radius-md); margin: 0; padding: var(--space-sm) var(--space-md) var(--space-md); min-width: 0; display: flex; flex-direction: column; gap: var(--space-sm); }
	.prompt { font-weight: 600; padding: 0 var(--space-xs); overflow-wrap: anywhere; }
	.survey-choices { margin: 0; padding-left: 1.2rem; }
	.survey-choices li { overflow-wrap: anywhere; }
	/* Every tap target 44px tall at least, every input 16px, so a phone does not zoom (card 2677, decision 22). */
	.choice-card {
		display: flex; align-items: center; gap: var(--space-md); min-height: 44px; padding: var(--space-sm) var(--space-md);
		border: 1px solid var(--glass-border); border-radius: var(--radius-md); background: var(--bg-elevated); cursor: pointer;
	}
	.choice-card span { overflow-wrap: anywhere; min-width: 0; }
	.choice-card.chosen, .scale-point.chosen { border-color: var(--accent-indigo); box-shadow: 0 0 0 1px var(--accent-indigo); }
	.choice-card input { width: 1.25rem; height: 1.25rem; flex-shrink: 0; }
	.scale-ends, .survey-kind { margin: 0; font-size: 0.9rem; color: var(--text-secondary); overflow-wrap: anywhere; }
	.scale-points { display: grid; grid-template-columns: repeat(auto-fit, minmax(44px, 1fr)); gap: var(--space-xs); }
	.scale-point {
		display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 44px; cursor: pointer;
		border: 1px solid var(--glass-border); border-radius: var(--radius-sm); background: var(--bg-elevated);
	}
	.scale-point input { margin: 0; }
	textarea {
		font-size: 16px; font-family: var(--font-family); padding: var(--space-sm); width: 100%; box-sizing: border-box;
		border: 1px solid var(--glass-border); border-radius: var(--radius-sm); background: var(--bg-elevated); color: var(--text-primary);
	}
	.survey-note { margin: 0; font-size: 0.85rem; color: var(--text-secondary); }
	.clear {
		align-self: flex-start; min-height: 44px; padding: 0 var(--space-md); font-size: 0.9rem; cursor: pointer;
		border: 1px solid var(--glass-border); border-radius: var(--radius-sm); background: transparent; color: var(--text-secondary);
	}
</style>
