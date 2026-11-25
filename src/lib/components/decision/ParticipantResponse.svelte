<!--
  ParticipantResponse.svelte — the response section both participant pages
  hand `DecisionView` (card 2707), so that its words and behaviour cannot
  drift between them. `DecisionView` draws it for a consulted participant
  alone.

  The response of an earlier round, for its version, where there is none in
  this one; then, while the participant may respond, `ResponseForm`; once the
  decision awaits its ruling, when responses closed and the response given in
  this round, or that none was; and on a ruled, superseded or withdrawn
  decision "Responses are closed." with the last response, never an empty
  section (code review C7). A response given on an older version is labelled
  with it (C1).

  It is handed only the fields it reads, never the page data. `url` and
  `extra` are where `ResponseForm` posts and what it sends beside the
  response: the signed-in page's `/api/decisions/[id]/responses`, or the
  personal link's `/api/decision-by-link/responses` with the token in
  `extra`, so that no address holds it. `drawnFor` is what the form is drawn
  afresh for, with the version and Reload's count (code review C2): the
  decision's id, or, on the link page, which is given no id (code review C5),
  the token. It is a key alone, never drawn or sent. Reload reads the page
  again (`invalidateAll`) and draws the form afresh from it.

  Card 2683: the version's survey questions (`surveyQuestions`) go to the
  form, which draws them with their inputs; where no form is drawn they are
  drawn alone, with no input (`SurveyQuestions`). A response of this round
  is said back with its answers, by prompt; one of an earlier round says how
  many questions were answered, not what, as that round's questions may have
  changed since (R8).
-->
<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import type { DecisionPageData, OwnResponse } from '$lib/decision-view-types';
	import { earlierAnswersWords, givenOnWords, responseLines, shownMoment, surveyAnswerLines, surveyWhoSees } from '$lib/decision-words';
	import ResponseForm from './ResponseForm.svelte';
	import SurveyQuestions from './SurveyQuestions.svelte';

	let {
		decision,
		version,
		options,
		surveyQuestions = [],
		ownResponse,
		earlierResponse,
		mayRespond,
		url,
		extra = {},
		drawnFor
	}: {
		decision: Pick<DecisionPageData['decision'], 'voteMode' | 'shownStatus' | 'closesAt' | 'deciderName'>;
		version: Pick<NonNullable<DecisionPageData['version']>, 'number' | 'publishedAt'> | null;
		options: DecisionPageData['options'];
		/** Card 2683: the version's survey questions. */
		surveyQuestions?: DecisionPageData['surveyQuestions'];
		ownResponse: DecisionPageData['ownResponse'];
		earlierResponse: DecisionPageData['earlierResponse'];
		mayRespond: boolean;
		/** Where the form posts. */
		url: string;
		/** Sent beside the response: the personal link's token. */
		extra?: Record<string, unknown>;
		/** What the form is drawn afresh for: the decision's id, or the link's token. Never drawn or sent. */
		drawnFor: string | number | undefined;
	} = $props();

	/** Moved on by Reload, which draws the form afresh from the data read again. */
	let drawing = $state(0);

	async function reload() {
		await invalidateAll();
		drawing += 1;
	}
</script>

{#snippet givenResponse(heading: string, response: OwnResponse)}
	{@const givenOn = givenOnWords(response, version?.number)}
	<p>{heading}</p>
	{#each [...responseLines(response, options), ...surveyAnswerLines(response.answers, surveyQuestions)] as line, i (i)}<p class="response-line">{line}</p>{/each}
	{#if givenOn !== null}<p class="given-on">{givenOn}</p>{/if}
{/snippet}

{#if earlierResponse !== null && ownResponse === null && version !== null}
	<div class="earlier">
		<p>This decision changed on {shownMoment(version.publishedAt, '')}. Your earlier response was for version {earlierResponse.versionNumber}:</p>
		{#each responseLines(earlierResponse, options) as line, i (i)}<p class="response-line">{line}</p>{/each}
		{#if earlierAnswersWords(earlierResponse.answers) !== null}<p class="response-line">{earlierAnswersWords(earlierResponse.answers)}</p>{/if}
	</div>
{/if}
{#if !(mayRespond && version !== null) && surveyQuestions.length > 0}
	<SurveyQuestions questions={surveyQuestions} whoSees={surveyWhoSees(decision.deciderName ?? 'the decider')} />
{/if}
{#if mayRespond && version !== null}
	<noscript><p class="noscript">Responding needs JavaScript, which is off in this browser.</p></noscript>
	<!-- Drawn afresh for another decision or link, or version, as well as by Reload (code review C2). -->
	{#key `${drawnFor}:${version?.number}:${drawing}`}
		<ResponseForm
			voteMode={decision.voteMode}
			{options}
			{surveyQuestions}
			deciderName={decision.deciderName}
			versionNumber={version.number}
			{url}
			{extra}
			initial={ownResponse}
			onReload={reload}
			onRecorded={() => invalidateAll()}
		/>
	{/key}
{:else if decision.shownStatus === 'awaiting_ruling'}
	<p>Responses closed on {shownMoment(decision.closesAt, 'its closing time')}.</p>
	{#if ownResponse !== null}
		{@render givenResponse('Your response:', ownResponse)}
	{:else}
		<p>You gave no response in this round.</p>
	{/if}
{:else if decision.shownStatus === 'ruled' || decision.shownStatus === 'superseded' || decision.shownStatus === 'withdrawn'}
	<!-- Not an empty section (code review C7). -->
	<p>Responses are closed.</p>
	{#if ownResponse !== null}
		{@render givenResponse('Your last response:', ownResponse)}
	{/if}
{/if}

<style>
	.earlier { padding: var(--space-md); border-radius: var(--radius-md); background: var(--bg-elevated); margin-bottom: var(--space-md); }
	.earlier p { margin: 0 0 var(--space-xs); }
	.response-line { white-space: pre-wrap; overflow-wrap: anywhere; }
	.given-on { font-weight: 600; }
	.noscript { font-weight: 600; }
</style>
