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
	 * `{ revision, omit, currentPassword, currentCode }` as JSON (card 2770), `omit` the keys of the
	 * comments left out. A refusal of the password stays in the dialog
	 * (`stepUpRefusal`); any other refusal is said in the status region, in
	 * the server's words, and the focus goes back to the control. Card 2734
	 * (D4): a refusal in `STALE_REVISION`'s words reads the page's data again,
	 * the results and their revision together, keeps the Leave out ticks of
	 * the comments still shown, drops any other, and says
	 * `RESULTS_READ_AGAIN`, as the ruling form does (D3).
	 *
	 * Card 2684 (R23): every objection and request to talk, with names, in
	 * `FlagReplies` under the results, with a reply box for the decider; the
	 * ruling form holds Rule off while an objection has no answer, linking to
	 * them, and asks the decider to confirm ruling with a request to talk still
	 * without an outcome.
	 *
	 * What was done is said in a status region that stays drawn, only its
	 * words changing, and takes the focus once the page's data is read again,
	 * as the form that was used may then be gone (DecisionActions' F6). The
	 * page carries noindex, as its answer does, for a copy saved.
	 *
	 * Card 3075: on the kit's shell, full width with no side column; the
	 * flags, the ruling and the release each in a card, Release results… the
	 * kit's small button.
	 */
	import { tick } from 'svelte';
	import type { PageData } from './$types';
	import { invalidateAll } from '$app/navigation';
	import { failureMessage } from '$lib/api';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import FlagReplies from '$lib/components/decision/FlagReplies.svelte';
	import ReleasedResults from '$lib/components/decision/ReleasedResults.svelte';
	import ResultsView from '$lib/components/decision/ResultsView.svelte';
	import RulingForm from '$lib/components/decision/RulingForm.svelte';
	import PageShell from '$lib/components/ui/PageShell.svelte';
	import PageHeader from '$lib/components/ui/PageHeader.svelte';
	import Badge from '$lib/components/ui/Badge.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import Card from '$lib/components/ui/Card.svelte';
	import CardHeader from '$lib/components/ui/CardHeader.svelte';
	import CardTitle from '$lib/components/ui/CardTitle.svelte';
	import CardContent from '$lib/components/ui/CardContent.svelte';
	import { RELEASE_INFERENCE, RESULTS_READ_AGAIN, shownMoment, STALE_REVISION } from '$lib/decision-words';
	import type { PreviewComment, ReleasePreview } from '$lib/decision-view-types';
	import { asksForPassword, stepUpRefusal, type StepUpProof } from '$lib/step-up-words';

	let { data }: { data: PageData } = $props();

	/** What was done, or the last refusal of the release, said in the status region. */
	let said = $state<{ refused: boolean; words: string } | null>(null);
	let statusRegion = $state<HTMLElement>();
	let releaseButton = $state<HTMLButtonElement | HTMLAnchorElement | null>(null);
	/** The keys of the comments left out of the release. */
	let leftOut = $state<string[]>([]);
	let confirmingRelease = $state(false);

	const preview = $derived(data.releasePreview);
	/** Card 2684 (R23): on the page alone, so absent from any other source's answer. */
	const flags = $derived(data.flags ?? []);
	const releaseMessage = $derived(
		`${RELEASE_INFERENCE}${leftOut.length > 0 ? ` ${leftOut.length === 1 ? '1 comment is' : `${leftOut.length} comments are`} left out.` : ''} ${asksForPassword(data.codeAsked)}`
	);

	/** Something was done: the data read again, then the words said and the focus on them. */
	async function done(words: string) {
		said = { refused: false, words };
		await invalidateAll();
		await tick();
		statusRegion?.focus();
	}

	async function release(proof: StepUpProof): Promise<string | void> {
		try {
			const res = await fetch(`/api/decisions/${data.decision.id}/release`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ revision: data.revision, omit: leftOut, currentPassword: proof.currentPassword, currentCode: proof.currentCode })
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

{#snippet crumbs()}
	<nav class="crumb" aria-label="Where this is">
		<span>{data.decision.boardName}</span><span aria-hidden="true">›</span>
		<a href="/decisions/{data.decision.id}">Back to the decision</a>
	</nav>
{/snippet}

<!-- Card 3075: full width, no side column; its tables want the width. -->
<PageShell width="full" {crumbs}>
	<div class="results-page">
		<PageHeader title="Results: {data.decision.title}">
			<p class="facts">
				<Badge status={data.decision.shownStatus} />
				<span>{data.decision.closesAt === null ? 'No closing time.' : `Closes ${shownMoment(data.decision.closesAt, '')}.`}</span>
				<span>Only {data.decision.deciderName ?? 'the decider'}, who decides, and DumpFire's administrators see this page.</span>
			</p>
		</PageHeader>

		<ResultsView results={data} />

		{#if flags.length > 0}
			<!-- `flags` is where the ruling form's note links (R23). -->
			<Card as="section" id="flags" aria-labelledby="flags-heading" data-block="flags">
				<CardHeader><CardTitle level={2} id="flags-heading">Objections and requests to talk</CardTitle></CardHeader>
				<CardContent>
					<FlagReplies decisionId={data.decision.id} {flags} mayReply={data.mayReply} shownStatus={data.decision.shownStatus} />
				</CardContent>
			</Card>
		{/if}

		{#if data.mayRule}
			<Card as="section" aria-label="Rule">
				<CardHeader><CardTitle level={2}>Rule</CardTitle></CardHeader>
				<CardContent>
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
						unansweredObjections={flags.filter((flag) => flag.kind === 'objection' && flag.reply === null).length}
						openTalks={flags.filter((flag) => flag.kind === 'talk' && flag.reply === null).length}
						flagsHref="#flags"
						onRuled={done}
					/>
				</CardContent>
			</Card>
		{/if}

		{#if data.released !== null}
			<p class="released" data-note="released">
				The results were released on {shownMoment(data.released.at, '')} by {data.released.byName}{data.released.omitted > 0
					? `, with ${data.released.omitted} ${data.released.omitted === 1 ? 'comment' : 'comments'} left out`
					: ''}.
			</p>
		{:else if preview !== null}
			<Card as="section" aria-label="Release the results" data-block="release">
				<CardHeader><CardTitle level={2}>Release the results</CardTitle></CardHeader>
				<CardContent>
					<!-- The same component every viewer is shown it by, so that the preview cannot differ from the release (code review F3). -->
					<ReleasedResults
						released={preview}
						name="preview"
						note="Everyone who can see this decision would be shown exactly this: the totals and the comments, without names. Figures that could single someone out are withheld."
						comment={leaveOut}
					/>
					{#if data.mayRelease}
						<div class="actions">
							<Button size="sm" data-action="release" bind:ref={releaseButton} onclick={() => ((said = null), (confirmingRelease = true))}>Release results…</Button>
						</div>
					{:else if data.releaseRefusal !== null}
						<p class="note" data-note="release-refusal">{data.releaseRefusal}</p>
					{/if}
				</CardContent>
			</Card>
		{:else if data.ruling?.noOptions && data.releaseRefusal !== null}
			<!-- Card 2683 (R11): a ruled survey has no preview, as nothing of it can be released; why is said. -->
			<p class="note" data-note="release-refusal">{data.releaseRefusal}</p>
		{/if}

		<!-- Drawn from the start, so a screen reader hears each change of its words; a refusal is an alert of its own. -->
		<p class="done" role="status" data-said="done" tabindex="-1" bind:this={statusRegion}>{said !== null && !said.refused ? said.words : ''}</p>
		{#if said?.refused}
			<p class="refused" role="alert" data-said="refused">{said.words}</p>
		{/if}
	</div>
</PageShell>

{#if confirmingRelease}
	<ConfirmModal title="Release the results?" message={releaseMessage} confirmText="Release" askPassword onConfirm={release} onCancel={cancelRelease} />
{/if}

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

	.results-page {
		display: flex;
		flex-direction: column;
		gap: var(--space-lg);
		min-width: 0;
	}
	.facts {
		margin: calc(-1 * var(--space-sm)) 0 0;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-xs) var(--space-md);
		font-size: 0.875rem;
		color: var(--ui-muted-foreground);
	}
	.note {
		margin: var(--space-sm) 0 0;
		font-size: 0.8125rem;
		color: var(--ui-muted-foreground);
	}
	.released {
		margin: 0;
		font-size: 0.875rem;
	}
	.preview-comment {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-sm);
		justify-content: space-between;
	}
	.comment {
		min-width: 0;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.leave-out {
		display: flex;
		gap: var(--space-xs);
		align-items: center;
		font-size: 0.8125rem;
		color: var(--ui-muted-foreground);
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		margin-top: var(--space-md);
	}
	.done {
		margin: 0;
		font-size: 0.875rem;
		color: var(--ui-foreground);
	}
	.done:focus-visible {
		outline: 2px solid var(--ui-ring);
		outline-offset: 2px;
	}
	/* A refusal: the words in the text colour, marked by the destructive tone. */
	.refused {
		margin: 0;
		padding-left: 0.625rem;
		border-left: 3px solid var(--ui-destructive);
		font-size: 0.875rem;
		color: var(--ui-foreground);
	}
</style>
