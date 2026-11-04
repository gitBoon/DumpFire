<!--
  ReleasedResults.svelte — a ruled decision's released totals and comments,
  without names, on both participant pages, to everyone who may view it once
  its decider has released them (card 2679, decisions 10 and 24); and the
  decider's preview of them on the results page, the same table drawn by the
  same code (code review F3).

  It draws what `releasedOf` (or `previewOf`) gave and nothing more: the
  ruling round's totals as a table with a header for each column and row, in
  single mode each option's votes, in score mode its mean score; then the
  number who abstained and who had no concerns. A figure the server withheld
  (null) reads "withheld", with no number (`releasedFigure`, code review S3),
  and so does the number who responded where it is withheld. Then the
  comments, overall and on each option, each as text, never markdown, in the
  order given (by their text): no name, moment or choice is beside any, as
  none is given.

  `comment`, optional, draws each comment as its own list item, as the
  results page does to put a Leave out box by each one; `name` names the
  block and the table (`released`, or `preview`), and `note` replaces the
  line above the table.
-->
<script lang="ts" generics="C extends string | PreviewComment">
	import type { Snippet } from 'svelte';
	import type { PreviewComment, ReleasedResults } from '$lib/decision-view-types';
	import { releasedFigure } from '$lib/decision-words';

	let {
		released,
		comment,
		name = 'released',
		note = 'Released by the decider: the totals and the comments, without names. Figures that could single someone out are withheld.'
	}: {
		released: ReleasedResults<C>;
		/** Each comment drawn as a list item of its own; a plain item of its text otherwise. */
		comment?: Snippet<[C]>;
		name?: 'released' | 'preview';
		note?: string;
	} = $props();

	const textOf = (given: C) => (typeof given === 'string' ? given : given.text);
	const score = $derived(released.voteMode === 'score');
	const optionComments = $derived(released.options.filter((option) => option.comments.length > 0));
</script>

{#snippet comments(list: C[], data: string)}
	<ul class="comments" data-list={data}>
		{#each list as given, index (index)}
			{#if comment}{@render comment(given)}{:else}<li>{textOf(given)}</li>{/if}
		{/each}
	</ul>
{/snippet}

<div class="released-results" data-block={name}>
	<p class="note">{note}</p>
	<table class="results-table" data-table={name}>
		<caption>Responded: {releasedFigure(released.responded)}</caption>
		<thead>
			<tr>
				<th scope="col">Option</th>
				<th scope="col">{score ? 'Mean score' : 'Votes'}</th>
			</tr>
		</thead>
		<tbody>
			{#each released.options as option (option.optionId)}
				<tr>
					<th scope="row">{option.label}{option.title ? `: ${option.title}` : ''}</th>
					<td>{releasedFigure(score ? option.mean : option.votes)}</td>
				</tr>
			{/each}
			<tr><th scope="row">Abstained</th><td>{releasedFigure(released.abstained)}</td></tr>
			<tr><th scope="row">No concerns</th><td>{releasedFigure(released.noConcerns)}</td></tr>
		</tbody>
	</table>
	{#if released.comments.length > 0}
		<h3>Comments</h3>
		{@render comments(released.comments, 'comments')}
	{/if}
	{#each optionComments as option (option.optionId)}
		<h3>On option {option.label}</h3>
		{@render comments(option.comments, `option-${option.optionId}`)}
	{/each}
</div>

<style>
	.released-results { display: flex; flex-direction: column; gap: var(--space-sm); min-width: 0; }
	.note { margin: 0; font-size: 0.9rem; color: var(--text-secondary); }
	h3 { font-size: 1rem; margin: var(--space-xs) 0 0; }
	.results-table { width: 100%; border-collapse: collapse; }
	.results-table caption { text-align: left; font-weight: 600; padding-bottom: var(--space-xs); }
	.results-table th,
	.results-table td { text-align: left; padding: var(--space-xs) var(--space-sm); border-bottom: 1px solid var(--glass-border); overflow-wrap: anywhere; }
	.comments { margin: 0; padding-left: var(--space-lg); display: flex; flex-direction: column; gap: var(--space-xs); }
	.comments li { white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
