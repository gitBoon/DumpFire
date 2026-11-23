<!--
  GroupBreakdown.svelte — the current round per group, on a decision's
  results page, for its decider and DumpFire's administrators alone (card
  2686, R11). Never released: no release, preview, summary, mail or webhook
  holds it.

  One table (`data-table="groups"`), captioned "Round N by group": a row
  header per group, as the participants' snapshots name it, and "No group"
  last for those in none; then how many were consulted and how many
  responded; each option's votes in single mode, or its total and mean score
  in score mode; how many abstained and had no concerns; and the option or
  options the group chose most ("tied" where more than one, "–" with no
  votes). A round that put no options to a vote (a survey) has no option
  columns: answered the survey and abstained, as the round's own counts. No
  survey question figure is given per group (R5).

  At phone width each row stacks as a card, each cell labelled by its column
  (`stacked`, as the other results tables). Plain text throughout: a group
  name is never read as markup. The note under it says how people are
  counted and who sees it. Its words live here, not in decision-words.ts.
-->
<script lang="ts">
	import type { GroupTally } from '$lib/decision-view-types';

	let {
		groups,
		options,
		round,
		score,
		survey
	}: {
		/** The current round per group, No group last (`groupBreakdownOf`). */
		groups: GroupTally[];
		/** The current version's live options, in order: a column, or two in score mode, for each. */
		options: { optionId: number; label: string; title: string }[];
		round: number;
		/** Score mode: each option's total and mean in place of its votes. */
		score: boolean;
		/** The round put no options to a vote. */
		survey: boolean;
	} = $props();

	const NO_GROUP = 'No group';

	/** The option columns' headers, in order, each with the figure it reads. */
	const optionColumns = $derived(
		survey
			? []
			: options.flatMap((option) =>
					score
						? [
								{ header: `Total for ${option.label}`, read: (group: GroupTally) => String(group.scores.find((entry) => entry.optionId === option.optionId)?.total ?? 0) },
								{
									header: `Mean for ${option.label}`,
									read: (group: GroupTally) => {
										const mean = group.scores.find((entry) => entry.optionId === option.optionId)?.mean;
										return mean === null || mean === undefined ? '–' : mean.toFixed(1);
									}
								}
							]
						: [{ header: `Votes for ${option.label}`, read: (group: GroupTally) => String(group.votes.find((entry) => entry.optionId === option.optionId)?.count ?? 0) }]
				)
	);

	/** The option or options a group chose most, by label: "tied" where more than one, "–" with no votes. */
	function mostChosenWords(group: GroupTally): string {
		if (group.mostChosen.length === 0) return '–';
		const labels = group.mostChosen.map((optionId) => options.find((option) => option.optionId === optionId)?.label ?? 'An option no longer offered');
		return labels.length === 1 ? labels[0] : `${labels.join(', ')} (tied)`;
	}
</script>

<div class="group-breakdown" data-block="group-breakdown">
	<table class="results-table stacked" data-table="groups">
		<caption>Round {round} by group</caption>
		<thead>
			<tr>
				<th scope="col">Group</th>
				<th scope="col">Consulted</th>
				<th scope="col">Responded</th>
				{#if survey}
					<th scope="col">Answered the survey</th>
					<th scope="col">Abstained</th>
				{:else}
					{#each optionColumns as column, index (index)}
						<th scope="col">{column.header}</th>
					{/each}
					<th scope="col">Abstained</th>
					<th scope="col">No concerns</th>
					<th scope="col">Most chosen</th>
				{/if}
			</tr>
		</thead>
		<tbody>
			{#each groups as group, index (index)}
				<tr>
					<th scope="row">{group.name ?? NO_GROUP}</th>
					<td data-label="Consulted">{group.consulted}</td>
					<td data-label="Responded">{group.responded}</td>
					{#if survey}
						<td data-label="Answered the survey">{group.responded - group.abstained}</td>
						<td data-label="Abstained">{group.abstained}</td>
					{:else}
						{#each optionColumns as column, i (i)}
							<td data-label={column.header}>{column.read(group)}</td>
						{/each}
						<td data-label="Abstained">{group.abstained}</td>
						<td data-label="No concerns">{group.noConcerns}</td>
						<td data-label="Most chosen">{mostChosenWords(group)}</td>
					{/if}
				</tr>
			{/each}
		</tbody>
	</table>
	<p class="note" data-note="group-breakdown">
		Each person is counted in every group they were in when they were included; people in no group are under No group, so the groups do not add up to the
		total. Only the decider and DumpFire's administrators see this, and it is never released.
	</p>
</div>

<style>
	.group-breakdown { display: flex; flex-direction: column; gap: var(--space-xs); min-width: 0; }
	.note { margin: 0; font-size: 0.85rem; color: var(--text-tertiary); }
	.results-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; table-layout: auto; }
	.results-table caption { text-align: left; font-weight: 600; padding-bottom: var(--space-xs); }
	.results-table th,
	.results-table td { text-align: left; vertical-align: top; padding: var(--space-xs) var(--space-sm); border-bottom: 1px solid var(--glass-border); overflow-wrap: anywhere; }
	.results-table thead th { font-size: 0.75rem; color: var(--text-secondary); }

	/* Phone width: each row a labelled card, nothing scrolling sideways, as ResultsView's tables. */
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
	}
</style>
