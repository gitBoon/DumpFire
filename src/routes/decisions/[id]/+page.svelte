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
	 * version (decision 14), or, on a ruled or superseded decision, the ruling
	 * (card 2679, decision 9); a caller who is no participant is given no
	 * stage, arms no such watch, and posts nothing (D7, F7). The watch is
	 * armed again, and the form drawn afresh, when the page is read for
	 * another decision or version (code review C2). Anyone else who may view
	 * it reads the version and its status alone. A draft shows that it has not
	 * been opened yet.
	 *
	 * Card 2679 (decisions 5, 9, 15 and 24): on a ruled decision, the ruling
	 * in the banner (`RulingBanner`) to everyone who may view it, with the
	 * later or earlier decision where one applies; the released results
	 * (`ReleasedResults`) once released; and a participant's concern form
	 * (`ConcernForm`), posting to `/api/decisions/[id]/concerns`, with their
	 * own concerns. Above the decision, Results and ruling where the caller
	 * may read the results, and Supersede… where they may supersede it: a
	 * title, the old one to start from, posted to
	 * `/api/decisions/[id]/supersede`, and then the new draft's editor.
	 *
	 * Card 2678 (decisions 2 and 21): the decision's questions and answers
	 * (`QuestionsPanel`), as the caller was given them, with the answer,
	 * publish and replace controls where the caller may answer now; and, for
	 * a participant, the question form (`QuestionForm`), always mounted,
	 * posting to `/api/decisions/[id]/questions`. The section is drawn only
	 * where there is a question or the caller may ask one.
	 *
	 * Card 2680 (decision 29): Record, to the decision's record view, where
	 * `mayReadRecord`: the decider with board edit while the board exists, and
	 * administrators. And (decisions 18 and 23, slice 3b) the linked cards on
	 * boards the caller can open (`LinkedCards`), with Link and a card search
	 * where `mayLinkCards`, and Unlink where `mayUnlinkCards`; the section is
	 * drawn where there is a card or the caller may link or unlink one.
	 *
	 * Card 2707: the banner and the response section are components shared
	 * with the link page, `ParticipantBanner` (with no personal link) and
	 * `ParticipantResponse` (to this page's route, keyed on the decision), so
	 * the two pages cannot drift. Everything above that only this page has
	 * stays here, never in them.
	 */
	import { tick } from 'svelte';
	import type { PageData } from './$types';
	import { goto } from '$app/navigation';
	import { failureMessage } from '$lib/api';
	import HeaderMenu from '$lib/components/HeaderMenu.svelte';
	import ThemeMenuItems from '$lib/components/ThemeMenuItems.svelte';
	import ConcernForm from '$lib/components/decision/ConcernForm.svelte';
	import DecisionView from '$lib/components/decision/DecisionView.svelte';
	import LinkedCards from '$lib/components/decision/LinkedCards.svelte';
	import ParticipantBanner from '$lib/components/decision/ParticipantBanner.svelte';
	import ParticipantResponse from '$lib/components/decision/ParticipantResponse.svelte';
	import QuestionForm from '$lib/components/decision/QuestionForm.svelte';
	import QuestionsPanel from '$lib/components/decision/QuestionsPanel.svelte';
	import ReleasedResults from '$lib/components/decision/ReleasedResults.svelte';
	import { DECISION_TITLE_MAX } from '$lib/decision-rules';
	import { watchForSeen } from '$lib/decision-seen';
	import { theme, themeIcon } from '$lib/stores/theme';

	let { data }: { data: PageData } = $props();

	// ─── Supersede (card 2679, decision 5) ───────────────────────────────────
	let superseding = $state(false);
	let supersedeTitle = $state('');
	let supersedeBusy = $state(false);
	let supersedeRefused = $state('');
	let supersedeToggle = $state<HTMLButtonElement>();
	let supersedeField = $state<HTMLInputElement>();

	/** Open the form, the old title to start from and the focus in it; or close it, the focus back on its toggle. */
	async function toggleSupersede() {
		superseding = !superseding;
		supersedeRefused = '';
		if (superseding) supersedeTitle = data.decision.title;
		await tick();
		(superseding ? supersedeField : supersedeToggle)?.focus();
	}

	async function supersede() {
		if (supersedeBusy || supersedeTitle.trim() === '') return;
		supersedeBusy = true;
		supersedeRefused = '';
		try {
			const res = await fetch(`/api/decisions/${data.decision.id}/supersede`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ title: supersedeTitle })
			});
			if (res.ok) {
				const answer = (await res.json()) as { decision: { id: number } };
				await goto(`/decisions/${answer.decision.id}/edit`);
				return;
			}
			supersedeRefused = await failureMessage(res, 'No superseding draft was made.');
		} catch {
			supersedeRefused = 'No answer from the server. It is not known whether a superseding draft was made.';
		} finally {
			supersedeBusy = false;
		}
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
	<ParticipantBanner
		decision={data.decision}
		ruling={data.ruling}
		supersedes={data.supersedes}
		laterDecision={data.laterDecision}
		participant={data.participant}
		stage={data.stage}
		mayRespond={data.mayRespond}
		mayAsk={data.mayAsk}
		mayRaiseConcern={data.mayRaiseConcern}
		personalLink={null}
	/>
{/snippet}

{#snippet releasedResults()}
	{#if data.released !== null}<ReleasedResults released={data.released} />{/if}
{/snippet}

{#snippet concern()}
	<!-- Drawn afresh for another decision, so one decision's concerns are never listed on another's. -->
	{#key data.decision.id}
		<ConcernForm url="/api/decisions/{data.decision.id}/concerns" concerns={data.concerns} mayRaise={data.mayRaiseConcern} />
	{/key}
{/snippet}

{#snippet linkedCards()}
	<!-- Drawn afresh for another decision, so one decision's search and words are never shown on another's. -->
	<!-- The signed-in page's decision always carries its id; only the personal link's leaves it out. -->
	{#if data.decision.id !== undefined}
		{#key data.decision.id}
			<LinkedCards decisionId={data.decision.id} cards={data.linkedCards ?? []} mayLink={data.mayLinkCards ?? false} mayUnlink={data.mayUnlinkCards ?? false} />
		{/key}
	{/if}
{/snippet}

{#snippet questions()}
	<!-- Drawn afresh for another decision, so one decision's typed answers are never offered on another's. -->
	{#key data.decision.id}
		<QuestionsPanel questions={data.questions} decisionId={data.decision.id} mayAnswer={data.mayAnswer ?? false} shownVersion={data.version?.number} />
		{#if data.participant !== null}
			<QuestionForm url="/api/decisions/{data.decision.id}/questions" mayAsk={data.mayAsk} questions={data.questions} shownStatus={data.decision.shownStatus} />
		{/if}
	{/key}
{/snippet}

{#snippet yourResponse()}
	<!-- Drawn afresh for another decision, as well as for another version and by Reload (code review C2). -->
	<ParticipantResponse
		decision={data.decision}
		version={data.version}
		options={data.options}
		ownResponse={data.ownResponse}
		earlierResponse={data.earlierResponse}
		mayRespond={data.mayRespond}
		url="/api/decisions/{data.decision.id}/responses"
		drawnFor={data.decision.id}
	/>
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
		{#if data.mayReadResults || data.maySupersede || data.mayReadRecord}
			<!-- Not in the fixed header, which has no room for them at phone width. -->
			<nav class="page-actions" aria-label="What you can do with this decision">
				{#if data.mayReadResults}
					<a class="btn-ghost page-action" href="/decisions/{data.decision.id}/results" data-action="results">Results and ruling</a>
				{/if}
				{#if data.mayReadRecord}
					<a class="btn-ghost page-action" href="/decisions/{data.decision.id}/record" data-action="record">Record</a>
				{/if}
				{#if data.maySupersede}
					<button
						type="button"
						class="btn-ghost page-action"
						data-action="supersede"
						aria-expanded={superseding}
						aria-controls={superseding ? 'supersede-panel' : undefined}
						bind:this={supersedeToggle}
						onclick={toggleSupersede}>Supersede…</button
					>
				{/if}
			</nav>
			{#if superseding}
				<form
					class="supersede-panel glass"
					id="supersede-panel"
					data-panel="supersede"
					onsubmit={(e) => {
						e.preventDefault();
						supersede();
					}}
				>
					<p class="banner-note">
						A new draft copies the content this decision was ruled on, with no participants, and its decider cannot be changed. This decision is marked
						superseded once the draft is ruled on by this decision's decider, the board's Product Owner when it was ruled, or an administrator.
					</p>
					<label class="small" for="supersede-title">Title of the new decision</label>
					<input id="supersede-title" class="field" type="text" maxlength={DECISION_TITLE_MAX} bind:value={supersedeTitle} bind:this={supersedeField} />
					<div class="panel-actions">
						<button type="button" class="btn-ghost page-action" onclick={toggleSupersede}>Cancel</button>
						<button type="submit" class="btn-primary page-action" disabled={supersedeBusy || supersedeTitle.trim() === ''} aria-busy={supersedeBusy ? 'true' : undefined}
							>Make the draft</button
						>
					</div>
					<p class="refused" role="status" data-said="supersede">{supersedeRefused}</p>
				</form>
			{/if}
		{/if}
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
				results={data.released !== null ? releasedResults : undefined}
				concern={data.participant !== null && (data.mayRaiseConcern || data.concerns.length > 0) ? concern : undefined}
				questions={data.questions.length > 0 || data.mayAsk ? questions : undefined}
				linkedCards={(data.linkedCards ?? []).length > 0 || data.mayLinkCards || data.mayUnlinkCards ? linkedCards : undefined}
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
	/* The supersede panel's note; the banner's are `ParticipantBanner`'s (card 2707). */
	.banner-note { margin: 0; font-size: 0.9rem; color: var(--text-secondary); }
	.page-actions { display: flex; flex-wrap: wrap; gap: var(--space-sm); margin-bottom: var(--space-md); }
	.page-action { min-height: 44px; display: inline-flex; align-items: center; text-decoration: none; font-size: 0.95rem; }
	.supersede-panel { display: flex; flex-direction: column; gap: var(--space-xs); padding: var(--space-md); border-radius: var(--radius-md); margin-bottom: var(--space-md); }
	.small { font-size: 0.9rem; color: var(--text-secondary); }
	.field {
		font-size: 16px; font-family: var(--font-family); padding: var(--space-sm); width: 100%; box-sizing: border-box;
		border: 1px solid var(--glass-border); border-radius: var(--radius-sm); background: var(--bg-elevated); color: var(--text-primary);
	}
	.panel-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--space-sm); }
	.refused { margin: 0; font-size: 0.9rem; color: var(--accent-rose); }
</style>
