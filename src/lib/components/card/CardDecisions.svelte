<!--
  CardDecisions.svelte — the decisions linked to a saved card, in the card
  window's main panel on its details tab, under the subtasks (card 2680,
  decisions 18 and 23; slice 3b).

  What it lists is the window's: the window reads `GET
  /api/cards/:id/decisions` once, when it opens (`loadDecisions`), and keeps
  the answer while another tab is shown, as it keeps its comments and
  dependencies, so this section has no read, `$effect` or `onMount` of its
  own (tests/card-window.test.ts). The answer lists only the decisions the
  viewer may view, with no count of the rest; each is drawn by its title,
  linking to its page, with its shown status and, while it is not ruled, its
  closing time. Read only: links are made and removed on the decision's
  page. It draws nothing for none; a read refused, unanswered or unreadable
  says so in one line, and never blocks the card.
-->
<script lang="ts">
	import type { LinkedDecisionView } from '$lib/decision-register-types';
	import { STATUS_WORDS, shownMoment } from '$lib/decision-words';

	let {
		cardId,
		decisions,
		failed = false
	}: {
		/** The saved card whose decisions are listed. */
		cardId: number;
		/** The window's: the card's linked decisions the viewer may view, newest first. */
		decisions: LinkedDecisionView[];
		/** The window's: its read of them was refused, not answered or not readable. */
		failed?: boolean;
	} = $props();
</script>

{#if decisions.length > 0 || failed}
	<section class="card-decisions" data-section="card-decisions" aria-labelledby="card-decisions-heading-{cardId}">
		<h3 class="section-label" id="card-decisions-heading-{cardId}">Decisions</h3>
		{#if failed}
			<p class="note">The decisions linked to this card could not be loaded.</p>
		{:else}
			<ul class="decisions">
				{#each decisions as decision (decision.id)}
					<li>
						<a class="decision-link" href="/decisions/{decision.id}">{decision.title}</a>
						<span class="status" data-status={decision.shownStatus}>{STATUS_WORDS[decision.shownStatus] ?? decision.shownStatus}</span>
						{#if decision.closesAt !== null}<span class="closes">Closes {shownMoment(decision.closesAt, '')}</span>{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</section>
{/if}

<style>
	.card-decisions { margin-bottom: var(--space-lg); }
	.section-label { font-size: 0.75rem; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.04em; margin: 0 0 var(--space-xs); }
	.decisions { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-xs); }
	.decisions li { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-xs) var(--space-sm); }
	.decision-link { min-height: 44px; display: inline-flex; align-items: center; flex: 1 1 12rem; min-width: 0; overflow-wrap: anywhere; color: var(--text-primary); }
	.status, .closes { font-size: 0.85rem; color: var(--text-secondary); }
	.status { font-weight: 600; }
	.note { margin: 0; font-size: 0.85rem; color: var(--text-secondary); }
</style>
