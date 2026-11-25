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
	 * (card 2679, decision 9), unless that seen already exists
	 * (`seenRecorded`, card 2736), when no watch is armed; a caller who is no participant is given no
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
	 * drawn where there is a card or the caller may link or unlink one. Card
	 * 2687: Mark as waiting / Stop waiting beside each card where
	 * `mayMarkWaiting`, and "Waits on this decision" on a card that waits
	 * while the decision is open or awaiting its ruling.
	 *
	 * Card 2684 (R22): for a participant, their own objections and requests
	 * to talk with the decider's replies, and the forms to raise one
	 * (`FlagForm`), posting to `/api/decisions/[id]/flags`; the section is
	 * drawn where they have raised one or may raise one now.
	 *
	 * Card 2688 (R14): in the same bar, a decision out of draft as a PDF
	 * (`DecisionExport`): the shareable copy, which every viewer may take, and,
	 * where `mayReadRecord`, the private full record.
	 *
	 * Card 2707: the banner and the response section are components shared
	 * with the link page, `ParticipantBanner` (with no personal link) and
	 * `ParticipantResponse` (to this page's route, keyed on the decision), so
	 * the two pages cannot drift. Everything above that only this page has
	 * stays here, never in them.
	 *
	 * Card 3075: on the kit's shell, full width. Beside the decision, from
	 * 1024px, a side column ("About this decision"): its facts
	 * (`DecisionFacts`: closing time, decider, the reader's part and their
	 * response, with a link to the form) and then the actions, the PDFs and
	 * the Supersede form, opened beside its toggle. Beneath 1024px it follows
	 * the decision.
	 */
	import { tick } from 'svelte';
	import type { PageData } from './$types';
	import { goto } from '$app/navigation';
	import { failureMessage } from '$lib/api';
	import PageShell from '$lib/components/ui/PageShell.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import Card from '$lib/components/ui/Card.svelte';
	import CardContent from '$lib/components/ui/CardContent.svelte';
	import ConcernForm from '$lib/components/decision/ConcernForm.svelte';
	import DecisionExport from '$lib/components/decision/DecisionExport.svelte';
	import DecisionFacts from '$lib/components/decision/DecisionFacts.svelte';
	import DecisionView from '$lib/components/decision/DecisionView.svelte';
	import FlagForm from '$lib/components/decision/FlagForm.svelte';
	import LinkedCards from '$lib/components/decision/LinkedCards.svelte';
	import ParticipantBanner from '$lib/components/decision/ParticipantBanner.svelte';
	import ParticipantResponse from '$lib/components/decision/ParticipantResponse.svelte';
	import QuestionForm from '$lib/components/decision/QuestionForm.svelte';
	import QuestionsPanel from '$lib/components/decision/QuestionsPanel.svelte';
	import ReleasedResults from '$lib/components/decision/ReleasedResults.svelte';
	import { DECISION_TITLE_MAX } from '$lib/decision-rules';
	import { watchForSeen } from '$lib/decision-seen';

	let { data }: { data: PageData } = $props();

	/** Opened: the decision is drawn, and its facts head the side column. */
	const opened = $derived(!data.draft && data.version !== null);
	/** Any action the side column offers: the PDFs come with every decision out of draft. */
	const hasActions = $derived(data.mayReadResults || data.maySupersede || data.mayReadRecord || !data.draft);

	// ─── Supersede (card 2679, decision 5) ───────────────────────────────────
	let superseding = $state(false);
	let supersedeTitle = $state('');
	let supersedeBusy = $state(false);
	let supersedeRefused = $state('');
	let supersedeToggle = $state<HTMLButtonElement | HTMLAnchorElement | null>(null);
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
	// Card 2736 (D5): and none once the participant's seen exists, as a post would write nothing.
	const seenVersion = $derived(data.participant === null || data.seenRecorded ? null : (data.version?.number ?? null));
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
		mayObject={data.mayObject}
		mayAskToTalk={data.mayAskToTalk}
		mayRaiseConcern={data.mayRaiseConcern}
		seenRecorded={data.seenRecorded}
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
			<LinkedCards
				decisionId={data.decision.id}
				shownStatus={data.decision.shownStatus}
				cards={data.linkedCards ?? []}
				mayLink={data.mayLinkCards ?? false}
				mayUnlink={data.mayUnlinkCards ?? false}
				mayMarkWaiting={data.mayMarkWaiting ?? false}
			/>
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

{#snippet flagsSection()}
	<!-- Drawn afresh for another decision, so one decision's flags and typed words are never shown on another's. -->
	{#key data.decision.id}
		<FlagForm
			url="/api/decisions/{data.decision.id}/flags"
			flags={data.flags}
			mayObject={data.mayObject}
			mayAskToTalk={data.mayAskToTalk}
			decider={data.decision.deciderName ?? 'the decider'}
			shownStatus={data.decision.shownStatus}
			versionNumber={data.version?.number ?? 0}
		/>
	{/key}
{/snippet}

{#snippet yourResponse()}
	<!-- Drawn afresh for another decision, as well as for another version and by Reload (code review C2). -->
	<ParticipantResponse
		decision={data.decision}
		version={data.version}
		options={data.options}
		surveyQuestions={data.surveyQuestions}
		ownResponse={data.ownResponse}
		earlierResponse={data.earlierResponse}
		mayRespond={data.mayRespond}
		url="/api/decisions/{data.decision.id}/responses"
		drawnFor={data.decision.id}
	/>
{/snippet}

{#snippet crumbs()}
	<nav class="crumb" aria-label="Where this is">
		{#if data.decision.boardName !== null}<span>{data.decision.boardName}</span>{/if}
	</nav>
{/snippet}

{#snippet headerActions()}
	{#if data.mayEdit}
		<Button variant="ghost" size="sm" class="edit-link" href="/decisions/{data.decision.id}/edit">Edit</Button>
	{/if}
{/snippet}

{#snippet side()}
	<div class="rail-stack">
		{#if opened}
			<DecisionFacts
				closesAt={data.decision.closesAt}
				deciderName={data.decision.deciderName}
				participant={data.participant === null ? null : { role: data.participant.role }}
				response={{ mayRespond: data.mayRespond, own: data.ownResponse, earlier: data.earlierResponse }}
				responseHref="#response"
			/>
		{/if}
		{#if hasActions}
			<Card data-rail="actions">
				<CardContent>
					<nav class="page-actions" aria-label="What you can do with this decision">
						{#if data.mayReadResults}
							<Button variant="outline" size="sm" href="/decisions/{data.decision.id}/results" data-action="results">Results and ruling</Button>
						{/if}
						{#if data.mayReadRecord}
							<Button variant="outline" size="sm" href="/decisions/{data.decision.id}/record" data-action="record">Record</Button>
						{/if}
						{#if data.maySupersede}
							<Button
								variant="outline"
								size="sm"
								data-action="supersede"
								aria-expanded={superseding}
								aria-controls={superseding ? 'supersede-panel' : undefined}
								bind:ref={supersedeToggle}
								onclick={toggleSupersede}>Supersede…</Button
							>
						{/if}
						<!-- Card 2688 (R14): the shareable copy out of draft, and the full record where the record may be read. -->
						{#if data.decision.id !== undefined}
							<DecisionExport decisionId={data.decision.id} draft={data.draft} mayReadRecord={data.mayReadRecord ?? false} />
						{/if}
					</nav>
					{#if superseding}
						<form
							class="supersede-panel"
							id="supersede-panel"
							data-panel="supersede"
							onsubmit={(e) => {
								e.preventDefault();
								supersede();
							}}
						>
							<p class="panel-note">
								A new draft copies the content this decision was ruled on, with no participants, and its decider cannot be changed. This decision is marked
								superseded once the draft is ruled on by this decision's decider, the board's Product Owner when it was ruled, or an administrator.
							</p>
							<label class="ui-label" for="supersede-title">Title of the new decision</label>
							<input id="supersede-title" class="ui-input" type="text" maxlength={DECISION_TITLE_MAX} bind:value={supersedeTitle} bind:this={supersedeField} />
							<div class="panel-actions">
								<Button variant="ghost" size="sm" onclick={toggleSupersede}>Cancel</Button>
								<Button type="submit" size="sm" disabled={supersedeBusy || supersedeTitle.trim() === ''} aria-busy={supersedeBusy ? 'true' : undefined}>Make the draft</Button>
							</div>
							<p class="refused" class:said={supersedeRefused !== ''} role="status" data-said="supersede">{supersedeRefused}</p>
						</form>
					{/if}
				</CardContent>
			</Card>
		{/if}
	</div>
{/snippet}

{#snippet body()}
	{#if data.draft || data.version === null}
		<Card class="not-opened">
			<CardContent>
				<h1>{data.decision.title}</h1>
				<p>This decision has not been opened yet.</p>
			</CardContent>
		</Card>
	{:else}
		<DecisionView
			decision={data.decision}
			content={data.version.content}
			options={data.options}
			surveyQuestions={data.surveyQuestions}
			audiences={data.audiences}
			participant={data.participant === null ? null : { role: data.participant.role }}
			mode="participant"
			{banner}
			response={yourResponse}
			results={data.released !== null ? releasedResults : undefined}
			concern={data.participant !== null && (data.mayRaiseConcern || data.concerns.length > 0) ? concern : undefined}
			questions={data.questions.length > 0 || data.mayAsk ? questions : undefined}
			flags={data.participant !== null && (data.flags.length > 0 || data.mayObject || data.mayAskToTalk) ? flagsSection : undefined}
			linkedCards={(data.linkedCards ?? []).length > 0 || data.mayLinkCards || data.mayUnlinkCards ? linkedCards : undefined}
		/>
	{/if}
{/snippet}

<!-- Card 3075: full width, the facts and the actions in a side column on the right from 1024px, after the decision beneath that. -->
{#if opened || hasActions}
	<PageShell width="full" {crumbs} actions={headerActions} rail={side} railLabel="About this decision" railPosition="end">
		{@render body()}
	</PageShell>
{:else}
	<PageShell width="full" {crumbs} actions={headerActions}>
		{@render body()}
	</PageShell>
{/if}

<style>
	.crumb {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.rail-stack {
		display: flex;
		flex-direction: column;
		gap: var(--space-md);
	}
	/* The actions one under another, each the rail's width. */
	.page-actions {
		display: grid;
		gap: var(--space-sm);
	}

	.supersede-panel {
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
		margin-top: var(--space-md);
		padding-top: var(--space-md);
		border-top: 1px solid var(--ui-border);
	}
	/* The supersede form's note; the banner's are `ParticipantBanner`'s (card 2707). */
	.panel-note {
		margin: 0;
		font-size: 0.8125rem;
		line-height: 1.45;
		color: var(--ui-muted-foreground);
	}
	.panel-actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: var(--space-sm);
	}
	.refused {
		margin: 0;
		font-size: 0.8125rem;
		color: var(--ui-foreground);
	}
	/* A refusal: the words in the text colour, marked by the destructive tone. */
	.refused.said {
		padding-left: 0.625rem;
		border-left: 3px solid var(--ui-destructive);
	}

	h1 {
		margin: 0 0 var(--space-sm);
		font-size: 1.625rem;
		font-weight: 600;
		line-height: 1.2;
		letter-spacing: -0.025em;
		overflow-wrap: anywhere;
	}
	p {
		margin: 0;
		color: var(--ui-muted-foreground);
	}
</style>
