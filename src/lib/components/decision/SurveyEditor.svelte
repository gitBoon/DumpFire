<!--
  SurveyEditor.svelte — a decision's survey questions in its editor (card
  2683, R3, R5, R8, R16, slice S3a).

  The editor's list of the author's own questions, bound to its form: each a
  kind (pick one of its choices, a number on a scale, or a short written
  answer), a one-line prompt, markdown help and whether it must be answered;
  a choice question's choices, one a line, and a scale question's top (2 to
  10) and the words at each end. Questions are added, removed and moved here;
  the editor's Save sends them, and the server gives a new one its id.

  A question published in a version (`published`, by the id its row holds)
  keeps its kind (R8), shown read-only, and says that a change to anything
  but its help asks everyone again when the decision is re-published, as
  Tell them only is then refused. One an agent wrote carries the editor's
  agent label and Mark reviewed (`flag`, under `survey.<questionId>`, R16).

  `surveyFormOf` and `surveyContentOf` turn the content's questions into the
  form's and back: each sends only its own kind's keys, as the server's reader
  is closed per kind (R3).
-->
<script module lang="ts">
	import type { SurveyKind, SurveyQuestion } from '$lib/decision-readiness';

	/** A survey question as the form edits it: its choices as one a line, and its scale's fields whatever its kind, kept while the kind is changed. */
	export type SurveyDraft = {
		key: number;
		questionId?: number;
		kind: SurveyKind;
		prompt: string;
		help: string;
		required: boolean;
		choices: string;
		max: number | null;
		lowLabel: string;
		highLabel: string;
	};

	/** The content's questions as the form edits them, each given a key by `key`. */
	export function surveyFormOf(questions: SurveyQuestion[], key: () => number): SurveyDraft[] {
		return questions.map((question) => ({
			key: key(),
			...(question.questionId === undefined ? {} : { questionId: question.questionId }),
			kind: question.kind,
			prompt: question.prompt,
			help: question.help,
			required: question.required,
			choices: (question.choices ?? []).join('\n'),
			max: question.scale?.max ?? 5,
			lowLabel: question.scale?.lowLabel ?? '',
			highLabel: question.scale?.highLabel ?? ''
		}));
	}

	/** The form's questions as a body's `surveyQuestions`: `choices` on a choice question alone and `scale` on a scale question alone (R3). */
	export function surveyContentOf(drafts: SurveyDraft[]): SurveyQuestion[] {
		return drafts.map((draft) => ({
			...(draft.questionId === undefined ? {} : { questionId: draft.questionId }),
			kind: draft.kind,
			prompt: draft.prompt,
			help: draft.help,
			required: draft.required,
			...(draft.kind === 'choice'
				? {
						choices: draft.choices
							.split('\n')
							.map((line) => line.trim())
							.filter((line) => line !== '')
					}
				: {}),
			...(draft.kind === 'scale' ? { scale: { max: Number(draft.max), lowLabel: draft.lowLabel, highLabel: draft.highLabel } } : {})
		}));
	}

	/** Each kind in the author's words. */
	export const SURVEY_KIND_WORDS: Readonly<Record<SurveyKind, string>> = {
		choice: 'Pick one of its choices',
		scale: 'A number on a scale',
		text: 'A short written answer'
	};
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import { SURVEY_KINDS } from '$lib/decision-readiness';

	let {
		questions = $bindable(),
		editable,
		published,
		flag,
		newKey
	}: {
		/** The form's questions, in their order. */
		questions: SurveyDraft[];
		editable: boolean;
		/** The ids of the questions a version has published: their kind is fixed (R8). */
		published: ReadonlySet<number>;
		/** The editor's agent label and Mark reviewed, by flag key and the name its button gives. */
		flag: Snippet<[string, string]>;
		/** A key for a question added here, from the editor's own counter. */
		newKey: () => number;
	} = $props();

	const uid = $props.id();

	function addQuestion() {
		questions.push({ key: newKey(), kind: 'choice', prompt: '', help: '', required: false, choices: '', max: 5, lowLabel: '', highLabel: '' });
	}
	function moveQuestion(index: number, by: -1 | 1) {
		const to = index + by;
		if (to < 0 || to >= questions.length) return;
		const [moved] = questions.splice(index, 1);
		questions.splice(to, 0, moved);
	}
	const isPublished = (question: SurveyDraft) => question.questionId !== undefined && published.has(question.questionId);

	/** Under a published question (R8): what may change, and what a change does. */
	const PUBLISHED_NOTE =
		'Published: its kind is fixed, so remove it and add a new question to ask another kind. A change to anything but its help asks everyone again when the decision is re-published.';
</script>

<section class="editor-section" data-part="survey">
	<div class="section-head"><h2 id="{uid}-heading">Survey questions</h2></div>
	<p class="ui-hint help" id="{uid}-help">
		Your own questions for the people consulted: pick one, a number on a scale, or a short written answer. A decision with no options asks these alone; re-publish
		it with options to put them to a vote.
	</p>
	{#each questions as question, index (question.key)}
		{@const fixed = isPublished(question)}
		{@const id = `${uid}-q${question.key}`}
		<div class="entry" role="group" aria-labelledby="{id}-name" data-survey={index}>
			<div class="section-head">
				<span class="question-name" id="{id}-name">Survey question {index + 1}</span>
				{#if question.questionId !== undefined}{@render flag(`survey.${question.questionId}`, `survey question ${index + 1}`)}{/if}
			</div>

			{#if fixed || !editable}
				<!-- Code review F8: a fixed kind is text, not a field, so no <label for> names it. -->
				<p class="ui-label" data-name="kind">Kind</p>
				<p id="{id}-kind" class="fixed" data-kind={question.kind}>{SURVEY_KIND_WORDS[question.kind]}</p>
			{:else}
				<label class="ui-label" for="{id}-kind">Kind</label>
				<select id="{id}-kind" class="ui-select" bind:value={question.kind}>
					{#each SURVEY_KINDS as kind (kind)}
						<option value={kind}>{SURVEY_KIND_WORDS[kind]}</option>
					{/each}
				</select>
			{/if}
			{#if fixed}<p class="ui-hint note" data-note="published">{PUBLISHED_NOTE}</p>{/if}

			<label class="ui-label" for="{id}-prompt">Prompt</label>
			<input id="{id}-prompt" class="ui-input" maxlength="300" readonly={!editable} bind:value={question.prompt} />
			<label class="ui-label" for="{id}-help">Help (optional)</label>
			<textarea id="{id}-help" class="ui-textarea" rows="2" readonly={!editable} bind:value={question.help}></textarea>

			{#if question.kind === 'choice'}
				<label class="ui-label" for="{id}-choices">Choices, one a line (2 to 20)</label>
				<textarea id="{id}-choices" class="ui-textarea" rows="4" readonly={!editable} bind:value={question.choices}></textarea>
			{:else if question.kind === 'scale'}
				<div class="scale-fields">
					<div class="scale-field">
						<label class="ui-label" for="{id}-max">Top of the scale (2 to 10)</label>
						<input id="{id}-max" class="ui-input" type="number" min="2" max="10" step="1" readonly={!editable} bind:value={question.max} />
					</div>
					<div class="scale-field">
						<label class="ui-label" for="{id}-low">Words at 1</label>
						<input id="{id}-low" class="ui-input" maxlength="100" readonly={!editable} bind:value={question.lowLabel} />
					</div>
					<div class="scale-field">
						<label class="ui-label" for="{id}-high">Words at the top</label>
						<input id="{id}-high" class="ui-input" maxlength="100" readonly={!editable} bind:value={question.highLabel} />
					</div>
				</div>
			{/if}

			<label class="required"><input type="checkbox" disabled={!editable} bind:checked={question.required} /> Must be answered</label>

			{#if editable}
				<div class="question-actions">
					<Button variant="ghost" size="icon" aria-label="Move survey question {index + 1} up" disabled={index === 0} onclick={() => moveQuestion(index, -1)}>↑</Button>
					<Button
						variant="ghost"
						size="icon"
						aria-label="Move survey question {index + 1} down"
						disabled={index === questions.length - 1}
						onclick={() => moveQuestion(index, 1)}>↓</Button
					>
					<Button variant="ghost" size="sm" aria-label="Remove survey question {index + 1}" onclick={() => questions.splice(index, 1)}>Remove</Button>
				</div>
			{/if}
		</div>
	{/each}
	{#if editable}<div class="add-row"><Button variant="outline" size="sm" aria-describedby="{uid}-help" onclick={addQuestion}>+ Add survey question</Button></div>{/if}
</section>

<style>
	.editor-section { display: flex; flex-direction: column; gap: var(--space-sm); }
	.section-head { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-sm); }
	.section-head h2 { font-size: 0.9375rem; font-weight: 600; margin: 0; }
	.question-name { font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ui-muted-foreground); }
	.entry {
		display: flex; flex-direction: column; gap: var(--space-sm);
		padding: 1rem 1.25rem;
		border: 1px solid var(--ui-border); border-radius: var(--ui-radius-lg);
		background: var(--ui-card); box-shadow: var(--ui-shadow-sm);
	}
	/* Read-only: the muted fill (the kit has no read-only look of its own). */
	.ui-input[readonly], .ui-textarea[readonly] { background: var(--ui-muted); }
	.ui-label { margin: var(--space-xs) 0 0; }
	.fixed { font-size: 0.875rem; margin: 0; }
	.help, .note { margin: 0; }
	.scale-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 9rem), 1fr)); gap: var(--space-sm); }
	.scale-field { display: flex; flex-direction: column; gap: var(--space-xs); }
	.required { display: flex; align-items: center; gap: var(--space-xs); font-size: 0.875rem; }
	.question-actions { display: flex; gap: var(--space-xs); justify-content: flex-end; }
	.add-row { display: flex; }
</style>
