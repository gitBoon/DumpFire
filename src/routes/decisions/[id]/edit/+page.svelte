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
	 */
	import { untrack } from 'svelte';
	import type { PageData } from './$types';
	import { invalidateAll } from '$app/navigation';
	import HeaderMenu from '$lib/components/HeaderMenu.svelte';
	import ThemeMenuItems from '$lib/components/ThemeMenuItems.svelte';
	import Toast from '$lib/components/Toast.svelte';
	import DecisionEditor from '$lib/components/decision/DecisionEditor.svelte';
	import ParticipantPicker from '$lib/components/decision/ParticipantPicker.svelte';
	import DeliveryPanel from '$lib/components/decision/DeliveryPanel.svelte';
	import DecisionActions from '$lib/components/decision/DecisionActions.svelte';
	import { theme, themeIcon } from '$lib/stores/theme';

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

<div class="decision-page">
	<header class="decision-header glass">
		<div class="decision-header-inner">
			<a href="/" class="header-logo" title="Back to DumpFire">
				<span class="logo-fire">🔥</span>
				<span class="logo-text">DumpFire</span>
			</a>
			<nav class="crumb" aria-label="Where this is">
				{#if data.decision.boardId !== null}
					<a href="/board/{data.decision.boardId}">{data.decision.boardName}</a>
					<span aria-hidden="true">›</span>
					<a href="/board/{data.decision.boardId}/decisions">Decisions</a>
				{:else}
					<span>{data.decision.boardName}</span>
				{/if}
			</nav>
			<HeaderMenu label="Theme" triggerClass="btn-ghost" triggerTitle="Change theme">
				{#snippet trigger()}<span aria-hidden="true">{themeIcon($theme)}</span>{/snippet}
				<ThemeMenuItems heading={false} />
			</HeaderMenu>
		</div>
	</header>

	<main class="decision-content">
		<DecisionActions
			decisionId={data.decision.id}
			boardId={data.decision.boardId}
			title={data.decision.title}
			closesAt={data.decision.closesAt}
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
	</main>
</div>

<Toast />

<style>
	.decision-page { min-height: 100vh; padding-top: 64px; }
	.decision-header {
		position: fixed; top: 0; left: 0; right: 0; z-index: 200;
		height: 64px; border-bottom: 1px solid var(--glass-border);
		backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
	}
	.decision-header-inner {
		max-width: 1400px; margin: 0 auto; height: 100%;
		display: flex; align-items: center; gap: var(--space-lg);
		padding: 0 var(--space-xl);
	}
	.header-logo {
		display: flex; align-items: center; gap: var(--space-sm);
		text-decoration: none; color: var(--text-primary);
		font-weight: 700; font-size: 1.1rem;
	}
	.logo-fire { font-size: 1.4rem; }
	.crumb { flex: 1; display: flex; align-items: center; gap: var(--space-sm); font-size: 0.85rem; min-width: 0; }
	.crumb a { color: var(--text-secondary); text-decoration: none; }
	.crumb a:hover { color: var(--accent-indigo); }

	/* The page's last line stops above the user badge (card 2239). */
	.decision-content { max-width: 1400px; margin: 0 auto; padding: var(--space-xl) var(--space-xl) var(--user-badge-space); }
	@media (max-width: 640px) {
		.decision-header-inner { padding: 0 var(--space-md); }
		.logo-text { display: none; }
		.decision-content { padding: var(--space-md) var(--space-md) var(--user-badge-space); }
	}
	.decision-page :global(.btn-sm) { font-size: 0.78rem !important; padding: var(--space-xs) var(--space-md) !important; }
	.decision-page :global(.btn-xs) { font-size: 0.7rem !important; padding: 2px var(--space-sm) !important; }
</style>
