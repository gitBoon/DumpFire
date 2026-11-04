<!--
  RulingForm.svelte — the decider's ruling, on the results page (card 2679,
  decisions 2, 11 to 13 and 15).

  - The options, and "None of these", are radios in a fieldset with a legend.
    Where there were votes and the choice is not among the most chosen, a
    warning says the ruling goes against the responses, named by each radio's
    `aria-describedby` (F5).
  - The reason is required and the conditions are not; each is a labelled
    textarea of at most 4,000 characters with its count.
  - Ruling while the decision is shown open is early: the people who have not
    responded, and are cut off by it, are named before confirming.
  - With questions still open, Rule is off until the box saying so is ticked.
  - Rule… opens a dialog that asks for the caller's password and sends
    `{ optionId, reason, conditions, revision, openQuestionsConfirmed,
    currentPassword }` as JSON. A refusal of the password stays in the dialog
    (`stepUpRefusal`); any other refusal closes it and is said in the status
    region, in the server's words, and the focus goes back to Rule. A ruling
    taken is handed up (`onRuled`), whose page says it in its own region, as
    the form is then no longer drawn.
-->
<script lang="ts">
	import { tick } from 'svelte';
	import { failureMessage } from '$lib/api';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import { againstOf, DECISION_TEXT_MAX } from '$lib/decision-rules';
	import { ASKS_FOR_PASSWORD, stepUpRefusal } from '$lib/step-up-words';

	let {
		decisionId,
		title,
		revision,
		options,
		mostChosen,
		voted,
		early,
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
		/** Whether the decision is shown open now, so that ruling is early. */
		early: boolean;
		/** Who an early ruling cuts off: the live consulted participants who have not responded. */
		cutOff: string[];
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

	const optionId = $derived(choice === '' || choice === NONE ? null : Number(choice));
	/** Decision 11: the rule `ruleDecision` records, shared (code review F8): against when there were votes and the choice is not among the most chosen. */
	const against = $derived(choice !== '' && againstOf(optionId, voted, mostChosen));
	const ready = $derived(choice !== '' && reason.trim() !== '' && (openQuestions === 0 || confirmedOpen));
	const chosenWords = $derived.by(() => {
		if (optionId === null) return 'None of these';
		const option = options.find((candidate) => candidate.optionId === optionId);
		return option === undefined ? '' : `Option ${option.label}${option.title ? `: ${option.title}` : ''}`;
	});
	const message = $derived(
		`"${title}" is ruled for good on ${chosenWords}, and every participant is mailed the ruling and your reason.` +
			(early && cutOff.length > 0 ? ` ${cutOff.length} who have not responded are cut off.` : '') +
			` ${ASKS_FOR_PASSWORD}`
	);

	/** Rule…: the dialog, once the form is complete. */
	function ask(event: SubmitEvent) {
		event.preventDefault();
		if (!ready) return;
		refused = '';
		confirming = true;
	}

	async function rule(typed: string): Promise<string | void> {
		try {
			const res = await fetch(`/api/decisions/${decisionId}/rule`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ optionId, reason, conditions, revision, openQuestionsConfirmed: confirmedOpen, currentPassword: typed })
			});
			const refusal = await stepUpRefusal(res);
			if (refusal !== null) return refusal;
			confirming = false;
			if (res.ok) {
				refused = '';
				await onRuled('Ruled: every participant is being mailed the ruling.');
				return;
			}
			refused = await failureMessage(res, 'The decision was not ruled on.');
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
			<p>The decision is still open: ruling now is early{cutOff.length > 0 ? ', and cuts off these people who have not responded:' : '.'}</p>
			{#if cutOff.length > 0}
				<ul>
					{#each cutOff as name, index (index)}
						<li>{name}</li>
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
	<p class="refused" role="status" data-said="ruling">{refused}</p>
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
	.confirm-open { display: flex; gap: var(--space-xs); align-items: flex-start; font-size: 0.85rem; }
	.actions { display: flex; justify-content: flex-end; }
	.refused { margin: 0; font-size: 0.82rem; color: var(--accent-rose); min-height: 1em; }
</style>
