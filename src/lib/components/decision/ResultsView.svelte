<!--
  ResultsView.svelte — a decision's results, for its decider and DumpFire's
  administrators alone (card 2679, decisions 1 and 16).

  The current round's tally is a table with a header for each column and for
  each row; in score mode the number who voted, abstained and had no concerns
  are counts beside it, in a Count column of their own (code review F6). Each
  earlier round is in a closed `<details>` of its own. Then
  each latest response with the participant's name, those who have not
  responded, the removed, the open questions, the concerns, and the ruling as
  the record holds it, "against", "early" and the cut-off names among it.
  Card 2738: a non-responder or a cut-off the round's request never reached
  is marked so (`NOT_REACHED_WORDS`), in the same list.

  The open questions (card 2678, decision 9, F11) are those no person's
  answer stands behind: each with who asked and when, its text as typed
  (`pre-wrap`), and `AgentLabel` on one an agent's unpublished draft waits
  on. The link to answer them on the decision's page is drawn only where the
  viewer may answer now (`mayAnswerQuestions`); anyone else is told, with no
  link, that the author or the decider answers there. Once the decision is
  ruled, superseded or withdrawn neither is drawn: it says instead that they
  were not answered before the ruling or the withdrawal
  (`resultsQuestionsClosedWords`, code review F3).

  At phone width every table stacks each row as a card, each cell labelled
  by its column (`stacked`), so that nothing scrolls sideways (F5). Plain
  text throughout: nothing a participant wrote is read as markup.

  Card 2683 (R10, R11, R17, R18): a round that put no options to a vote (a
  survey) is counted as answered and abstained, with no option table. Each
  round's survey figures follow its tally, one group for each version its
  answers were given under, labelled with that version's words: each choice
  question's count for each choice, each scale question's count for each
  value and its mean; a written answer is in the responses alone, with its
  name. Each response's answers are listed by prompt, as the version it was
  given under asked them, and an `answered` response is said as answering the
  survey, never as a vote. These figures are the decider's and the
  administrators' alone: no release, or its preview, holds them. A ruling on
  a version with no options says `NO_OPTIONS_PUT`.

  Card 2686 (R9, R11): the current round per group (`GroupBreakdown`), after
  its tally and survey figures and before each response, only where some
  group is named (`groupBreakdown` not empty). Never in a release.
-->
<script lang="ts">
	import type { ResultRow, ResultsData, RoundTally, SurveyQuestionTally, SurveyTally } from '$lib/decision-view-types';
	import { NOT_REACHED_WORDS, NO_OPTIONS_PUT, RESULTS_ANSWER_ELSEWHERE, resultsQuestionsClosedWords, shownMoment, surveyAnswerWords } from '$lib/decision-words';
	import AgentLabel from './AgentLabel.svelte';
	import GroupBreakdown from './GroupBreakdown.svelte';

	let { results }: { results: ResultsData } = $props();

	/** Once the decision is ruled, superseded or withdrawn, why its open questions take no answer (code review F3); null while they may. */
	const questionsClosed = $derived(resultsQuestionsClosedWords(results.decision.shownStatus));

	const score = $derived(results.decision.voteMode === 'score');
	const labelOf = (optionId: number | null) => {
		if (optionId === null) return 'None of these';
		const option = results.options.find((candidate) => candidate.optionId === optionId);
		return option === undefined ? 'An option no longer offered' : `${option.label}${option.title ? `: ${option.title}` : ''}`;
	};
	const shortLabelOf = (optionId: string) => results.options.find((option) => String(option.optionId) === optionId)?.label ?? optionId;

	/** What a row answered, in words. */
	function answerOf(row: ResultRow): string {
		if (row.kind === 'abstain') return 'Abstained';
		if (row.kind === 'no_concerns') return 'No concerns';
		// Card 2683: never a vote, and never "None of these".
		if (row.kind === 'answered') return 'Answered the survey';
		if (row.scores !== null) return Object.entries(row.scores).map(([id, value]) => `${shortLabelOf(id)} ${value}`).join(', ');
		return labelOf(row.optionId);
	}

	/** A row's comments, the overall first, then each on an option. */
	function commentsOf(row: ResultRow): string[] {
		return [...(row.comment ? [row.comment] : []), ...Object.entries(row.optionComments).map(([id, text]) => `On ${shortLabelOf(id)}: ${text}`)];
	}

	const figureOf = (tally: RoundTally, optionId: number) =>
		score ? tally.scores.find((entry) => entry.optionId === optionId) : tally.votes.find((entry) => entry.optionId === optionId);

	/**
	 * Card 2683: whether a round put no options to a vote. Its tally counts each option of the version that opened it,
	 * by votes in single mode or by scores in score mode (`tallyOf`), and a version that puts options puts at least two,
	 * so a round with neither put none: the current round or an earlier one alike, whoever answered or abstained in it
	 * (code review F7: an earlier survey round where everyone abstained is still a survey).
	 */
	const surveyRound = (tally: RoundTally) => tally.votes.length === 0 && tally.scores.length === 0;

	/** Card 2683 (R17): a row's answers, each by its prompt, as the version it was given under asked it, in that version's order. */
	function answersOf(row: ResultRow, survey: SurveyTally[]): { prompt: string; words: string }[] {
		const asked = survey.find((group) => group.versionNumber === row.versionNumber)?.questions ?? [];
		return asked.flatMap((question) => {
			const words = surveyAnswerWords(questionOf(question), row.answers[String(question.questionId)]);
			return words === null ? [] : [{ prompt: question.prompt, words }];
		});
	}

	/** A question's figures as `surveyAnswerWords` reads its question: its kind, its choices' words and its top. */
	const questionOf = (question: SurveyQuestionTally) => ({
		questionId: question.questionId,
		kind: question.kind,
		prompt: question.prompt,
		...(question.choices === null ? {} : { choices: question.choices.map((entry) => entry.choice) }),
		...(question.scale === null ? {} : { scale: { max: question.scale.max } })
	});

	/** A scale value, with the words at its end where it is one. */
	const scaleValueWords = (scale: NonNullable<SurveyQuestionTally['scale']>, value: number) =>
		`${value}${value === 1 && scale.lowLabel ? ` (${scale.lowLabel})` : ''}${value === scale.max && scale.highLabel ? ` (${scale.highLabel})` : ''}`;
</script>

{#snippet surveyCounts(tally: RoundTally, caption: string)}
	<!-- Card 2683: a survey round has no option to count, and no vote or "no concerns" (R12). -->
	<table class="results-table stacked" data-table="survey-counts">
		<caption>{caption}: {tally.responded} responded</caption>
		<thead>
			<tr>
				<th scope="col">Answer</th>
				<th scope="col">Count</th>
			</tr>
		</thead>
		<tbody>
			<tr><th scope="row">Answered the survey</th><td data-label="Count">{tally.responded - tally.abstained}</td></tr>
			<tr><th scope="row">Abstained</th><td data-label="Count">{tally.abstained}</td></tr>
		</tbody>
	</table>
{/snippet}

{#snippet surveyFigures(tally: RoundTally)}
	{#each tally.survey as group (group.versionNumber)}
		<div class="survey-figures" data-survey-version={group.versionNumber}>
			<h4>Survey questions, as version {group.versionNumber} asked them</h4>
			{#each group.questions as question, index (question.questionId)}
				{#if question.kind === 'choice' && question.choices !== null}
					<table class="results-table stacked" data-table="survey" data-question={question.questionId}>
						<caption>{index + 1}. {question.prompt}: {question.answered} answered</caption>
						<thead>
							<tr>
								<th scope="col">Choice</th>
								<th scope="col">Count</th>
							</tr>
						</thead>
						<tbody>
							{#each question.choices as entry, i (i)}
								<tr><th scope="row">{entry.choice}</th><td data-label="Count">{entry.count}</td></tr>
							{/each}
						</tbody>
					</table>
				{:else if question.kind === 'scale' && question.scale !== null}
					{@const scale = question.scale}
					<table class="results-table stacked" data-table="survey" data-question={question.questionId}>
						<caption>{index + 1}. {question.prompt}: {question.answered} answered, mean {scale.mean === null ? '–' : scale.mean.toFixed(1)} of {scale.max}</caption>
						<thead>
							<tr>
								<th scope="col">Value</th>
								<th scope="col">Count</th>
							</tr>
						</thead>
						<tbody>
							{#each scale.counts as entry (entry.value)}
								<tr><th scope="row">{scaleValueWords(scale, entry.value)}</th><td data-label="Count">{entry.count}</td></tr>
							{/each}
						</tbody>
					</table>
				{:else}
					<p class="survey-text" data-question={question.questionId}>
						{index + 1}. {question.prompt}: {question.answered} answered. Each written answer is in the responses, with its name.
					</p>
				{/if}
			{/each}
		</div>
	{/each}
{/snippet}

{#snippet tallyTable(tally: RoundTally, caption: string)}
	<table class="results-table stacked" data-table="tally">
		<caption>{caption}: {tally.responded} responded</caption>
		<thead>
			<tr>
				<th scope="col">Option</th>
				{#if score}
					<th scope="col">Total score</th>
					<th scope="col">Mean</th>
				{:else}
					<th scope="col">Votes</th>
				{/if}
			</tr>
		</thead>
		<tbody>
			{#each results.options as option (option.optionId)}
				{@const figure = figureOf(tally, option.optionId)}
				<tr>
					<th scope="row">{option.label}{option.title ? `: ${option.title}` : ''}</th>
					{#if score}
						{@const entry = figure as { total: number; mean: number | null } | undefined}
						<td data-label="Total score">{entry?.total ?? 0}</td>
						<td data-label="Mean">{entry?.mean === null || entry?.mean === undefined ? '–' : entry.mean.toFixed(1)}</td>
					{:else}
						<td data-label="Votes">{(figure as { count: number } | undefined)?.count ?? 0}</td>
					{/if}
				</tr>
			{/each}
			{#if !score}
				<tr>
					<th scope="row">Abstained</th>
					<td data-label="Votes">{tally.abstained}</td>
				</tr>
				<tr>
					<th scope="row">No concerns</th>
					<td data-label="Votes">{tally.noConcerns}</td>
				</tr>
			{/if}
		</tbody>
	</table>
	{#if score}
		<!-- Code review F6: how many voted, abstained and had no concerns are counts of people, not scores, so a column of their own. -->
		<table class="results-table stacked" data-table="counts">
			<caption>{caption}: who answered how</caption>
			<thead>
				<tr>
					<th scope="col">Answer</th>
					<th scope="col">Count</th>
				</tr>
			</thead>
			<tbody>
				<tr><th scope="row">Voted</th><td data-label="Count">{tally.voted}</td></tr>
				<tr><th scope="row">Abstained</th><td data-label="Count">{tally.abstained}</td></tr>
				<tr><th scope="row">No concerns</th><td data-label="Count">{tally.noConcerns}</td></tr>
			</tbody>
		</table>
	{/if}
{/snippet}

{#snippet responsesTable(rows: ResultRow[], caption: string, survey: SurveyTally[])}
	{#if rows.length > 0}
		<table class="results-table stacked" data-table="responses">
			<caption>{caption}</caption>
			<thead>
				<tr>
					<th scope="col">Who</th>
					<th scope="col">Answer</th>
					{#if survey.length > 0}<th scope="col">Survey answers</th>{/if}
					<th scope="col">Comments</th>
					<th scope="col">Given</th>
				</tr>
			</thead>
			<tbody>
				{#each rows as row (row.participantId)}
					<tr>
						<th scope="row">{row.name}{row.groups.length > 0 ? ` (${row.groups.join(', ')})` : ''}</th>
						<td data-label="Answer">{answerOf(row)}</td>
						{#if survey.length > 0}
							<!-- Card 2683 (R14): plain text, a written answer as written. -->
							<td data-label="Survey answers">
								{#each answersOf(row, survey) as entry, index (index)}<p class="comment" data-answer>{entry.prompt}: {entry.words}</p>{/each}
							</td>
						{/if}
						<td data-label="Comments">
							{#each commentsOf(row) as text, index (index)}<p class="comment">{text}</p>{/each}
						</td>
						<td data-label="Given">
							{shownMoment(row.createdAt, '')}{row.via === 'link' ? ', by link' : ''}{row.changes > 0 ? `, changed ${row.changes} ${row.changes === 1 ? 'time' : 'times'}` : ''}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{:else}
		<p class="none">Nobody has responded in this round.</p>
	{/if}
{/snippet}

<section class="results" aria-label="Results">
	<h2>Round {results.round}</h2>
	{#if surveyRound(results.current)}
		{@render surveyCounts(results.current, `Round ${results.round}`)}
	{:else}
		{@render tallyTable(results.current, `Round ${results.round}`)}
	{/if}
	{@render surveyFigures(results.current)}
	{#if results.groupBreakdown.length > 0}<GroupBreakdown groups={results.groupBreakdown} options={results.options} round={results.round} {score} survey={surveyRound(results.current)} />{/if}
	{@render responsesTable(results.current.rows, 'Each response', results.current.survey)}

	<h3>Not responded</h3>
	{#if results.notResponded.length > 0}
		<ul data-list="not-responded">
			{#each results.notResponded as person (person.participantId)}
				<li>
					{person.name}{person.groups.length > 0 ? ` (${person.groups.join(', ')})` : ''}{#if !person.reached}{' '}<span class="not-reached" data-note="not-reached">({NOT_REACHED_WORDS})</span>{/if}
				</li>
			{/each}
		</ul>
	{:else}
		<p class="none">Everyone consulted has responded.</p>
	{/if}

	{#if results.removed.length > 0}
		<h3>Removed</h3>
		<ul data-list="removed">
			{#each results.removed as person (person.participantId)}
				<li>{person.name}: {person.latest === null ? 'no response in this round' : answerOf(person.latest)}</li>
			{/each}
		</ul>
	{/if}

	<h3>Open questions</h3>
	{#if results.openQuestions.length > 0}
		<ul data-list="questions">
			{#each results.openQuestions as question, index (index)}
				<li data-question={index}>
					{#if question.askerName !== undefined}
						<span class="asked-by"><strong>{question.askerName}</strong>{question.askedAt === undefined ? '' : `, ${shownMoment(question.askedAt, '')}`}:</span>
					{/if}
					{#if question.agentAnswered}<AgentLabel />{/if}
					<p class="comment" data-text="question">{question.question}</p>
				</li>
			{/each}
		</ul>
		{#if questionsClosed !== null}
			<!-- Ruled, superseded or withdrawn (code review F3): nothing more can be answered, so no link and no pointer to the page. -->
			<p class="none" data-note="questions-closed">{questionsClosed}</p>
		{:else if results.mayAnswerQuestions}
			<p class="answer-link"><a href="/decisions/{results.decision.id}#questions" data-action="answer-questions">Answer on the decision's page</a></p>
		{:else}
			<p class="none" data-note="answer-elsewhere">{RESULTS_ANSWER_ELSEWHERE}</p>
		{/if}
	{:else}
		<p class="none">No questions are open.</p>
	{/if}

	{#if results.concerns.length > 0}
		<h3>Concerns about the ruling</h3>
		<ul data-list="concerns">
			{#each results.concerns as concern, index (index)}
				<li><strong>{concern.name}</strong>, {shownMoment(concern.createdAt, '')}{concern.via === 'link' ? ', by link' : ''}: <span class="comment">{concern.comment}</span></li>
			{/each}
		</ul>
	{/if}

	{#if results.ruling !== null}
		<h3>The ruling</h3>
		<dl class="ruling" data-block="ruling">
			<dt>Ruled on</dt>
			<dd>
				{results.ruling.noOptions
					? NO_OPTIONS_PUT
					: results.ruling.optionId === null
						? 'None of these'
						: `Option ${results.ruling.label ?? ''}${results.ruling.title ? `: ${results.ruling.title}` : ''}`}
			</dd>
			<dt>By</dt>
			<dd>{results.ruling.byName}, {shownMoment(results.ruling.at, '')}</dd>
			<dt>Why</dt>
			<dd class="comment">{results.ruling.reason}</dd>
			{#if results.ruling.conditions}
				<dt>Conditions</dt>
				<dd class="comment">{results.ruling.conditions}</dd>
			{/if}
			<dt>Against the responses</dt>
			<dd>{results.ruling.againstResponses ? 'Yes: it was not the most chosen option' : 'No'}</dd>
			<dt>Early</dt>
			<!-- Card 2738 (code review R6): since card 2727 an early ruling may be of a decision closed before its closing time. -->
			<dd>{results.ruling.early ? (results.ruling.closedEarly ? 'Yes: ruled after it was closed before its closing time' : 'Yes: ruled while the decision was open') : 'No'}</dd>
			{#if results.ruling.cutOff.length > 0}
				<dt>Cut off</dt>
				<!-- Card 2738: each the record says the round's request never reached is marked; one recorded before it (null) is not. -->
				<dd>{results.ruling.cutOff.map((name, index) => (results.ruling?.cutOffReached[index] === false ? `${name} (${NOT_REACHED_WORDS})` : name)).join(', ')}</dd>
			{/if}
		</dl>
	{/if}

	{#each results.earlierRounds as tally (tally.round)}
		<details class="earlier" data-round={tally.round}>
			<summary>Round {tally.round}</summary>
			{#if surveyRound(tally)}
				{@render surveyCounts(tally, `Round ${tally.round}`)}
			{:else}
				{@render tallyTable(tally, `Round ${tally.round}`)}
			{/if}
			{@render surveyFigures(tally)}
			{@render responsesTable(tally.rows, `Each response in round ${tally.round}`, tally.survey)}
		</details>
	{/each}
</section>

<style>
	.results { display: flex; flex-direction: column; gap: var(--space-sm); min-width: 0; }
	.results h2 { font-size: 1.05rem; margin: 0; }
	.results h3 { font-size: 0.95rem; margin: var(--space-md) 0 0; }
	.results ul { margin: 0; padding-left: var(--space-lg); font-size: 0.88rem; }
	.none { margin: 0; font-size: 0.85rem; color: var(--text-tertiary); }
	.not-reached { color: var(--text-tertiary); }
	.comment { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; }
	[data-list='questions'] li { display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-xs); margin-bottom: var(--space-xs); min-width: 0; }
	/* A long name with no break wraps at phone width rather than pushing the page sideways (code review F8). */
	.asked-by { overflow-wrap: anywhere; min-width: 0; }
	.answer-link { margin: 0; font-size: 0.88rem; }
	.answer-link a { display: inline-flex; align-items: center; min-height: 44px; }
	.results-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; table-layout: auto; }
	.results-table caption { text-align: left; font-weight: 600; padding-bottom: var(--space-xs); }
	.results-table th,
	.results-table td { text-align: left; vertical-align: top; padding: var(--space-xs) var(--space-sm); border-bottom: 1px solid var(--glass-border); overflow-wrap: anywhere; }
	.results-table thead th { font-size: 0.75rem; color: var(--text-secondary); }
	.ruling { display: grid; grid-template-columns: max-content 1fr; gap: var(--space-xs) var(--space-md); margin: 0; font-size: 0.88rem; }
	.ruling dt { color: var(--text-secondary); }
	.ruling dd { margin: 0; min-width: 0; }
	.earlier summary { cursor: pointer; font-weight: 600; font-size: 0.9rem; }
	.survey-figures { display: flex; flex-direction: column; gap: var(--space-sm); min-width: 0; }
	.survey-figures h4 { font-size: 0.9rem; margin: var(--space-sm) 0 0; }
	.survey-text { margin: 0; font-size: 0.85rem; overflow-wrap: anywhere; }

	/* Phone width: each row a labelled card, nothing scrolling sideways (F5). */
	@media (max-width: 640px) {
		.stacked thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
		.stacked,
		.stacked tbody,
		.stacked tr,
		.stacked th,
		.stacked td { display: block; width: 100%; box-sizing: border-box; }
		.stacked tr { border: 1px solid var(--glass-border); border-radius: var(--radius-sm); margin-bottom: var(--space-xs); }
		.stacked td::before { content: attr(data-label) ': '; color: var(--text-secondary); font-size: 0.75rem; }
		.stacked td:empty { display: none; }
		.ruling { grid-template-columns: 1fr; }
	}
</style>
