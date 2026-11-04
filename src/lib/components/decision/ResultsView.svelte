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

  At phone width every table stacks each row as a card, each cell labelled
  by its column (`stacked`), so that nothing scrolls sideways (F5). Plain
  text throughout: nothing a participant wrote is read as markup.
-->
<script lang="ts">
	import type { ResultRow, ResultsData, RoundTally } from '$lib/decision-view-types';
	import { shownMoment } from '$lib/decision-words';

	let { results }: { results: ResultsData } = $props();

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
		if (row.scores !== null) return Object.entries(row.scores).map(([id, value]) => `${shortLabelOf(id)} ${value}`).join(', ');
		return labelOf(row.optionId);
	}

	/** A row's comments, the overall first, then each on an option. */
	function commentsOf(row: ResultRow): string[] {
		return [...(row.comment ? [row.comment] : []), ...Object.entries(row.optionComments).map(([id, text]) => `On ${shortLabelOf(id)}: ${text}`)];
	}

	const figureOf = (tally: RoundTally, optionId: number) =>
		score ? tally.scores.find((entry) => entry.optionId === optionId) : tally.votes.find((entry) => entry.optionId === optionId);
</script>

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

{#snippet responsesTable(rows: ResultRow[], caption: string)}
	{#if rows.length > 0}
		<table class="results-table stacked" data-table="responses">
			<caption>{caption}</caption>
			<thead>
				<tr>
					<th scope="col">Who</th>
					<th scope="col">Answer</th>
					<th scope="col">Comments</th>
					<th scope="col">Given</th>
				</tr>
			</thead>
			<tbody>
				{#each rows as row (row.participantId)}
					<tr>
						<th scope="row">{row.name}{row.groups.length > 0 ? ` (${row.groups.join(', ')})` : ''}</th>
						<td data-label="Answer">{answerOf(row)}</td>
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
	{@render tallyTable(results.current, `Round ${results.round}`)}
	{@render responsesTable(results.current.rows, 'Each response')}

	<h3>Not responded</h3>
	{#if results.notResponded.length > 0}
		<ul data-list="not-responded">
			{#each results.notResponded as person (person.participantId)}
				<li>{person.name}{person.groups.length > 0 ? ` (${person.groups.join(', ')})` : ''}</li>
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
				<li>{question.askerName}: {question.question}</li>
			{/each}
		</ul>
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
			<dd>{results.ruling.optionId === null ? 'None of these' : `Option ${results.ruling.label ?? ''}${results.ruling.title ? `: ${results.ruling.title}` : ''}`}</dd>
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
			<dd>{results.ruling.early ? 'Yes: ruled while the decision was open' : 'No'}</dd>
			{#if results.ruling.cutOff.length > 0}
				<dt>Cut off</dt>
				<dd>{results.ruling.cutOff.join(', ')}</dd>
			{/if}
		</dl>
	{/if}

	{#each results.earlierRounds as tally (tally.round)}
		<details class="earlier" data-round={tally.round}>
			<summary>Round {tally.round}</summary>
			{@render tallyTable(tally, `Round ${tally.round}`)}
			{@render responsesTable(tally.rows, `Each response in round ${tally.round}`)}
		</details>
	{/each}
</section>

<style>
	.results { display: flex; flex-direction: column; gap: var(--space-sm); min-width: 0; }
	.results h2 { font-size: 1.05rem; margin: 0; }
	.results h3 { font-size: 0.95rem; margin: var(--space-md) 0 0; }
	.results ul { margin: 0; padding-left: var(--space-lg); font-size: 0.88rem; }
	.none { margin: 0; font-size: 0.85rem; color: var(--text-tertiary); }
	.comment { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; }
	.results-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; table-layout: auto; }
	.results-table caption { text-align: left; font-weight: 600; padding-bottom: var(--space-xs); }
	.results-table th,
	.results-table td { text-align: left; vertical-align: top; padding: var(--space-xs) var(--space-sm); border-bottom: 1px solid var(--glass-border); overflow-wrap: anywhere; }
	.results-table thead th { font-size: 0.75rem; color: var(--text-secondary); }
	.ruling { display: grid; grid-template-columns: max-content 1fr; gap: var(--space-xs) var(--space-md); margin: 0; font-size: 0.88rem; }
	.ruling dt { color: var(--text-secondary); }
	.ruling dd { margin: 0; min-width: 0; }
	.earlier summary { cursor: pointer; font-weight: 600; font-size: 0.9rem; }

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
