<script lang="ts">
	/**
	 * A decision's page, signed in (card 2677, decisions 3, 19 and 20, plan
	 * 4.2): the board's name, Edit where the caller may edit, and the
	 * published version in `DecisionView`.
	 *
	 * A participant the decision still reaches is given the banner and, when
	 * consulted, who sees their response and the form, which posts to
	 * `/api/decisions/[id]/responses`. Their first tap, click, key press or
	 * turn of the mouse wheel on the page posts that they have seen this
	 * version (decision 14); a caller who is no participant arms no such
	 * watch, and posts nothing (D7), and a ruled or superseded decision has no
	 * stage to post until card 2679 shows the ruling. The watch is armed again,
	 * and the form drawn afresh, when the page is read for another decision or
	 * version (code review C2). Anyone else who may view it reads the version
	 * and its status alone. A draft shows that it has not been opened yet.
	 */
	import type { PageData } from './$types';
	import type { OwnResponse } from '$lib/decision-view-types';
	import { invalidateAll } from '$app/navigation';
	import HeaderMenu from '$lib/components/HeaderMenu.svelte';
	import ThemeMenuItems from '$lib/components/ThemeMenuItems.svelte';
	import DecisionView from '$lib/components/decision/DecisionView.svelte';
	import ResponseForm from '$lib/components/decision/ResponseForm.svelte';
	import { watchForSeen } from '$lib/decision-seen';
	import { givenOnWords, responseLines, shownMoment, toldWords, withdrawnWords } from '$lib/decision-words';
	import { theme, themeIcon } from '$lib/stores/theme';

	let { data }: { data: PageData } = $props();

	/** Moved on by Reload, which draws the form afresh from the data read again. */
	let drawing = $state(0);

	async function reload() {
		await invalidateAll();
		drawing += 1;
	}

	// What the seen watch is armed on, as plain values, so data read again for the same decision, version and stage leaves it be.
	const seenDecision = $derived(data.decision.id);
	// A participant only (D7): a board reader, the author, the decider or an administrator who is no participant sends nothing.
	const seenVersion = $derived(data.participant === null ? null : (data.version?.number ?? null));
	const seenStage = $derived(data.stage);

	$effect(() => {
		if (seenVersion === null || seenStage === null) return;
		// Its stopper runs before the next arming and when the page goes.
		return watchForSeen(`/api/decisions/${seenDecision}/seen`, { versionNumber: seenVersion, stage: seenStage });
	});
</script>

<svelte:head>
	<title>{data.decision.title} — DumpFire</title>
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
		<!-- Drawn afresh for another decision or version, as well as by Reload (code review C2). -->
		{#key `${data.decision.id}:${data.version?.number}:${drawing}`}
			<ResponseForm
				voteMode={data.decision.voteMode}
				options={data.options}
				versionNumber={data.version.number}
				url="/api/decisions/{data.decision.id}/responses"
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

<div class="decision-page">
	<header class="decision-header glass">
		<div class="decision-header-inner">
			<a href="/" class="header-logo" title="Back to DumpFire">
				<span class="logo-fire">🔥</span>
				<span class="logo-text">DumpFire</span>
			</a>
			<nav class="crumb" aria-label="Where this is">
				{#if data.decision.boardName !== null}<span>{data.decision.boardName}</span>{/if}
			</nav>
			{#if data.mayEdit}
				<a class="btn-ghost edit-link" href="/decisions/{data.decision.id}/edit">Edit</a>
			{/if}
			<HeaderMenu label="Theme" triggerClass="btn-ghost" triggerTitle="Change theme">
				{#snippet trigger()}<span aria-hidden="true">{themeIcon($theme)}</span>{/snippet}
				<ThemeMenuItems heading={false} />
			</HeaderMenu>
		</div>
	</header>

	<main class="decision-content">
		{#if data.draft || data.version === null}
			<section class="not-opened glass">
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
	.decision-page { min-height: 100vh; padding-top: 64px; }
	.decision-header {
		position: fixed; top: 0; left: 0; right: 0; z-index: 200;
		height: 64px; border-bottom: 1px solid var(--glass-border);
		backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
	}
	.decision-header-inner {
		max-width: 1400px; margin: 0 auto; height: 100%;
		display: flex; align-items: center; gap: var(--space-md);
		padding: 0 var(--space-xl);
	}
	.header-logo {
		display: flex; align-items: center; gap: var(--space-sm);
		text-decoration: none; color: var(--text-primary);
		font-weight: 700; font-size: 1.1rem;
	}
	.logo-fire { font-size: 1.4rem; }
	.crumb { flex: 1; font-size: 0.85rem; min-width: 0; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.edit-link { min-height: 44px; display: inline-flex; align-items: center; text-decoration: none; }

	/* One column, phone first; the page's last line stops above the user badge (card 2239). */
	.decision-content { max-width: 46rem; margin: 0 auto; padding: var(--space-xl) var(--space-md) var(--user-badge-space); }
	@media (max-width: 640px) {
		.decision-header-inner { padding: 0 var(--space-md); }
		.logo-text { display: none; }
	}
	.not-opened { padding: var(--space-xl); border-radius: var(--radius-lg); }
	.not-opened h1 { font-size: 1.2rem; margin: 0 0 var(--space-sm); }
	.banner-line { margin: 0 0 var(--space-xs); font-weight: 600; }
	.banner-line.withdrawn { color: var(--accent-rose); }
	.banner-note { margin: 0; font-size: 0.9rem; color: var(--text-secondary); }
	.earlier { padding: var(--space-md); border-radius: var(--radius-md); background: var(--bg-elevated); margin-bottom: var(--space-md); }
	.earlier p { margin: 0 0 var(--space-xs); }
	.response-line { white-space: pre-wrap; overflow-wrap: anywhere; }
	.given-on { font-weight: 600; }
	.noscript { font-weight: 600; }
</style>
