<!--
  RulingForm.svelte — the decider's ruling, on the results page (card 2679,
  decisions 2, 11 to 13 and 15).

  - The options, and "None of these", are radios in a fieldset with a legend.
    Where there were votes and the choice is not among the most chosen, a
    warning says the ruling goes against the responses, named by each radio's
    `aria-describedby` (F5).
  - The reason is required and the conditions are not; each is a labelled
    textarea of at most 4,000 characters with its count.
  - Ruling while the decision is shown open, or once it was closed for input
    before its closing time (card 2727), is early: the people who have not
    responded, and are cut off by it, are named before confirming; one the
    round's request never reached is marked so, and the dialog counts them
    (card 2738).
  - With questions still open, Rule is off until the box saying so is ticked.
  - Rule… opens a dialog that asks for the caller's password and sends
    `{ optionId, reason, conditions, revision, openQuestionsConfirmed,
    openTalksConfirmed, currentPassword, currentCode }` as JSON (card 2770). A refusal of the password stays in the dialog
    (`stepUpRefusal`); any other refusal closes it and is said in the status
    region, in the server's words, and the focus goes back to Rule. A ruling
    taken is handed up (`onRuled`), whose page says it in its own region, as
    the form is then no longer drawn.
  - Card 2734 (D3): a refusal in `STALE_REVISION`'s words reads the page
    again (`invalidateAll`), which hands the form the results and their
    revision afresh, together, and `RESULTS_READ_AGAIN` is said. The choice,
    the reason and the conditions are kept; the open-questions box is
    unticked, as the questions may have changed, and a choice no longer among
    the options holds Rule off. The focus goes to those words, as Rule may be
    off.
  - Card 2683 (R18): a decision whose version puts no options to a vote (a
    survey) offers no option and no "None of these": it says
    `NO_OPTIONS_PUT`, and the ruling, with no option, records the decider's
    conclusion in its reason.
  - Card 2684 (R8, R23): while an objection has no answer, Rule is off and a
    note says how many, in the server's own words
    (`objectionsUnansweredWords`), with a link to the page's objections and
    requests to talk (`flagsHref`); no box gets past it. With requests to talk
    still without an outcome, a second box beside the open questions' must be
    ticked, and its tick is sent as `openTalksConfirmed`; on a stale revision
    it is unticked with the other. Any refusal of the ruling for them is said
    in the status region in the server's words, as every other. Each box is
    unticked whenever the number it speaks of changes (code review C-E-L6).
  - Card 3087: on the UI kit. Each option is a row to press, its native radio
    kept and drawn with the kit's tokens; the row chosen has an edge in the
    ring's colour, a faint primary tint, its radio filled and a tick at its
    end, so not by colour alone. The fields and their counts are
    `ui-field.css`'s. The warnings (against the responses, an early ruling,
    objections unanswered) are the kit's warning `Alert`, the boxes for open
    questions and requests to talk inside one, and a survey's no options an
    info `Alert`, all in the same words.
-->
<script lang="ts">
	import { tick } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { failureMessage } from '$lib/api';
	import Alert from '$lib/components/ui/Alert.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import { againstOf, DECISION_TEXT_MAX } from '$lib/decision-rules';
	import { NOT_REACHED_WORDS, NO_OPTIONS_PUT, objectionsUnansweredWords, RESULTS_READ_AGAIN, STALE_REVISION, talksConfirmWords } from '$lib/decision-words';
	import { codeAskedHere } from '$lib/code-asked';
	import { asksForPassword, stepUpRefusal, type StepUpProof } from '$lib/step-up-words';

	let {
		decisionId,
		title,
		revision,
		options,
		mostChosen,
		voted,
		early,
		closedEarly = false,
		cutOff,
		openQuestions,
		unansweredObjections = 0,
		openTalks = 0,
		flagsHref = '#flags',
		onRuled
	}: {
		decisionId: number;
		title: string;
		/** The results revision the page was given (decision 8). */
		revision: string;
		/** The current version's live options. */
		options: { optionId: number; label: string; title: string }[];
		/** The option or options most chosen in the current round. */
		mostChosen: number[];
		/** How many voted in the current round. */
		voted: number;
		/** Whether ruling now is early: the decision is shown open, or was closed before its closing time. */
		early: boolean;
		/** Card 2727: it is early because the decision was closed for input before its closing time, not because it is open. */
		closedEarly?: boolean;
		/** Who an early ruling cuts off: the live consulted participants who have not responded, each with whether the round's request reached them (card 2738). */
		cutOff: { name: string; reached: boolean }[];
		/** How many questions are still open. */
		openQuestions: number;
		/** Card 2684 (R8): how many objections have no answer; while any has none, Rule is off. */
		unansweredObjections?: number;
		/** Card 2684 (R8): how many requests to talk have no outcome recorded. */
		openTalks?: number;
		/** Card 2684 (R23): where the page lists the objections and requests to talk. */
		flagsHref?: string;
		/** A ruling was taken: the words to say. */
		onRuled: (words: string) => void | Promise<void>;
	} = $props();

	const TEXT_MAX = DECISION_TEXT_MAX;
	const NONE = 'none';
	const id = $props.id();
	const warningId = `${id}-against`;

	/** The radio chosen: an option's id, `NONE`, or nothing yet. */
	let choice = $state('');
	let reason = $state('');
	let conditions = $state('');
	/**
	 * The decider rules with the questions still open. Unticked whenever how many are open changes (code review C-E-L6):
	 * the tick was given for the number shown, not for one that came after it.
	 */
	let confirmedOpen = $derived.by(() => {
		void openQuestions;
		return false;
	});
	/** Card 2684 (R8): the decider rules with the requests to talk still open; unticked whenever how many changes, as above. */
	let confirmedTalks = $derived.by(() => {
		void openTalks;
		return false;
	});
	let confirming = $state(false);
	/** The last refusal, said in the status region. */
	let refused = $state('');

	let ruleButton = $state<HTMLButtonElement | HTMLAnchorElement | null>(null);
	let saidRegion = $state<HTMLElement>();

	/** Card 2683 (R18): no option was put to a vote, so the ruling is on none, with nothing to choose. */
	const noOptions = $derived(options.length === 0);
	const chosen = $derived(noOptions ? NONE : choice);
	const optionId = $derived(chosen === '' || chosen === NONE ? null : Number(chosen));
	/** Decision 11: the rule `ruleDecision` records, shared (code review F8): against when there were votes and the choice is not among the most chosen. */
	/** Card 2734 (D3): a choice is only one still offered, as the options may change when the page is read again. */
	const offered = $derived(chosen === NONE || options.some((option) => String(option.optionId) === chosen));
	const against = $derived(offered && againstOf(optionId, voted, mostChosen));
	const ready = $derived(
		offered && reason.trim() !== '' && (openQuestions === 0 || confirmedOpen) && unansweredObjections === 0 && (openTalks === 0 || confirmedTalks)
	);
	const chosenWords = $derived.by(() => {
		if (noOptions) return 'no option, as none were put to a vote';
		if (optionId === null) return 'None of these';
		const option = options.find((candidate) => candidate.optionId === optionId);
		return option === undefined ? '' : `Option ${option.label}${option.title ? `: ${option.title}` : ''}`;
	});
	/** Card 2738: how many of those cut off the round's request never reached. */
	const notReached = $derived(cutOff.filter((person) => !person.reached).length);
	const message = $derived(
		`"${title}" is ruled for good on ${chosenWords}, and every participant is mailed the ruling and your reason.` +
			(early && cutOff.length > 0
				? ` ${cutOff.length} who have not responded are cut off${notReached > 0 ? `, ${notReached} of them ${NOT_REACHED_WORDS}` : ''}.`
				: '') +
			` ${asksForPassword(codeAskedHere())}`
	);

	/** Rule…: the dialog, once the form is complete. */
	function ask(event: SubmitEvent) {
		event.preventDefault();
		if (!ready) return;
		refused = '';
		confirming = true;
	}

	async function rule(proof: StepUpProof): Promise<string | void> {
		try {
			const res = await fetch(`/api/decisions/${decisionId}/rule`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					optionId,
					reason,
					conditions,
					revision,
					openQuestionsConfirmed: confirmedOpen,
					openTalksConfirmed: confirmedTalks,
					currentPassword: proof.currentPassword,
					currentCode: proof.currentCode
				})
			});
			const refusal = await stepUpRefusal(res);
			if (refusal !== null) return refusal;
			confirming = false;
			if (res.ok) {
				refused = '';
				await onRuled('Ruled: every participant is being mailed the ruling.');
				return;
			}
			const words = await failureMessage(res, 'The decision was not ruled on.');
			if (res.status === 409 && words === STALE_REVISION) {
				// Card 2734 (D3): the results and their revision read again together; what was typed is kept, the box is not.
				// The ruling was refused for certain, so a page that could not be read again says the server's words to reload it.
				confirmedOpen = false;
				confirmedTalks = false;
				const readAgain = await invalidateAll().then(
					() => true,
					() => false
				);
				refused = readAgain ? RESULTS_READ_AGAIN : words;
				// Rule may now be off (the box unticked), so the focus goes to the words, which say to read the results first.
				await tick();
				saidRegion?.focus();
				return;
			}
			refused = words;
		} catch {
			confirming = false;
			refused = 'No answer from the server. It is not known whether the decision was ruled on.';
		}
		await tick();
		ruleButton?.focus();
	}

	async function cancel() {
		confirming = false;
		await tick();
		ruleButton?.focus();
	}
</script>

<form class="ruling-form" data-form="ruling" onsubmit={ask}>
	{#if noOptions}
		<Alert variant="info" data-note="no-options">{NO_OPTIONS_PUT}: the ruling chooses none, and your reason records what you concluded.</Alert>
	{:else}
		<fieldset class="choices">
			<legend class="ui-label">The ruling</legend>
			{#each options as option (option.optionId)}
				<label class="choice">
					<input type="radio" name="ruling-{id}" value={String(option.optionId)} bind:group={choice} aria-describedby={against ? warningId : undefined} />
					<span class="choice-words">Option {option.label}{option.title ? `: ${option.title}` : ''}</span>
					{@render chosenTick()}
				</label>
			{/each}
			<label class="choice">
				<input type="radio" name="ruling-{id}" value={NONE} bind:group={choice} aria-describedby={against ? warningId : undefined} />
				<span class="choice-words">None of these</span>
				{@render chosenTick()}
			</label>
		</fieldset>
	{/if}
	{#if against}
		<Alert variant="warning" id={warningId} data-note="against">This goes against the responses: it is not the most chosen option. Only you and DumpFire's administrators are shown this.</Alert>
	{/if}

	<div class="field">
		<label class="ui-label" for="{id}-reason">Why (required; every participant is told)</label>
		<textarea id="{id}-reason" class="ui-textarea" rows="4" maxlength={TEXT_MAX} required aria-describedby="{id}-reason-count" bind:value={reason}></textarea>
		<p class="ui-hint count" id="{id}-reason-count">{reason.length} of {TEXT_MAX.toLocaleString('en-GB')} characters</p>
	</div>

	<div class="field">
		<label class="ui-label" for="{id}-conditions">Conditions (optional)</label>
		<textarea id="{id}-conditions" class="ui-textarea" rows="3" maxlength={TEXT_MAX} aria-describedby="{id}-conditions-count" bind:value={conditions}></textarea>
		<p class="ui-hint count" id="{id}-conditions-count">{conditions.length} of {TEXT_MAX.toLocaleString('en-GB')} characters</p>
	</div>

	{#if early}
		<Alert variant="warning" data-note="early">
			<p>{closedEarly ? 'The decision was closed before its closing time' : 'The decision is still open'}: ruling now is early{cutOff.length > 0 ? ', and cuts off these people who have not responded:' : '.'}</p>
			{#if cutOff.length > 0}
				<ul class="cut-off">
					{#each cutOff as person, index (index)}
						<li>{person.name}{#if !person.reached}{' '}<span class="not-reached" data-note="not-reached">({NOT_REACHED_WORDS})</span>{/if}</li>
					{/each}
				</ul>
			{/if}
		</Alert>
	{/if}

	{#if openQuestions > 0 || openTalks > 0}
		<Alert variant="warning">
			<div class="confirms">
				{#if openQuestions > 0}
					<label class="confirm-open">
						<input type="checkbox" bind:checked={confirmedOpen} data-check="open-questions" />
						<span>{openQuestions === 1 ? '1 question is' : `${openQuestions} questions are`} still open: I rule with {openQuestions === 1 ? 'it' : 'them'} open</span>
					</label>
				{/if}
				{#if openTalks > 0}
					<label class="confirm-open">
						<input type="checkbox" bind:checked={confirmedTalks} data-check="open-talks" />
						<span>{talksConfirmWords(openTalks)}</span>
					</label>
				{/if}
			</div>
		</Alert>
	{/if}

	{#if unansweredObjections > 0}
		<!-- No box gets past it (R8): an objection is answered before the ruling, though the answer need not agree. -->
		<Alert variant="warning" data-note="objections">{objectionsUnansweredWords(unansweredObjections)}. <a href={flagsHref} data-action="answer-objections">Go to the objections</a></Alert>
	{/if}

	<div class="actions">
		<Button type="submit" size="sm" data-action="rule" disabled={!ready} bind:ref={ruleButton}>Rule…</Button>
	</div>
	<p class="refused" role="status" data-said="ruling" tabindex="-1" bind:this={saidRegion}>{refused}</p>
</form>

{#snippet chosenTick()}
	<!-- Card 3087: the row chosen is marked by a tick as well as its tint, so not by colour alone. -->
	<svg class="choice-tick" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
		><path d="M3.5 8.5l3 3 6-7" /></svg
	>
{/snippet}

{#if confirming}
	<ConfirmModal kit title="Rule on this decision?" {message} confirmText="Rule" askPassword onConfirm={rule} onCancel={cancel} />
{/if}

<style>
	.ruling-form {
		display: flex;
		flex-direction: column;
		gap: var(--space-md);
		color: var(--ui-foreground);
	}

	/* The options: a row each, the native radio drawn with the kit's tokens. */
	.choices {
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
		min-width: 0;
		margin: 0;
		padding: 0;
		border: none;
	}
	.choices legend {
		margin-bottom: var(--space-sm);
		padding: 0;
	}
	.choice {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		min-height: 2.75rem;
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--ui-border);
		border-radius: var(--ui-radius);
		background: var(--ui-card);
		font-size: 0.875rem;
		overflow-wrap: anywhere;
		cursor: pointer;
		transition:
			border-color var(--duration-fast) var(--ease-out),
			background-color var(--duration-fast) var(--ease-out);
	}
	.choice:hover {
		border-color: color-mix(in srgb, var(--ui-foreground) 35%, transparent);
	}
	/* The row chosen: an edge in the ring's colour and a faint primary tint; its radio filled and the tick drawn. */
	.choice:has(input:checked) {
		border-color: var(--ui-ring);
		background: color-mix(in srgb, var(--ui-primary) 8%, var(--ui-card));
	}
	.choice-words {
		flex: 1 1 auto;
		min-width: 0;
	}
	.choice input {
		appearance: none;
		-webkit-appearance: none;
		flex-shrink: 0;
		width: 1rem;
		height: 1rem;
		margin: 0;
		border: 1px solid var(--ui-input);
		border-radius: 50%;
		background: var(--ui-background);
		cursor: pointer;
	}
	.choice input:checked {
		border-color: var(--ui-ring);
		background: radial-gradient(circle, var(--ui-ring) 0 0.25rem, var(--ui-background) 0.3rem);
	}
	.choice input:focus-visible {
		outline: 2px solid var(--ui-ring);
		outline-offset: 2px;
	}
	.choice-tick {
		flex-shrink: 0;
		color: var(--ui-ring);
		visibility: hidden;
	}
	.choice input:checked ~ .choice-tick {
		visibility: visible;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}
	.count {
		margin: 0;
		text-align: right;
	}

	/* Inside the warnings: the words as they were, the link and the boxes in the text colour. */
	.ruling-form p {
		margin: 0;
	}
	/* The warnings' words in the text colour, as before card 3087, not the kit alert's muted body (code review L2). */
	.ruling-form :global(.ui-alert-warning .ui-alert-body) {
		color: var(--ui-foreground);
	}
	.cut-off {
		margin: var(--space-xs) 0 0;
		padding-left: var(--space-lg);
	}
	.not-reached {
		color: var(--ui-muted-foreground);
	}
	.ruling-form a {
		color: var(--ui-foreground);
		text-decoration: underline;
		text-underline-offset: 3px;
		border-radius: var(--ui-radius-sm);
	}
	.ruling-form a:focus-visible {
		outline: 2px solid var(--ui-ring);
		outline-offset: 2px;
	}
	.confirms {
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
	}
	.confirm-open {
		display: flex;
		align-items: flex-start;
		gap: var(--space-sm);
		color: var(--ui-foreground);
		cursor: pointer;
	}
	.confirm-open input {
		flex-shrink: 0;
		width: 1rem;
		height: 1rem;
		margin: 0.1875rem 0 0;
		accent-color: var(--ui-primary);
		cursor: pointer;
	}
	.confirm-open input:focus-visible {
		outline: 2px solid var(--ui-ring);
		outline-offset: 2px;
	}

	.actions {
		display: flex;
		justify-content: flex-end;
	}
	.refused {
		font-size: 0.8125rem;
		color: var(--ui-foreground);
		min-height: 1em;
	}
	.refused:not(:empty) {
		padding-left: 0.625rem;
		border-left: 3px solid var(--ui-destructive);
	}
	.refused:focus-visible {
		outline: 2px solid var(--ui-ring);
		outline-offset: 2px;
	}

	/* A touch screen: each box's row is at least 44px. */
	@media (pointer: coarse) {
		.confirm-open {
			align-items: center;
			min-height: 2.75rem;
		}
		.confirm-open input {
			width: 1.25rem;
			height: 1.25rem;
			margin: 0;
		}
	}

	/* Forced colours draw no background, so the filled radio would not show: the system's own radio there. */
	@media (forced-colors: active) {
		.choice input {
			appearance: auto;
			-webkit-appearance: auto;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.choice {
			transition: none;
		}
	}
</style>
