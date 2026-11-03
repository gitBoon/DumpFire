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
	 * does (R8). Both of its writes post the token in the body to fixed paths,
	 * `/api/decision-by-link/responses` and `/api/decision-by-link/seen`, so no
	 * further address holds it (decision 4). Having seen this version is posted
	 * after the person's first tap, click, key press or turn of the mouse wheel
	 * (decision 14), and not on a ruled or superseded decision until card 2679
	 * shows the ruling. The page data holds no decision id (code review C5), so
	 * the link's token stands for the decision: the watch is armed again, and
	 * the form drawn afresh, for another token or version (code review C2).
	 */
	import type { PageData } from './$types';
	import type { OwnResponse } from '$lib/decision-view-types';
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import DecisionView from '$lib/components/decision/DecisionView.svelte';
	import ResponseForm from '$lib/components/decision/ResponseForm.svelte';
	import { watchForSeen } from '$lib/decision-seen';
	import { givenOnWords, responseLines, shownMoment, toldWords, withdrawnWords } from '$lib/decision-words';

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
	{#if data.decision.shownStatus === 'withdrawn'}
		<p class="banner-line withdrawn">{withdrawnWords(data.decision.withdrawnAt, data.decision.withdrawnReason)}</p>
	{/if}
	{#if data.participant !== null}
		<p class="banner-line">{toldWords(data.participant.role, data.participant.told, data.participant.includedAt)}</p>
		{#if data.stage !== null}
			<p class="banner-note">Your first tap, click, key press or turn of the mouse wheel on this page is recorded as your having seen this version.</p>
		{/if}
	{/if}
	<p class="banner-note personal">This address is personal to you: do not share it.</p>
	{#if data.signedInAs !== null}
		<p class="banner-note signed-in">
			You are signed in as {data.signedInAs}; this is recorded with your response and with your having seen this version.
		</p>
	{/if}
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
