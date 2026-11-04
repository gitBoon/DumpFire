<!--
  ParticipantBanner.svelte — the banner both participant pages hand
  `DecisionView` (card 2707), so that its words and behaviour cannot drift
  between them.

  In order: the ruling (`RulingBanner`, card 2679) on a ruled decision; the
  withdrawal, with its moment and reason; for a participant, when they were
  told (`toldWords`, D8) and, where the page arms the seen watch, what their
  first action records (`seenNoteWords`, decision 14); then, on a personal
  link alone, that the address is personal (R4) and, in a browser that is
  signed in, that the account is recorded beside what the link does (R8).

  Every prop is required and none has a default. `personalLink` is null on
  the signed-in page and `{ signedInAs }` on the link page: the two link lines
  are drawn only when it is set. With it set, the earlier and later decisions
  are handed to `RulingBanner` with no id or title, whatever this is given, so
  a link holder is never shown another decision's name or address (S8), even
  if a loader were to hand the page more than the server gives it now.
-->
<script lang="ts">
	import type { DecisionPageData } from '$lib/decision-view-types';
	import { seenNoteWords, toldWords, withdrawnWords } from '$lib/decision-words';
	import RulingBanner from './RulingBanner.svelte';

	let {
		decision,
		ruling,
		supersedes,
		laterDecision,
		participant,
		stage,
		personalLink
	}: {
		decision: Pick<DecisionPageData['decision'], 'shownStatus' | 'withdrawnAt' | 'withdrawnReason'>;
		ruling: DecisionPageData['ruling'];
		supersedes: DecisionPageData['supersedes'];
		laterDecision: DecisionPageData['laterDecision'];
		participant: DecisionPageData['participant'];
		stage: DecisionPageData['stage'];
		/** Null on the signed-in page; on a personal link, the signed-in browser's account name, or null. */
		personalLink: { signedInAs: string | null } | null;
	} = $props();

	// On a personal link, the other decisions as the link holder may read them: unnamed and unlinked (S8).
	const earlier = $derived(personalLink !== null && supersedes !== null ? {} : supersedes);
	const later = $derived(personalLink !== null && laterDecision !== null ? { superseded: laterDecision.superseded } : laterDecision);
</script>

{#if ruling !== null}
	<RulingBanner {ruling} supersedes={earlier} laterDecision={later} />
{/if}
{#if decision.shownStatus === 'withdrawn'}
	<p class="banner-line withdrawn">{withdrawnWords(decision.withdrawnAt, decision.withdrawnReason)}</p>
{/if}
{#if participant !== null}
	<p class="banner-line">{toldWords(participant.role, participant.told, participant.includedAt)}</p>
	{#if stage !== null}
		<p class="banner-note" data-note="seen">{seenNoteWords(stage)}</p>
	{/if}
{/if}
{#if personalLink !== null}
	<p class="banner-note personal">This address is personal to you: do not share it.</p>
	{#if personalLink.signedInAs !== null}
		<p class="banner-note signed-in">
			{#if stage === 'ruling'}
				You are signed in as {personalLink.signedInAs}; this is recorded with your concern and with your having seen the ruling.
			{:else}
				You are signed in as {personalLink.signedInAs}; this is recorded with your response and with your having seen this version.
			{/if}
		</p>
	{/if}
{/if}

<style>
	.banner-line { margin: 0 0 var(--space-xs); font-weight: 600; }
	.banner-line.withdrawn { color: var(--accent-rose); }
	/* One spacing for both pages (card 2707, F1): the link page's, which keeps its stacked notes apart. */
	.banner-note { margin: 0 0 var(--space-xs); font-size: 0.9rem; color: var(--text-secondary); }
	.banner-note.personal { font-weight: 600; color: var(--text-primary); }
</style>
