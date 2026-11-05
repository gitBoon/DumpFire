<script lang="ts">
	/**
	 * A decision's results and its ruling (card 2679, decisions 1, 2, 10, 15,
	 * 16 and 26), for its decider and DumpFire's administrators alone: the
	 * tally and each response by name (`ResultsView`), the ruling form where
	 * the caller may rule (`RulingForm`), and the release of the results
	 * where they may release them.
	 *
	 * The release shows first exactly what everyone who can see the decision
	 * will be shown, the same projection the server releases drawn by the same
	 * `ReleasedResults` (code review F3), each figure that could single
	 * someone out withheld, and a Leave out box by each comment, described by
	 * that comment (F4).
	 * Its dialog says what a release lets anyone work out
	 * (`RELEASE_INFERENCE`), asks for the caller's password and sends
	 * `{ revision, omit, currentPassword }` as JSON, `omit` the keys of the
	 * comments left out. A refusal of the password stays in the dialog
	 * (`stepUpRefusal`); any other refusal is said in the status region, in
	 * the server's words, and the focus goes back to the control. Card 2734
	 * (D4): a refusal in `STALE_REVISION`'s words reads the page's data again,
	 * the results and their revision together, keeps the Leave out ticks of
	 * the comments still shown, drops any other, and says
	 * `RESULTS_READ_AGAIN`, as the ruling form does (D3).
	 *
	 * What was done is said in a status region that stays drawn, only its
	 * words changing, and takes the focus once the page's data is read again,
	 * as the form that was used may then be gone (DecisionActions' F6). The
	 * page carries noindex, as its answer does, for a copy saved.
	 */
	import { tick } from 'svelte';
	import type { PageData } from './$types';
	import { invalidateAll } from '$app/navigation';
	import { failureMessage } from '$lib/api';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import HeaderMenu from '$lib/components/HeaderMenu.svelte';
	import ThemeMenuItems from '$lib/components/ThemeMenuItems.svelte';
	import ReleasedResults from '$lib/components/decision/ReleasedResults.svelte';
	import ResultsView from '$lib/components/decision/ResultsView.svelte';
	import RulingForm from '$lib/components/decision/RulingForm.svelte';
	import { RELEASE_INFERENCE, RESULTS_READ_AGAIN, shownMoment, STALE_REVISION, STATUS_WORDS } from '$lib/decision-words';
	import type { PreviewComment, ReleasePreview } from '$lib/decision-view-types';
	import { ASKS_FOR_PASSWORD, stepUpRefusal } from '$lib/step-up-words';
	import { theme, themeIcon } from '$lib/stores/theme';

	let { data }: { data: PageData } = $props();

	/** What was done, or the last refusal of the release, said in the status region. */
	let said = $state<{ refused: boolean; words: string } | null>(null);
	let statusRegion = $state<HTMLElement>();
	let releaseButton = $state<HTMLButtonElement>();
	/** The keys of the comments left out of the release. */
	let leftOut = $state<string[]>([]);
	let confirmingRelease = $state(false);

	const preview = $derived(data.releasePreview);
	const releaseMessage = $derived(
		`${RELEASE_INFERENCE}${leftOut.length > 0 ? ` ${leftOut.length === 1 ? '1 comment is' : `${leftOut.length} comments are`} left out.` : ''} ${ASKS_FOR_PASSWORD}`
	);

	/** Something was done: the data read again, then the words said and the focus on them. */
	async function done(words: string) {
		said = { refused: false, words };
		await invalidateAll();
		await tick();
		statusRegion?.focus();
	}

	async function release(typed: string): Promise<string | void> {
		try {
			const res = await fetch(`/api/decisions/${data.decision.id}/release`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ revision: data.revision, omit: leftOut, currentPassword: typed })
			});
			const refusal = await stepUpRefusal(res);
			if (refusal !== null) return refusal;
			confirmingRelease = false;
			if (res.ok) {
				leftOut = [];
				await done('Released: everyone who can see this decision is shown the totals and the comments, without names.');
				return;
			}
			const words = await failureMessage(res, 'The results were not released.');
			if (res.status === 409 && words === STALE_REVISION) {
				// Card 2734 (D4): the results and their revision read again together, the ticks kept for the comments still
				// shown. A tick for a comment no longer shown is dropped (code review 2026-11-05), so the dialog's count is of
				// what is shown and the retry is not refused 400 over a comment the caller can no longer see or untick.
				const readAgain = await invalidateAll().then(
					() => true,
					() => false
				);
				if (readAgain) {
					const shown = new Set(previewKeys(data.releasePreview));
					leftOut = leftOut.filter((key) => shown.has(key));
				}
				said = { refused: true, words: readAgain ? RESULTS_READ_AGAIN : words };
			} else {
				said = { refused: true, words };
			}
		} catch {
			confirmingRelease = false;
			said = { refused: true, words: 'No answer from the server. It is not known whether the results were released.' };
		}
		await tick();
		(releaseButton ?? statusRegion)?.focus();
	}

	async function cancelRelease() {
		confirmingRelease = false;
		await tick();
		releaseButton?.focus();
	}

	/** The key of every comment the preview shows, overall and on each option. */
	function previewKeys(shown: ReleasePreview | null): string[] {
		if (shown === null) return [];
		return [...shown.comments, ...shown.options.flatMap((option) => option.comments)].map((comment) => comment.key);
	}

	function toggle(key: string, out: boolean) {
		leftOut = out ? [...leftOut.filter((kept) => kept !== key), key] : leftOut.filter((kept) => kept !== key);
	}
</script>

<svelte:head>
	<title>Results: {data.decision.title} — DumpFire</title>
	<meta name="robots" content="noindex" />
</svelte:head>

{#snippet leaveOut(comment: PreviewComment)}
	<li class="preview-comment">
		<span class="comment" id="comment-{comment.key}">{comment.text}</span>
		{#if data.mayRelease}
			<!-- Code review F4: each box is described by the comment it leaves out. -->
			<label class="leave-out">
				<input
					type="checkbox"
					checked={leftOut.includes(comment.key)}
					onchange={(e) => toggle(comment.key, e.currentTarget.checked)}
					aria-describedby="comment-{comment.key}"
					data-omit={comment.key}
				/>
				Leave out
			</label>
		{/if}
	</li>
{/snippet}

<div class="decision-page">
	<header class="decision-header glass">
		<div class="decision-header-inner">
			<a href="/" class="header-logo" title="Back to DumpFire">
				<span class="logo-fire">🔥</span>
				<span class="logo-text">DumpFire</span>
			</a>
			<nav class="crumb" aria-label="Where this is">
				<span>{data.decision.boardName}</span><span aria-hidden="true">›</span>
				<a href="/decisions/{data.decision.id}">Back to the decision</a>
			</nav>
			<HeaderMenu label="Theme" triggerClass="btn-ghost" triggerTitle="Change theme">
				{#snippet trigger()}<span aria-hidden="true">{themeIcon($theme)}</span>{/snippet}
				<ThemeMenuItems heading={false} />
			</HeaderMenu>
		</div>
	</header>

	<main class="decision-content">
		<h1>Results: {data.decision.title}</h1>
		<p class="facts">
			{STATUS_WORDS[data.decision.shownStatus] ?? data.decision.shownStatus}.
			{data.decision.closesAt === null ? 'No closing time.' : `Closes ${shownMoment(data.decision.closesAt, '')}.`}
			Only {data.decision.deciderName ?? 'the decider'}, who decides, and DumpFire's administrators see this page.
		</p>

		<ResultsView results={data} />

		{#if data.mayRule}
			<section class="panel glass" aria-label="Rule">
				<h2>Rule</h2>
				<RulingForm
					decisionId={data.decision.id}
					title={data.decision.title}
					revision={data.revision}
					options={data.options}
					mostChosen={data.mostChosen}
					voted={data.current.voted}
					early={data.rulesEarly}
					closedEarly={data.rulesEarly && data.decision.shownStatus !== 'open'}
					cutOff={data.notResponded.map((person) => ({ name: person.name, reached: person.reached }))}
					openQuestions={data.openQuestions.length}
					onRuled={done}
				/>
			</section>
		{/if}

		{#if data.released !== null}
			<p class="released" data-note="released">
				The results were released on {shownMoment(data.released.at, '')} by {data.released.byName}{data.released.omitted > 0
					? `, with ${data.released.omitted} ${data.released.omitted === 1 ? 'comment' : 'comments'} left out`
					: ''}.
			</p>
		{:else if preview !== null}
			<section class="panel glass" aria-label="Release the results" data-block="release">
				<h2>Release the results</h2>
				<!-- The same component every viewer is shown it by, so that the preview cannot differ from the release (code review F3). -->
				<ReleasedResults
					released={preview}
					name="preview"
					note="Everyone who can see this decision would be shown exactly this: the totals and the comments, without names. Figures that could single someone out are withheld."
					comment={leaveOut}
				/>
				{#if data.mayRelease}
					<div class="actions">
						<button type="button" class="btn btn-primary btn-sm" data-action="release" bind:this={releaseButton} onclick={() => ((said = null), (confirmingRelease = true))}>
							Release results…
						</button>
					</div>
				{:else if data.releaseRefusal !== null}
					<p class="note" data-note="release-refusal">{data.releaseRefusal}</p>
				{/if}
			</section>
		{/if}

		<!-- Drawn from the start, so a screen reader hears each change of its words; a refusal is an alert of its own. -->
		<p class="done" role="status" data-said="done" tabindex="-1" bind:this={statusRegion}>{said !== null && !said.refused ? said.words : ''}</p>
		{#if said?.refused}
			<p class="refused" role="alert" data-said="refused">{said.words}</p>
		{/if}
	</main>
</div>

{#if confirmingRelease}
	<ConfirmModal title="Release the results?" message={releaseMessage} confirmText="Release" askPassword onConfirm={release} onCancel={cancelRelease} />
{/if}

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
	.crumb { flex: 1; display: flex; align-items: center; gap: var(--space-sm); font-size: 0.85rem; min-width: 0; color: var(--text-secondary); }
	.crumb a { color: var(--text-secondary); text-decoration: none; }
	.crumb a:hover { color: var(--accent-indigo); }

	/* One column, phone first; its last line stops above the user badge (card 2239). */
	.decision-content {
		max-width: 52rem; margin: 0 auto; padding: var(--space-xl) var(--space-md) var(--user-badge-space);
		display: flex; flex-direction: column; gap: var(--space-md); min-width: 0;
	}
	.decision-content h1 { font-size: 1.3rem; margin: 0; overflow-wrap: anywhere; }
	.facts { margin: 0; font-size: 0.85rem; color: var(--text-secondary); }
	.panel { padding: var(--space-md); border-radius: var(--radius-lg); display: flex; flex-direction: column; gap: var(--space-sm); min-width: 0; }
	.panel h2 { font-size: 1rem; margin: 0; }
	.note { margin: 0; font-size: 0.82rem; color: var(--text-secondary); }
	.released { margin: 0; font-size: 0.88rem; }
	.preview-comment { display: flex; flex-wrap: wrap; gap: var(--space-sm); justify-content: space-between; }
	.comment { white-space: pre-wrap; overflow-wrap: anywhere; min-width: 0; }
	.leave-out { display: flex; gap: var(--space-xs); align-items: center; font-size: 0.78rem; color: var(--text-secondary); }
	.actions { display: flex; justify-content: flex-end; }
	.done { font-size: 0.85rem; color: var(--accent-emerald, var(--text-secondary)); margin: 0; }
	.refused { font-size: 0.85rem; color: var(--accent-rose); margin: 0; }
	@media (max-width: 640px) {
		.decision-header-inner { padding: 0 var(--space-md); }
		.logo-text { display: none; }
	}
</style>
