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
  by its column (the kit's `Table stack`), so that nothing scrolls sideways
  (F5). Plain text throughout: nothing a participant wrote is read as markup.

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

  Card 3087: on the UI kit. Each part is a kit `Card`: the round (its tally
  or survey counts, survey figures and the group breakdown), each response,
  not responded (with the removed), open questions, the concerns and the
  ruling each a `section` named by its own heading, the same words at the
  same level; each response and the earlier rounds, which have no heading,
  a card that is not a section. Every table is the kit's `Table` with
  `stack`, its caption, `data-table`, `data-question` and each cell's
  `data-label` as before, figures at the right in tabular digits
  (`ui-table-num`). The lists are rows divided by a line; "not reached" an
  outline `Badge` (its brackets kept for a screen reader and a copy, not
  drawn); in the ruling, a Yes is a warning `Badge` around the same words.
  The only motion is the earlier rounds' chevron turning, none under
  reduced motion.
-->
<script lang="ts">
	import type { ResultRow, ResultsData, RoundTally, SurveyQuestionTally, SurveyTally } from '$lib/decision-view-types';
	import { NOT_REACHED_WORDS, NO_OPTIONS_PUT, RESULTS_ANSWER_ELSEWHERE, resultsQuestionsClosedWords, shownMoment, surveyAnswerWords } from '$lib/decision-words';
	import Badge from '$lib/components/ui/Badge.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import Card from '$lib/components/ui/Card.svelte';
	import CardContent from '$lib/components/ui/CardContent.svelte';
	import CardHeader from '$lib/components/ui/CardHeader.svelte';
	import CardTitle from '$lib/components/ui/CardTitle.svelte';
	import Table from '$lib/components/ui/Table.svelte';
	import AgentLabel from './AgentLabel.svelte';
	import GroupBreakdown from './GroupBreakdown.svelte';

	let { results }: { results: ResultsData } = $props();

	/** The headings' ids, which name their sections (card 3087). */
	const uid = $props.id();

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
	<Table region={false} caption="{caption}: {tally.responded} responded" stack class="results-table stacked" data-table="survey-counts">
		<thead>
			<tr>
				<th scope="col">Answer</th>
				<th scope="col" class="ui-table-num">Count</th>
			</tr>
		</thead>
		<tbody>
			<tr><th scope="row">Answered the survey</th><td class="ui-table-num" data-label="Count">{tally.responded - tally.abstained}</td></tr>
			<tr><th scope="row">Abstained</th><td class="ui-table-num" data-label="Count">{tally.abstained}</td></tr>
		</tbody>
	</Table>
{/snippet}

{#snippet surveyFigures(tally: RoundTally)}
	{#each tally.survey as group (group.versionNumber)}
		<div class="survey-figures" data-survey-version={group.versionNumber}>
			<h4>Survey questions, as version {group.versionNumber} asked them</h4>
			{#each group.questions as question, index (question.questionId)}
				{#if question.kind === 'choice' && question.choices !== null}
					<Table region={false} caption="{index + 1}. {question.prompt}: {question.answered} answered" stack class="results-table stacked" data-table="survey" data-question={question.questionId}>
						<thead>
							<tr>
								<th scope="col">Choice</th>
								<th scope="col" class="ui-table-num">Count</th>
							</tr>
						</thead>
						<tbody>
							{#each question.choices as entry, i (i)}
								<tr><th scope="row">{entry.choice}</th><td class="ui-table-num" data-label="Count">{entry.count}</td></tr>
							{/each}
						</tbody>
					</Table>
				{:else if question.kind === 'scale' && question.scale !== null}
					{@const scale = question.scale}
					<Table
						region={false}
						caption="{index + 1}. {question.prompt}: {question.answered} answered, mean {scale.mean === null ? '–' : scale.mean.toFixed(1)} of {scale.max}"
						stack
						class="results-table stacked"
						data-table="survey"
						data-question={question.questionId}
					>
						<thead>
							<tr>
								<th scope="col">Value</th>
								<th scope="col" class="ui-table-num">Count</th>
							</tr>
						</thead>
						<tbody>
							{#each scale.counts as entry (entry.value)}
								<tr><th scope="row">{scaleValueWords(scale, entry.value)}</th><td class="ui-table-num" data-label="Count">{entry.count}</td></tr>
							{/each}
						</tbody>
					</Table>
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
	<Table region={false} caption="{caption}: {tally.responded} responded" stack class="results-table stacked" data-table="tally">
		<thead>
			<tr>
				<th scope="col">Option</th>
				{#if score}
					<th scope="col" class="ui-table-num">Total score</th>
					<th scope="col" class="ui-table-num">Mean</th>
				{:else}
					<th scope="col" class="ui-table-num">Votes</th>
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
						<td class="ui-table-num" data-label="Total score">{entry?.total ?? 0}</td>
						<td class="ui-table-num" data-label="Mean">{entry?.mean === null || entry?.mean === undefined ? '–' : entry.mean.toFixed(1)}</td>
					{:else}
						<td class="ui-table-num" data-label="Votes">{(figure as { count: number } | undefined)?.count ?? 0}</td>
					{/if}
				</tr>
			{/each}
			{#if !score}
				<tr>
					<th scope="row">Abstained</th>
					<td class="ui-table-num" data-label="Votes">{tally.abstained}</td>
				</tr>
				<tr>
					<th scope="row">No concerns</th>
					<td class="ui-table-num" data-label="Votes">{tally.noConcerns}</td>
				</tr>
			{/if}
		</tbody>
	</Table>
	{#if score}
		<!-- Code review F6: how many voted, abstained and had no concerns are counts of people, not scores, so a column of their own. -->
		<Table region={false} caption="{caption}: who answered how" stack class="results-table stacked" data-table="counts">
			<thead>
				<tr>
					<th scope="col">Answer</th>
					<th scope="col" class="ui-table-num">Count</th>
				</tr>
			</thead>
			<tbody>
				<tr><th scope="row">Voted</th><td class="ui-table-num" data-label="Count">{tally.voted}</td></tr>
				<tr><th scope="row">Abstained</th><td class="ui-table-num" data-label="Count">{tally.abstained}</td></tr>
				<tr><th scope="row">No concerns</th><td class="ui-table-num" data-label="Count">{tally.noConcerns}</td></tr>
			</tbody>
		</Table>
	{/if}
{/snippet}

{#snippet responsesTable(rows: ResultRow[], caption: string, survey: SurveyTally[])}
	{#if rows.length > 0}
		<Table region={false} {caption} stack class="results-table stacked" data-table="responses">
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
					{@const comments = commentsOf(row)}
					<tr class="response">
						<th scope="row">{row.name}{row.groups.length > 0 ? ` (${row.groups.join(', ')})` : ''}</th>
						<td data-label="Answer">{answerOf(row)}</td>
						{#if survey.length > 0}
							{@const answers = answersOf(row, survey)}
							<!-- Card 2683 (R14): plain text, a written answer as written. Card 3087: the lines in one block, so the phone's label stands beside them all. -->
							<td data-label="Survey answers"
								>{#if answers.length > 0}<div class="lines">
										{#each answers as entry, index (index)}<p class="comment" data-answer>{entry.prompt}: {entry.words}</p>{/each}
									</div>{/if}</td
							>
						{/if}
						<td data-label="Comments"
							>{#if comments.length > 0}<div class="lines">
									{#each comments as text, index (index)}<p class="comment">{text}</p>{/each}
								</div>{/if}</td
						>
						<td data-label="Given" class="given">
							{shownMoment(row.createdAt, '')}{row.via === 'link' ? ', by link' : ''}{row.changes > 0 ? `, changed ${row.changes} ${row.changes === 1 ? 'time' : 'times'}` : ''}
						</td>
					</tr>
				{/each}
			</tbody>
		</Table>
	{:else}
		<p class="none">Nobody has responded in this round.</p>
	{/if}
{/snippet}

<section class="results" aria-label="Results">
	<Card as="section" aria-labelledby="{uid}-round">
		<CardHeader><CardTitle level={2} id="{uid}-round">Round {results.round}</CardTitle></CardHeader>
		<CardContent>
			<div class="blocks">
				{#if surveyRound(results.current)}
					{@render surveyCounts(results.current, `Round ${results.round}`)}
				{:else}
					{@render tallyTable(results.current, `Round ${results.round}`)}
				{/if}
				{@render surveyFigures(results.current)}
				{#if results.groupBreakdown.length > 0}<GroupBreakdown groups={results.groupBreakdown} options={results.options} round={results.round} {score} survey={surveyRound(results.current)} />{/if}
			</div>
		</CardContent>
	</Card>

	<!-- No heading of its own, as before: the table's caption names it, or the line says nobody has responded. -->
	<Card>
		<CardContent>
			{@render responsesTable(results.current.rows, 'Each response', results.current.survey)}
		</CardContent>
	</Card>

	<Card as="section" aria-labelledby="{uid}-not-responded">
		<CardHeader><CardTitle level={3} id="{uid}-not-responded">Not responded</CardTitle></CardHeader>
		<CardContent>
			{#if results.notResponded.length > 0}
				<!-- svelte-ignore a11y_no_redundant_roles -->
				<ul role="list" class="rows" data-list="not-responded">
					{#each results.notResponded as person (person.participantId)}
						<li>
							<span class="who">{person.name}</span>{#if person.groups.length > 0}<span class="aside">{` (${person.groups.join(', ')})`}</span>{/if}{#if !person.reached}{' '}<Badge
									variant="outline"
									class="not-reached"
									data-note="not-reached"><span class="unseen">(</span>{NOT_REACHED_WORDS}<span class="unseen">)</span></Badge
								>{/if}
						</li>
					{/each}
				</ul>
			{:else}
				<p class="none">Everyone consulted has responded.</p>
			{/if}

			{#if results.removed.length > 0}
				<h3 class="sub-title">Removed</h3>
				<!-- svelte-ignore a11y_no_redundant_roles -->
				<ul role="list" class="rows" data-list="removed">
					{#each results.removed as person (person.participantId)}
						<li><span class="who">{person.name}</span><span class="aside">: {person.latest === null ? 'no response in this round' : answerOf(person.latest)}</span></li>
					{/each}
				</ul>
			{/if}
		</CardContent>
	</Card>

	<Card as="section" aria-labelledby="{uid}-questions">
		<CardHeader><CardTitle level={3} id="{uid}-questions">Open questions</CardTitle></CardHeader>
		<CardContent>
			{#if results.openQuestions.length > 0}
				<!-- svelte-ignore a11y_no_redundant_roles -->
				<ul role="list" class="rows" data-list="questions">
					{#each results.openQuestions as question, index (index)}
						<li data-question={index}>
							{#if question.askerName !== undefined}
								<span class="asked-by"><strong>{question.askerName}</strong><span class="aside">{question.askedAt === undefined ? '' : `, ${shownMoment(question.askedAt, '')}`}:</span></span>
							{/if}
							{#if question.agentAnswered}<AgentLabel />{/if}
							<p class="comment" data-text="question">{question.question}</p>
						</li>
					{/each}
				</ul>
				{#if questionsClosed !== null}
					<!-- Ruled, superseded or withdrawn (code review F3): nothing more can be answered, so no link and no pointer to the page. -->
					<p class="none after-rows" data-note="questions-closed">{questionsClosed}</p>
				{:else if results.mayAnswerQuestions}
					<p class="answer-link">
						<Button variant="outline" size="sm" href="/decisions/{results.decision.id}#questions" data-action="answer-questions">Answer on the decision's page</Button>
					</p>
				{:else}
					<p class="none after-rows" data-note="answer-elsewhere">{RESULTS_ANSWER_ELSEWHERE}</p>
				{/if}
			{:else}
				<p class="none">No questions are open.</p>
			{/if}
		</CardContent>
	</Card>

	{#if results.concerns.length > 0}
		<Card as="section" aria-labelledby="{uid}-concerns">
			<CardHeader><CardTitle level={3} id="{uid}-concerns">Concerns about the ruling</CardTitle></CardHeader>
			<CardContent>
				<!-- svelte-ignore a11y_no_redundant_roles -->
				<ul role="list" class="rows" data-list="concerns">
					{#each results.concerns as concern, index (index)}
						<li>
							<span class="concern-by"><strong>{concern.name}</strong><span class="aside">, {shownMoment(concern.createdAt, '')}{concern.via === 'link' ? ', by link' : ''}:</span></span>
							<span class="comment">{concern.comment}</span>
						</li>
					{/each}
				</ul>
			</CardContent>
		</Card>
	{/if}

	{#if results.ruling !== null}
		<Card as="section" aria-labelledby="{uid}-ruling">
			<CardHeader><CardTitle level={3} id="{uid}-ruling">The ruling</CardTitle></CardHeader>
			<CardContent>
				<dl class="ruling" data-block="ruling">
					<dt>Ruled on</dt>
					<dd class="outcome">
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
					<!-- Card 3087: a Yes is a warning badge around the same words, so not colour alone; a No plain text. -->
					<dd>
						{#if results.ruling.againstResponses}<Badge variant="warning" class="ruling-yes">Yes: it was not the most chosen option</Badge>{:else}No{/if}
					</dd>
					<dt>Early</dt>
					<!-- Card 2738 (code review R6): since card 2727 an early ruling may be of a decision closed before its closing time. -->
					<dd>
						{#if results.ruling.early}<Badge variant="warning" class="ruling-yes"
								>{results.ruling.closedEarly ? 'Yes: ruled after it was closed before its closing time' : 'Yes: ruled while the decision was open'}</Badge
							>{:else}No{/if}
					</dd>
					{#if results.ruling.cutOff.length > 0}
						<dt>Cut off</dt>
						<!-- Card 2738: each the record says the round's request never reached is marked; one recorded before it (null) is not. -->
						<dd>{results.ruling.cutOff.map((name, index) => (results.ruling?.cutOffReached[index] === false ? `${name} (${NOT_REACHED_WORDS})` : name)).join(', ')}</dd>
					{/if}
				</dl>
			</CardContent>
		</Card>
	{/if}

	{#if results.earlierRounds.length > 0}
		<!-- No heading of its own, as before: each round a closed disclosure, named by its summary. -->
		<Card>
			<CardContent>
				{#each results.earlierRounds as tally (tally.round)}
					<details class="earlier" data-round={tally.round}>
						<summary
							>Round {tally.round}<svg
								class="chevron"
								width="16"
								height="16"
								viewBox="0 0 16 16"
								fill="none"
								stroke="currentColor"
								stroke-width="1.5"
								stroke-linecap="round"
								stroke-linejoin="round"
								aria-hidden="true"><path d="M4 6l4 4 4-4" /></svg
							></summary
						>
						<div class="earlier-body">
							{#if surveyRound(tally)}
								{@render surveyCounts(tally, `Round ${tally.round}`)}
							{:else}
								{@render tallyTable(tally, `Round ${tally.round}`)}
							{/if}
							{@render surveyFigures(tally)}
							{@render responsesTable(tally.rows, `Each response in round ${tally.round}`, tally.survey)}
						</div>
					</details>
				{/each}
			</CardContent>
		</Card>
	{/if}
</section>

<style>
	.results {
		display: flex;
		flex-direction: column;
		gap: var(--space-lg);
		min-width: 0;
	}
	.blocks,
	.earlier-body,
	.survey-figures {
		display: flex;
		flex-direction: column;
		gap: var(--space-md);
		min-width: 0;
	}
	.survey-figures h4 {
		margin: var(--space-xs) 0 0;
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--ui-foreground);
	}
	.survey-text {
		margin: 0;
		font-size: 0.875rem;
		color: var(--ui-muted-foreground);
		overflow-wrap: anywhere;
	}

	/* An empty state: muted words inside the card. */
	.none {
		margin: 0;
		font-size: 0.875rem;
		color: var(--ui-muted-foreground);
	}
	.after-rows {
		margin-top: var(--space-sm);
	}
	.comment {
		margin: 0;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	/* The lists as rows: no bullets, a line between them, the name in the foreground weight and the rest muted. With no bullets Safari and VoiceOver drop the list's role, so the `ul` says `role="list"` (code review L1). */
	.rows {
		margin: 0;
		padding: 0;
		list-style: none;
		font-size: 0.875rem;
		color: var(--ui-foreground);
	}
	.rows li {
		padding: 0.625rem 0;
		border-top: 1px solid var(--ui-border);
		overflow-wrap: anywhere;
		min-width: 0;
	}
	.rows li:first-child {
		border-top: none;
		padding-top: 0;
	}
	.rows li:last-child {
		padding-bottom: 0;
	}
	.who,
	.rows strong {
		font-weight: 500;
		color: var(--ui-foreground);
	}
	.aside {
		color: var(--ui-muted-foreground);
	}
	/* The badge's brackets are read and copied, not drawn: the badge is the bracket. */
	.unseen {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}
	/* A long note wraps rather than pushing a phone's page sideways. */
	.rows :global(.ui-badge.not-reached) {
		margin-left: var(--space-xs);
		white-space: normal;
	}
	.sub-title {
		margin: var(--space-lg) 0 var(--space-sm);
		padding-top: var(--space-md);
		border-top: 1px solid var(--ui-border);
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--ui-foreground);
	}
	[data-list='questions'] li,
	[data-list='concerns'] li {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: var(--space-xs);
	}
	/* A long name with no break wraps at phone width rather than pushing the page sideways (code review F8). */
	.asked-by,
	.concern-by {
		overflow-wrap: anywhere;
		min-width: 0;
	}
	.answer-link {
		margin: var(--space-md) 0 0;
	}

	/* A response's lines, one under another; on a phone the label stands beside the block. */
	.lines {
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
		min-width: 0;
	}
	.response > th,
	.response > td {
		vertical-align: top;
	}
	.given {
		color: var(--ui-muted-foreground);
	}

	/* The ruling: label and value in two columns, a line between each pair; the outcome first and larger. */
	.ruling {
		display: grid;
		grid-template-columns: minmax(9rem, max-content) minmax(0, 1fr);
		margin: 0;
		font-size: 0.875rem;
	}
	.ruling dt,
	.ruling dd {
		margin: 0;
		padding: 0.625rem 0;
		border-top: 1px solid var(--ui-border);
		min-width: 0;
	}
	.ruling dt {
		padding-right: var(--space-lg);
		color: var(--ui-muted-foreground);
	}
	.ruling dd {
		color: var(--ui-foreground);
		overflow-wrap: anywhere;
	}
	.ruling dt:first-of-type,
	.ruling dd:first-of-type {
		border-top: none;
		padding-top: 0;
	}
	.ruling .outcome {
		font-size: 1rem;
		font-weight: 600;
	}
	.ruling :global(.ui-badge.ruling-yes) {
		white-space: normal;
	}

	/* The earlier rounds: each a disclosure row, a chevron that turns as it opens. */
	.earlier {
		border-top: 1px solid var(--ui-border);
	}
	.earlier:first-child {
		border-top: none;
	}
	.earlier summary {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-md);
		min-height: 2.5rem;
		border-radius: var(--ui-radius-sm);
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--ui-foreground);
		cursor: pointer;
		list-style: none;
	}
	.earlier summary::-webkit-details-marker {
		display: none;
	}
	.earlier summary:hover {
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.earlier summary:focus-visible {
		outline: 2px solid var(--ui-ring);
		outline-offset: 2px;
	}
	.chevron {
		flex-shrink: 0;
		color: var(--ui-muted-foreground);
		transition: transform var(--duration-fast) var(--ease-out);
	}
	.earlier[open] .chevron {
		transform: rotate(180deg);
	}
	.earlier[open] .earlier-body {
		padding: var(--space-sm) 0 var(--space-md);
	}

	@media (pointer: coarse) {
		.earlier summary {
			min-height: 2.75rem;
		}
	}

	/* Phone width: the ruling in one column; a cell with nothing in it is not drawn (F5). */
	@media (max-width: 640px) {
		.ruling {
			grid-template-columns: minmax(0, 1fr);
		}
		.ruling dd {
			border-top: none;
			padding-top: 0.125rem;
		}
		.results td:empty {
			display: none;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.chevron {
			transition: none;
		}
	}
</style>
