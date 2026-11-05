<!--
  ParticipantBanner.svelte — the banner both participant pages hand
  `DecisionView` (card 2707), so that its words and behaviour cannot drift
  between them.

  In order: the ruling (`RulingBanner`, card 2679) on a ruled decision; the
  withdrawal, with its moment and reason; for a participant, when they were
  told (`toldWords`, D8; an invitation in the role it was sent for, card
  2742, not their role now) and, where the page arms the seen watch, what their
  first action records (`seenNoteWords`, decision 14): with a stage, and only
  while `seenRecorded` is false, as the pages arm no watch once the
  participant's seen exists and a first action would record nothing (card
  2736, D5); then, on a personal link alone, that the address is personal
  (R4) and, in a browser that is signed in, that the account is recorded
  beside what the link does (R8), in `signedInNoteWords`'s words for the
  stage and the page's own `mayRespond`, `mayAsk` and `mayRaiseConcern`, so
  that it claims nothing the link cannot record then (card 2735), and with no
  seen where `seenRecorded` says the participant's seen already exists and
  would not be recorded again (card 2736).

  Every prop is required and none has a default. `personalLink` is null on
  the signed-in page and `{ signedInAs }` on the link page: the two link lines
  are drawn only when it is set. With it set, the earlier and later decisions
  are handed to `RulingBanner` with no id or title, whatever this is given, so
  a link holder is never shown another decision's name or address (S8), even
  if a loader were to hand the page more than the server gives it now.
-->
<script lang="ts">
	import type { DecisionPageData } from '$lib/decision-view-types';
	import { seenNoteWords, signedInNoteWords, toldWords, withdrawnWords } from '$lib/decision-words';
	import RulingBanner from './RulingBanner.svelte';

	let {
		decision,
		ruling,
		supersedes,
		laterDecision,
		participant,
		stage,
		mayRespond,
		mayAsk,
		mayRaiseConcern,
		seenRecorded,
		personalLink
	}: {
		decision: Pick<DecisionPageData['decision'], 'shownStatus' | 'withdrawnAt' | 'withdrawnReason'>;
		ruling: DecisionPageData['ruling'];
		supersedes: DecisionPageData['supersedes'];
		laterDecision: DecisionPageData['laterDecision'];
		participant: DecisionPageData['participant'];
		stage: DecisionPageData['stage'];
		/** The page's own flags for each write, which the signed-in note claims only where set (card 2735). */
		mayRespond: DecisionPageData['mayRespond'];
		mayAsk: DecisionPageData['mayAsk'];
		mayRaiseConcern: DecisionPageData['mayRaiseConcern'];
		/** Whether the participant's seen of this version and stage already exists, so neither note claims one (card 2736). */
		seenRecorded: DecisionPageData['seenRecorded'];
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
	<p class="banner-line">{toldWords(participant.told, participant.includedAt)}</p>
	<!-- Card 2736 (D5): once the seen exists the pages arm no watch, so there is no first action to describe. -->
	{#if stage !== null && !seenRecorded}
		<p class="banner-note" data-note="seen">{seenNoteWords(stage)}</p>
	{/if}
{/if}
{#if personalLink !== null}
	<p class="banner-note personal">This address is personal to you: do not share it.</p>
	{#if personalLink.signedInAs !== null}
		<p class="banner-note signed-in">{signedInNoteWords(personalLink.signedInAs, participant !== null, stage, { mayRespond, mayAsk, mayRaiseConcern, seenRecorded })}</p>
	{/if}
{/if}

<style>
	.banner-line { margin: 0 0 var(--space-xs); font-weight: 600; }
	.banner-line.withdrawn { color: var(--accent-rose); }
	/* One spacing for both pages (card 2707, F1): the link page's, which keeps its stacked notes apart. */
	.banner-note { margin: 0 0 var(--space-xs); font-size: 0.9rem; color: var(--text-secondary); }
	.banner-note.personal { font-weight: 600; color: var(--text-primary); }
</style>
