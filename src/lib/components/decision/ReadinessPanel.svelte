<!--
  ReadinessPanel.svelte — a decision's readability check, in the editor's
  side column (card 2676, decisions 11 and 12, R4).

  It draws what it is handed and works nothing out. The refusals (what stops
  a draft being opened) are the server's, in its words and in
  `openDecision`'s order: the facts they come from (the decider's access, the
  participants' persons, the mail settings) never reach the page. The
  warnings are `checkContent`'s, which the editor runs again on edits not yet
  saved. A warning does not stop opening.
-->
<script lang="ts">
	import type { Refusal, Warning } from '$lib/decision-readiness';

	let {
		refusals,
		warnings,
		draft
	}: {
		/** The server's refusals, as it gave them. Asked of a draft alone. */
		refusals: Refusal[];
		warnings: Warning[];
		/** The decision is a draft: what stops it being opened is said. */
		draft: boolean;
	} = $props();

	const uid = $props.id();
	const headingId = `readiness-${uid}`;
</script>

<section class="readiness" aria-labelledby={headingId}>
	<h3 id={headingId}>Readability</h3>
	{#if draft}
		{#if refusals.length === 0}
			<p class="readiness-ok">Nothing stops this decision being opened.</p>
		{:else}
			<p class="readiness-sub">What stops it being opened</p>
			<ul class="readiness-list refusals">
				{#each refusals as refusal, i (i)}
					<li data-code={refusal.code}>{refusal.words}</li>
				{/each}
			</ul>
		{/if}
	{/if}
	{#if warnings.length === 0}
		<p class="readiness-ok">No warnings.</p>
	{:else}
		<p class="readiness-sub">Worth a look first</p>
		<ul class="readiness-list warnings">
			{#each warnings as warning, i (i)}
				<li data-code={warning.code}>{warning.words}</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	.readiness h3 { font-size: 0.9rem; margin: 0 0 var(--space-sm); }
	.readiness-sub { font-size: 0.75rem; font-weight: 600; color: var(--text-secondary); margin: var(--space-sm) 0 var(--space-xs); }
	.readiness-ok { font-size: 0.8rem; color: var(--text-tertiary); margin: var(--space-xs) 0; }
	.readiness-list { margin: 0; padding-left: 1.1rem; font-size: 0.8rem; display: flex; flex-direction: column; gap: 2px; }
	.refusals li { color: var(--accent-rose); }
	.warnings li { color: var(--text-primary); }
</style>
