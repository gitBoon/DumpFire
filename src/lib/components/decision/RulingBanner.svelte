<!--
  RulingBanner.svelte — a ruled decision's ruling, in the banner of both
  participant pages, to everyone who may view it (card 2679, decisions 5, 9
  and 23).

  "Ruled by <decider>: Option <label>: <title>", or "None of these", then the
  reason and the conditions, each as text, never markdown. No moment, no
  "against" and no "early": the page is given none (decision 26). Card 2683
  (R18): where the version ruled on put no options to a vote, "No options
  were put to a vote" in place of "None of these" (`rulingWords`).

  Then, where it applies, the decision that superseded this one, or was ruled
  on beside it, and the decision this one supersedes. Each is named, and
  linked, only where the server gave its id and title, which it does for a
  signed-in viewer who may view that decision alone; anyone else, a link
  holder always, reads "a later decision" or "an earlier decision" (S8).
-->
<script lang="ts">
	import type { DecisionPageData, RulingView } from '$lib/decision-view-types';
	import { earlierDecisionWords, laterDecisionWords, rulingWords } from '$lib/decision-words';

	let {
		ruling,
		supersedes = null,
		laterDecision = null
	}: {
		ruling: RulingView;
		supersedes?: DecisionPageData['supersedes'];
		laterDecision?: DecisionPageData['laterDecision'];
	} = $props();
</script>

<div class="ruling-banner" data-block="ruling">
	<p class="ruling-line" data-line="ruling">{rulingWords(ruling)}</p>
	<p class="ruling-text" data-line="reason"><span class="label">Why:</span> {ruling.reason}</p>
	{#if ruling.conditions !== null && ruling.conditions !== ''}
		<p class="ruling-text" data-line="conditions"><span class="label">Conditions:</span> {ruling.conditions}</p>
	{/if}
	{#if laterDecision !== null}
		<p class="ruling-link" data-line="later">
			{#if laterDecision.id !== undefined && laterDecision.title !== undefined}
				<a href="/decisions/{laterDecision.id}">{laterDecisionWords(laterDecision)}</a>
			{:else}
				{laterDecisionWords({ superseded: laterDecision.superseded })}
			{/if}
		</p>
	{/if}
	{#if supersedes !== null}
		<p class="ruling-link" data-line="earlier">
			{#if supersedes.id !== undefined && supersedes.title !== undefined}
				<a href="/decisions/{supersedes.id}">{earlierDecisionWords(supersedes)}</a>
			{:else}
				{earlierDecisionWords({})}
			{/if}
		</p>
	{/if}
</div>

<style>
	.ruling-banner {
		display: flex; flex-direction: column; gap: var(--space-xs); margin: 0 0 var(--space-sm);
		padding: var(--space-md); border-radius: var(--radius-md); background: rgba(99, 102, 241, 0.08); border: 1px solid var(--glass-border);
	}
	.ruling-banner p { margin: 0; }
	.ruling-line { font-weight: 700; overflow-wrap: anywhere; }
	.ruling-text { white-space: pre-wrap; overflow-wrap: anywhere; }
	.label { font-weight: 600; }
	.ruling-link { font-size: 0.9rem; overflow-wrap: anywhere; }
	.ruling-link a { color: var(--accent-indigo); }
</style>
