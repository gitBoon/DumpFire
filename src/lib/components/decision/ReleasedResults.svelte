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

  Card 3087: on the UI kit's `Table`, its caption and `data-table` as
  before, the figures at the right in tabular digits (`ui-table-num`); two
  columns, so not stacked at phone width. The comments are rows divided by a
  line, a page's own item (the preview's Leave out) among them.
-->
<script lang="ts" generics="C extends string | PreviewComment">
	import type { Snippet } from 'svelte';
	import type { PreviewComment, ReleasedResults } from '$lib/decision-view-types';
	import { releasedFigure } from '$lib/decision-words';
	import Table from '$lib/components/ui/Table.svelte';

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
	<!-- svelte-ignore a11y_no_redundant_roles -->
	<ul role="list" class="comments" data-list={data}>
		{#each list as given, index (index)}
			{#if comment}{@render comment(given)}{:else}<li class="comment-text">{textOf(given)}</li>{/if}
		{/each}
	</ul>
{/snippet}

<div class="released-results" data-block={name}>
	<p class="note">{note}</p>
	<Table region={false} caption="Responded: {releasedFigure(released.responded)}" class="results-table" data-table={name}>
		<thead>
			<tr>
				<th scope="col">Option</th>
				<th scope="col" class="ui-table-num">{score ? 'Mean score' : 'Votes'}</th>
			</tr>
		</thead>
		<tbody>
			{#each released.options as option (option.optionId)}
				<tr>
					<th scope="row">{option.label}{option.title ? `: ${option.title}` : ''}</th>
					<td class="ui-table-num">{releasedFigure(score ? option.mean : option.votes)}</td>
				</tr>
			{/each}
			<tr><th scope="row">Abstained</th><td class="ui-table-num">{releasedFigure(released.abstained)}</td></tr>
			<tr><th scope="row">No concerns</th><td class="ui-table-num">{releasedFigure(released.noConcerns)}</td></tr>
		</tbody>
	</Table>
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
	.released-results {
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
		min-width: 0;
		color: var(--ui-foreground);
	}
	.note {
		margin: 0 0 var(--space-xs);
		font-size: 0.875rem;
		line-height: 1.5;
		color: var(--ui-muted-foreground);
	}
	h3 {
		margin: var(--space-md) 0 0;
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--ui-foreground);
	}
	/* The comments as rows: no bullets, a line between them. A page's own item (the preview's Leave out) is drawn the same. With no bullets Safari and VoiceOver drop the list's role, so the `ul` says `role="list"` (code review L1). */
	.comments {
		margin: 0;
		padding: 0;
		list-style: none;
		font-size: 0.875rem;
	}
	.comments :global(li) {
		padding: 0.625rem 0;
		border-top: 1px solid var(--ui-border);
		overflow-wrap: anywhere;
	}
	.comment-text {
		white-space: pre-wrap;
	}
	.comments :global(li:first-child) {
		border-top: none;
		padding-top: 0.25rem;
	}
	.comments :global(li:last-child) {
		padding-bottom: 0;
	}
</style>
