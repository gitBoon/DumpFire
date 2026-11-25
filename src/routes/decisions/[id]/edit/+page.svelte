<script lang="ts">
	/**
	 * A decision's editor (card 2676, plan 4.2): the board's crumb, then the
	 * working copy in `DecisionEditor`, with the participant picker and the
	 * readability check in its side column, and, once the decision has been
	 * opened, its delivery to those the server hands it (card 2697, Q13).
	 * Above the editor, its lifecycle controls (`DecisionActions`, Q14), which
	 * hold Open, Re-publish and the dry run off while the editor reports edits
	 * not yet saved, and link to the results and ruling for the decider and
	 * administrators (card 2679, decision 15).
	 *
	 * The page holds the revision every write sends (decision 10): each
	 * write's answer gives the next, and the page's data is read again after
	 * it (decision 23). Reload, offered after a 409, reads the decision again
	 * and draws it afresh, the edits not yet saved given up.
	 *
	 * Card 2683: the editor is handed the survey question rows too, which say
	 * which questions a version has published (their kind is fixed, R8).
	 */
	import { untrack } from 'svelte';
	import type { PageData } from './$types';
	import { invalidateAll } from '$app/navigation';
	import Toast from '$lib/components/Toast.svelte';
	import PageShell from '$lib/components/ui/PageShell.svelte';
	import DecisionEditor from '$lib/components/decision/DecisionEditor.svelte';
	import ParticipantPicker from '$lib/components/decision/ParticipantPicker.svelte';
	import DeliveryPanel from '$lib/components/decision/DeliveryPanel.svelte';
	import DecisionActions from '$lib/components/decision/DecisionActions.svelte';

	let { data }: { data: PageData } = $props();

	let revision = $state(untrack(() => data.revision));
	/** Moved on by Reload, which draws the editor afresh from the data read again. */
	let drawing = $state(0);
	/** Whether the editor holds edits not yet saved: Open, Re-publish and the dry run wait for a save (card 2697, Q14). */
	let dirty = $state(false);

	async function saved(next: string) {
		revision = next;
		await invalidateAll();
	}

	async function reload() {
		await invalidateAll();
		revision = data.revision;
		drawing += 1;
	}
</script>

<svelte:head>
	<title>{data.decision.title} — DumpFire</title>
</svelte:head>

{#snippet crumbs()}
	<nav class="crumb" aria-label="Where this is">
		{#if data.decision.boardId !== null}
			<a href="/board/{data.decision.boardId}">{data.decision.boardName}</a>
			<span aria-hidden="true">›</span>
			<a href="/board/{data.decision.boardId}/decisions">Decisions</a>
		{:else}
			<span>{data.decision.boardName}</span>
		{/if}
	</nav>
{/snippet}

<!-- Card 3075: full width; the editor draws its own side column. -->
<PageShell width="full" {crumbs}>
	<div class="editor-page">
		<DecisionActions
			decisionId={data.decision.id}
			boardId={data.decision.boardId}
			title={data.decision.title}
			closesAt={data.decision.closesAt}
			shownStatus={data.decision.shownStatus}
			{revision}
			actions={data.actions}
			republishSummary={data.republishSummary}
			refusals={data.readiness.refusals}
			warnings={data.readiness.warnings}
			mailCount={data.participants.filter((participant) => participant.removedAt === null).length}
			{dirty}
			mayReadResults={data.mayReadResults}
			mayReadRecord={data.mayReadRecord}
			onSaved={saved}
		/>
		{#key drawing}
			<DecisionEditor
				decision={data.decision}
				options={data.options}
				surveyQuestions={data.surveyQuestions}
				participants={data.participants}
				groups={data.groups}
				{revision}
				readiness={data.readiness}
				editable={data.editable}
				canSetDecider={data.canSetDecider}
				canReview={data.canReview}
				productOwnerUserId={data.productOwnerUserId}
				deciderCandidates={data.deciderCandidates}
				callerId={data.user?.id ?? 0}
				onSaved={saved}
				onReload={reload}
				onDirtyChange={(now) => (dirty = now)}
			>
				{#snippet side()}
					<ParticipantPicker
						decisionId={data.decision.id}
						status={data.decision.status}
						shownStatus={data.decision.shownStatus}
						editable={data.editable}
						participants={data.participants}
						people={data.people}
						groups={data.groups}
						{revision}
						canSave={data.canSetParticipants}
						onSaved={saved}
						onReload={reload}
					/>
					{#if data.delivery !== null}
						<DeliveryPanel
							decisionId={data.decision.id}
							participants={data.participants}
							delivery={data.delivery}
							directory={data.directory}
							onSaved={saved}
						/>
					{/if}
				{/snippet}
			</DecisionEditor>
		{/key}
	</div>
</PageShell>

<Toast />

<style>
	.crumb {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
	}
	.crumb a {
		border-radius: var(--ui-radius-sm);
		color: var(--ui-muted-foreground);
		text-decoration: none;
	}
	.crumb a:hover {
		color: var(--ui-foreground);
	}
	.crumb a:focus-visible {
		outline: 2px solid var(--ui-ring);
		outline-offset: 2px;
	}
	.editor-page {
		display: flex;
		flex-direction: column;
		gap: var(--space-lg);
		min-width: 0;
	}
</style>
