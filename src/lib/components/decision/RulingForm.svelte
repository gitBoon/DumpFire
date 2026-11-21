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
    currentPassword, currentCode }` as JSON (card 2770). A refusal of the password stays in the dialog
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
-->
<script lang="ts">
	import { tick } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { failureMessage } from '$lib/api';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import { againstOf, DECISION_TEXT_MAX } from '$lib/decision-rules';
	import { NOT_REACHED_WORDS, NO_OPTIONS_PUT, RESULTS_READ_AGAIN, STALE_REVISION } from '$lib/decision-words';
	import { ASKS_FOR_PASSWORD, stepUpRefusal, type StepUpProof } from '$lib/step-up-words';

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
	let confirmedOpen = $state(false);
	let confirming = $state(false);
	/** The last refusal, said in the status region. */
	let refused = $state('');

	let ruleButton = $state<HTMLButtonElement>();
	let saidRegion = $state<HTMLElement>();

	/** Card 2683 (R18): no option was put to a vote, so the ruling is on none, with nothing to choose. */
	const noOptions = $derived(options.length === 0);
	const chosen = $derived(noOptions ? NONE : choice);
	const optionId = $derived(chosen === '' || chosen === NONE ? null : Number(chosen));
	/** Decision 11: the rule `ruleDecision` records, shared (code review F8): against when there were votes and the choice is not among the most chosen. */
	/** Card 2734 (D3): a choice is only one still offered, as the options may change when the page is read again. */
	const offered = $derived(chosen === NONE || options.some((option) => String(option.optionId) === chosen));
	const against = $derived(offered && againstOf(optionId, voted, mostChosen));
	const ready = $derived(offered && reason.trim() !== '' && (openQuestions === 0 || confirmedOpen));
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
			` ${ASKS_FOR_PASSWORD}`
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
				body: JSON.stringify({ optionId, reason, conditions, revision, openQuestionsConfirmed: confirmedOpen, currentPassword: proof.currentPassword, currentCode: proof.currentCode })
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
		<p class="note" data-note="no-options">{NO_OPTIONS_PUT}: the ruling chooses none, and your reason records what you concluded.</p>
	{:else}
		<fieldset class="choices">
			<legend>The ruling</legend>
			{#each options as option (option.optionId)}
				<label>
					<input type="radio" name="ruling-{id}" value={String(option.optionId)} bind:group={choice} aria-describedby={against ? warningId : undefined} />
					Option {option.label}{option.title ? `: ${option.title}` : ''}
				</label>
			{/each}
			<label>
				<input type="radio" name="ruling-{id}" value={NONE} bind:group={choice} aria-describedby={against ? warningId : undefined} />
				None of these
			</label>
		</fieldset>
	{/if}
	{#if against}
		<p class="warning" id={warningId} data-note="against">This goes against the responses: it is not the most chosen option. Only you and DumpFire's administrators are shown this.</p>
	{/if}

	<label class="small" for="{id}-reason">Why (required; every participant is told)</label>
	<textarea id="{id}-reason" class="field" rows="4" maxlength={TEXT_MAX} required aria-describedby="{id}-reason-count" bind:value={reason}></textarea>
	<p class="count" id="{id}-reason-count">{reason.length} of {TEXT_MAX.toLocaleString('en-GB')} characters</p>

	<label class="small" for="{id}-conditions">Conditions (optional)</label>
	<textarea id="{id}-conditions" class="field" rows="3" maxlength={TEXT_MAX} aria-describedby="{id}-conditions-count" bind:value={conditions}></textarea>
	<p class="count" id="{id}-conditions-count">{conditions.length} of {TEXT_MAX.toLocaleString('en-GB')} characters</p>

	{#if early}
		<div class="note" data-note="early">
			<p>{closedEarly ? 'The decision was closed before its closing time' : 'The decision is still open'}: ruling now is early{cutOff.length > 0 ? ', and cuts off these people who have not responded:' : '.'}</p>
			{#if cutOff.length > 0}
				<ul>
					{#each cutOff as person, index (index)}
						<li>{person.name}{#if !person.reached}{' '}<span class="not-reached" data-note="not-reached">({NOT_REACHED_WORDS})</span>{/if}</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}

	{#if openQuestions > 0}
		<label class="confirm-open">
			<input type="checkbox" bind:checked={confirmedOpen} data-check="open-questions" />
			{openQuestions === 1 ? '1 question is' : `${openQuestions} questions are`} still open: I rule with {openQuestions === 1 ? 'it' : 'them'} open
		</label>
	{/if}

	<div class="actions">
		<button type="submit" class="btn btn-primary btn-sm" data-action="rule" disabled={!ready} bind:this={ruleButton}>Rule…</button>
	</div>
	<p class="refused" role="status" data-said="ruling" tabindex="-1" bind:this={saidRegion}>{refused}</p>
</form>

{#if confirming}
	<ConfirmModal title="Rule on this decision?" {message} confirmText="Rule" askPassword onConfirm={rule} onCancel={cancel} />
{/if}

<style>
	.ruling-form { display: flex; flex-direction: column; gap: var(--space-xs); }
	.choices { border: none; padding: 0; margin: 0 0 var(--space-xs); display: flex; flex-direction: column; gap: var(--space-xs); font-size: 0.88rem; }
	.choices legend { font-weight: 600; margin-bottom: var(--space-xs); }
	.choices label { display: flex; gap: var(--space-xs); align-items: flex-start; overflow-wrap: anywhere; }
	.warning { margin: 0; font-size: 0.82rem; color: var(--accent-amber, var(--accent-rose)); }
	.field {
		width: 100%; box-sizing: border-box; padding: var(--space-xs) var(--space-sm);
		border: 1px solid var(--glass-border); border-radius: var(--radius-sm);
		background: var(--bg-elevated); color: var(--text-primary); font-size: 0.85rem; font-family: var(--font-family);
	}
	.small { font-size: 0.78rem; color: var(--text-secondary); }
	.count { margin: 0; font-size: 0.7rem; color: var(--text-tertiary); text-align: right; }
	.note { font-size: 0.82rem; color: var(--text-secondary); }
	.note p { margin: 0; }
	.note ul { margin: var(--space-xs) 0 0; padding-left: var(--space-lg); }
	.not-reached { color: var(--text-tertiary); }
	.confirm-open { display: flex; gap: var(--space-xs); align-items: flex-start; font-size: 0.85rem; }
	.actions { display: flex; justify-content: flex-end; }
	.refused { margin: 0; font-size: 0.82rem; color: var(--accent-rose); min-height: 1em; }
</style>
