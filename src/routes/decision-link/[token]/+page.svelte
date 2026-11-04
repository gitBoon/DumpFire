<script lang="ts">
	/**
	 * A decision's page for the holder of a personal link (card 2677,
	 * decisions 3 to 9 and 19, plan 4.2), with no session: the same
	 * `DecisionView` as the signed-in page, with no board's name, no Edit, no
	 * header menu and no link into the rest of DumpFire (the root layout hides
	 * its user badge here, D9).
	 *
	 * Under the banner it says the address is personal (R4) and, in a browser
	 * that is signed in, that the account is recorded beside what the link
	 * does (R8). Each of its writes posts the token in the body to a fixed
	 * path, `/api/decision-by-link/responses`, `/api/decision-by-link/seen`,
	 * `/api/decision-by-link/concerns` and, for a clarification question,
	 * `/api/decision-by-link/questions` (card 2678), so no further address holds it
	 * (decision 4). Having seen this version, or on a ruled or superseded
	 * decision the ruling (card 2679, decision 9), is posted after the
	 * person's first tap, click, key press or turn of the mouse wheel
	 * (decision 14). The page data holds no decision id (code review C5), so
	 * the link's token stands for the decision: the watch is armed again, and
	 * the form drawn afresh, for another token or version (code review C2).
	 *
	 * Card 2679 (decisions 5, 9 and 24): the same ruling banner, released
	 * results and concern form as the signed-in page. A link holder is never
	 * given another decision's title, so the banner says "a later decision" or
	 * "an earlier decision", with no link (S8).
	 *
	 * Card 2678 (decisions 2, 13 and 21): the same questions panel and
	 * question form as the signed-in page, the panel with no answer, publish
	 * or replace control, as a link answers nothing.
	 */
	import type { PageData } from './$types';
	import type { OwnResponse } from '$lib/decision-view-types';
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import ConcernForm from '$lib/components/decision/ConcernForm.svelte';
	import DecisionView from '$lib/components/decision/DecisionView.svelte';
	import QuestionForm from '$lib/components/decision/QuestionForm.svelte';
	import QuestionsPanel from '$lib/components/decision/QuestionsPanel.svelte';
	import ReleasedResults from '$lib/components/decision/ReleasedResults.svelte';
	import ResponseForm from '$lib/components/decision/ResponseForm.svelte';
	import RulingBanner from '$lib/components/decision/RulingBanner.svelte';
	import { watchForSeen } from '$lib/decision-seen';
	import { givenOnWords, responseLines, seenNoteWords, shownMoment, toldWords, withdrawnWords } from '$lib/decision-words';

	let { data }: { data: PageData } = $props();

	/** Moved on by Reload, which draws the form afresh from the data read again. */
	let drawing = $state(0);

	async function reload() {
		await invalidateAll();
		drawing += 1;
	}

	// What the seen watch is armed on, as plain values, so data read again for the same link, version and stage leaves it be.
	const seenToken = $derived(page.params.token);
	const seenVersion = $derived(data.participant === null ? null : (data.version?.number ?? null));
	const seenStage = $derived(data.stage);

	$effect(() => {
		if (seenVersion === null || seenStage === null) return;
		// Its stopper runs before the next arming and when the page goes.
		return watchForSeen('/api/decision-by-link/seen', { token: seenToken, versionNumber: seenVersion, stage: seenStage });
	});
</script>

<svelte:head>
	<title>{data.decision.title} — DumpFire</title>
	<meta name="robots" content="noindex" />
	<!-- Beside the answer's Referrer-Policy header, for a copy of the page saved or served without it (code review C10). -->
	<meta name="referrer" content="no-referrer" />
</svelte:head>

{#snippet banner()}
	{#if data.ruling !== null}
		<RulingBanner ruling={data.ruling} supersedes={data.supersedes} laterDecision={data.laterDecision} />
	{/if}
	{#if data.decision.shownStatus === 'withdrawn'}
		<p class="banner-line withdrawn">{withdrawnWords(data.decision.withdrawnAt, data.decision.withdrawnReason)}</p>
	{/if}
	{#if data.participant !== null}
		<p class="banner-line">{toldWords(data.participant.role, data.participant.told, data.participant.includedAt)}</p>
		{#if data.stage !== null}
			<p class="banner-note" data-note="seen">{seenNoteWords(data.stage)}</p>
		{/if}
	{/if}
	<p class="banner-note personal">This address is personal to you: do not share it.</p>
	{#if data.signedInAs !== null}
		<p class="banner-note signed-in">
			{#if data.stage === 'ruling'}
				You are signed in as {data.signedInAs}; this is recorded with your concern and with your having seen the ruling.
			{:else}
				You are signed in as {data.signedInAs}; this is recorded with your response and with your having seen this version.
			{/if}
		</p>
	{/if}
{/snippet}

{#snippet releasedResults()}
	{#if data.released !== null}<ReleasedResults released={data.released} />{/if}
{/snippet}

{#snippet concern()}
	<!-- Drawn afresh for another link, the token in place of the decision id the page is not given. -->
	{#key page.params.token}
		<ConcernForm url="/api/decision-by-link/concerns" extra={{ token: page.params.token }} concerns={data.concerns} mayRaise={data.mayRaiseConcern} />
	{/key}
{/snippet}

{#snippet questions()}
	<!-- Drawn afresh for another link. Never given `mayAnswer` or a decision id: a link answers nothing (card 2678, decision 13). -->
	{#key page.params.token}
		<QuestionsPanel questions={data.questions} shownVersion={data.version?.number} />
		{#if data.participant !== null}
			<QuestionForm
				url="/api/decision-by-link/questions"
				extra={{ token: page.params.token }}
				mayAsk={data.mayAsk}
				questions={data.questions}
				shownStatus={data.decision.shownStatus}
			/>
		{/if}
	{/key}
{/snippet}

{#snippet givenResponse(heading: string, response: OwnResponse)}
	{@const givenOn = givenOnWords(response, data.version?.number)}
	<p>{heading}</p>
	{#each responseLines(response, data.options) as line, i (i)}<p class="response-line">{line}</p>{/each}
	{#if givenOn !== null}<p class="given-on">{givenOn}</p>{/if}
{/snippet}

{#snippet yourResponse()}
	{#if data.earlierResponse !== null && data.ownResponse === null && data.version !== null}
		<div class="earlier">
			<p>This decision changed on {shownMoment(data.version.publishedAt, '')}. Your earlier response was for version {data.earlierResponse.versionNumber}:</p>
			{#each responseLines(data.earlierResponse, data.options) as line, i (i)}<p class="response-line">{line}</p>{/each}
		</div>
	{/if}
	{#if data.mayRespond && data.version !== null}
		<noscript><p class="noscript">Responding needs JavaScript, which is off in this browser.</p></noscript>
		<!-- Drawn afresh for another link or version, as well as by Reload (code review C2); the token in place of the decision id the page is not given. -->
		{#key `${page.params.token}:${data.version?.number}:${drawing}`}
			<ResponseForm
				voteMode={data.decision.voteMode}
				options={data.options}
				versionNumber={data.version.number}
				url="/api/decision-by-link/responses"
				extra={{ token: page.params.token }}
				initial={data.ownResponse}
				onReload={reload}
			/>
		{/key}
	{:else if data.decision.shownStatus === 'awaiting_ruling'}
		<p>Responses closed on {shownMoment(data.decision.closesAt, 'its closing time')}.</p>
		{#if data.ownResponse !== null}
			{@render givenResponse('Your response:', data.ownResponse)}
		{:else}
			<p>You gave no response in this round.</p>
		{/if}
	{:else if data.decision.shownStatus === 'ruled' || data.decision.shownStatus === 'superseded' || data.decision.shownStatus === 'withdrawn'}
		<!-- Not an empty section (code review C7). -->
		<p>Responses are closed.</p>
		{#if data.ownResponse !== null}
			{@render givenResponse('Your last response:', data.ownResponse)}
		{/if}
	{/if}
{/snippet}

<div class="link-page">
	<header class="link-header">
		<span class="logo"><span aria-hidden="true">🔥</span> DumpFire</span>
	</header>

	<main class="link-content">
		{#if data.draft || data.version === null}
			<section class="not-opened">
				<h1>{data.decision.title}</h1>
				<p>This decision has not been opened yet.</p>
			</section>
		{:else}
			<DecisionView
				decision={data.decision}
				content={data.version.content}
				options={data.options}
				audiences={data.audiences}
				participant={data.participant === null ? null : { role: data.participant.role }}
				mode="participant"
				{banner}
				response={yourResponse}
				results={data.released !== null ? releasedResults : undefined}
				concern={data.participant !== null && (data.mayRaiseConcern || data.concerns.length > 0) ? concern : undefined}
				questions={data.questions.length > 0 || data.mayAsk ? questions : undefined}
			/>
		{/if}
	</main>
</div>

<style>
	.link-page { min-height: 100vh; }
	.link-header { max-width: 46rem; margin: 0 auto; padding: var(--space-md); }
	.logo { font-weight: 700; font-size: 1.1rem; color: var(--text-primary); }
	/* One column, phone first (decision 22). No user badge is drawn here (D9). */
	.link-content { max-width: 46rem; margin: 0 auto; padding: 0 var(--space-md) var(--space-2xl); }
	.not-opened h1 { font-size: 1.2rem; margin: 0 0 var(--space-sm); }
	.banner-line { margin: 0 0 var(--space-xs); font-weight: 600; }
	.banner-line.withdrawn { color: var(--accent-rose); }
	.banner-note { margin: 0 0 var(--space-xs); font-size: 0.9rem; color: var(--text-secondary); }
	.banner-note.personal { font-weight: 600; color: var(--text-primary); }
	.earlier { padding: var(--space-md); border-radius: var(--radius-md); background: var(--bg-elevated); margin-bottom: var(--space-md); }
	.earlier p { margin: 0 0 var(--space-xs); }
	.response-line { white-space: pre-wrap; overflow-wrap: anywhere; }
	.given-on { font-weight: 600; }
	.noscript { font-weight: 600; }
</style>
