<!--
  DecisionActions.svelte — a decision's lifecycle controls, above its editor
  (card 2697, decision 20, Q14, Q17, Q25, Q29).

  Every control is drawn only where the server's `actions` says the caller
  may take it now (`TRANSITIONS` and `mayDo`, as each write asks them); the
  server asks again.

  - **Preview as a participant** links to `/decisions/<id>/preview`.
  - **Results and ruling** links to `/decisions/<id>/results`, where
    `mayReadResults` (card 2679, decision 15): the decider rules there, with
    the tally in view, and not from this bar.
  - **Record** links to `/decisions/<id>/record`, where `mayReadRecord`
    (card 2680, decision 29): every event of the decision, for the decider
    and administrators. It is a read, so it is not counted as a lifecycle
    control.
  - **Send me a dry run** sends `{ revision }`; a 409 or 429 is said in the
    server's words.
  - **Open** is off while the server gives a refusal, which it lists; with
    warnings it confirms "Open with N warnings". Its confirmation says how
    many people are mailed (`mailCount`, card 2682 D32). It sends
    `{ revision }`.
  - **Re-publish** asks for a change note and Ask everyone again or Tell them
    only, which is off, with its reason, where the working copy adds or
    retires an option, or (card 2683, R7) adds, retires or changes a survey
    question but for its help, each named by number and prompt
    (`republishSummary`). A note under the choice says who
    is asked, told or invited by it (card 2739, D5); the server decides who at
    the write. It sends `{ changeNote, askAgain, revision }`.
  - Open, Re-publish and the dry run act on the saved working copy, so each is
    off while the editor holds edits not yet saved ("Save your changes
    first").
  - **Close** confirms and sends the JSON type with no body.
  - **Extend** takes a closing time, read and sent as typed, in UTC, at most a
    year ahead (`CLOSES_WITHIN_DAYS`): no `Date` is made of it. On a decision
    shown not open for input its confirmation says that the reopening sends
    the invitation to anyone consulted not yet asked (card 2744, D7), read
    from `shownStatus`; the server decides who at the write.
  - **Withdraw** needs a reason; on a decision that was ever opened its
    confirmation asks for the caller's password (`withdrawAsks`) and sends
    `{ reason, currentPassword, currentCode }` (card 2770), on a draft it
    sends `{ reason }`.
  - **Delete** confirms; on a decision that was ever opened it asks for the
    password (`deleteAsks`) and sends `{ currentPassword, currentCode }`, on
    a draft `{}`.

  Every write says it is JSON (card 2700). A refusal of the password is told
  by its code (`stepUpRefusal`) and keeps the dialog open, the field cleared;
  any other refusal closes it and is said here, in the server's words. A
  write taken hands the next revision up, and the page reads its data again;
  a delete goes to the board's decisions.

  The code review's part B: Withdraw and Delete send whatever password was
  typed (S4), so that a dialog the server told to ask (`STEP_UP_MISSING`, the
  page gone stale since the decision was opened elsewhere) can complete. The
  Re-publish, Extend and Withdraw toggles say whether their form is open and
  which it is; opening one moves the focus into it, and closing it after a
  success hands the focus back to its toggle, or to what was said where the
  toggle has gone. What was done is said in a status region that stays drawn,
  only its words changing (F6). The `Actions` and `Summary` types are the
  edit page's own (F5).
-->
<script lang="ts">
	import { tick } from 'svelte';
	import type { PageData } from '../../../routes/decisions/[id]/edit/$types';
	import { goto } from '$app/navigation';
	import { failureMessage } from '$lib/api';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import { CLOSES_HELP, closesField, type Refusal, type Warning } from '$lib/decision-readiness';
	import { openForInput } from '$lib/decision-rules';
	import { codeAskedHere } from '$lib/code-asked';
	import { asksForPassword, stepUpRefusal, type StepUpProof } from '$lib/step-up-words';

	type Actions = PageData['actions'];
	type Summary = NonNullable<PageData['republishSummary']>;
	type Panel = 'republish' | 'extend' | 'withdraw';

	let {
		decisionId,
		boardId,
		title,
		closesAt,
		shownStatus,
		revision,
		actions,
		republishSummary,
		refusals,
		warnings,
		mailCount,
		dirty,
		mayReadResults = false,
		mayReadRecord = false,
		onSaved
	}: {
		decisionId: number;
		/** The board the decision is on, where a delete goes back to; null once the board is gone. */
		boardId: number | null;
		title: string;
		/** The stored closing time, which Extend starts from. */
		closesAt: string | null;
		/** The status the decision is shown with, read at load (card 2744): Extend's confirmation says what a reopening sends. */
		shownStatus?: string;
		/** The decision's revision as the page holds it. */
		revision: string;
		/** What the caller may do now, as the server worked it out. */
		actions: Actions;
		/** What a re-publish would do to the options; null where it is not offered. */
		republishSummary: Summary | null;
		/** The server's refusals of opening, as it gave them. */
		refusals: Refusal[];
		/** The saved working copy's warnings, as the server gave them. */
		warnings: Warning[];
		/** How many live participants the saved set holds: whom Open mails (card 2682, D32). */
		mailCount: number;
		/** Whether the editor holds edits not yet saved. */
		dirty: boolean;
		/** Whether the caller may read the results and rule from them (card 2679, decision 15): the decider and administrators. */
		mayReadResults?: boolean;
		/**
		 * Whether the caller may read the decision's record (card 2680, decision 29): the decider, with board edit while
		 * the board exists, and administrators. A read, not a lifecycle control.
		 */
		mayReadRecord?: boolean;
		/** A write was taken: the decision's revision after it. */
		onSaved: (revision: string) => void | Promise<void>;
	} = $props();

	const SAVE_FIRST = 'Save your changes first';

	/** The last refusal, or what was done, said in the bar. */
	let said = $state<{ refused: boolean; words: string } | null>(null);
	/** The form open under the bar. */
	let panel = $state<Panel | null>(null);
	/** The confirmation open. */
	let confirming = $state<'open' | 'close' | 'extend' | 'withdraw' | 'delete' | null>(null);
	/** A write without a confirmation is under way. */
	let busy = $state(false);

	let changeNote = $state('');
	let askAgain = $state(true);
	let reason = $state('');
	let closes = $state('');

	/** The controls' section, where a toggle is found again by its `data-action`, and the status region. */
	let section = $state<HTMLElement>();
	let statusRegion = $state<HTMLElement>();

	/** Whether Tell them only would be refused: an option added or retired, or (card 2683, R7) a survey question added, retired or changed but for its help. */
	let tellOnlyRefused = $derived(republishSummary !== null && (republishSummary.changesOptions || republishSummary.changesSurvey === true));

	// Tell them only cannot be chosen once it would be refused.
	$effect(() => {
		if (tellOnlyRefused) askAgain = true;
	});

	/** Each form's id, which its toggle names (`aria-controls`). */
	const panelId = (name: Panel) => `${name}-panel-${decisionId}`;

	/** Open a form, the focus moved into its first field; or close it, the focus back on its toggle (F6). */
	async function show(panelName: Panel) {
		said = null;
		const opening = panel !== panelName;
		panel = opening ? panelName : null;
		if (opening && panelName === 'extend') closes = closesField(closesAt);
		await tick();
		if (opening) section?.querySelector<HTMLElement>(`#${panelId(panelName)} textarea, #${panelId(panelName)} input`)?.focus();
	}

	/**
	 * A form closed: by Cancel, or after its write was taken and the page's
	 * data read again. The focus goes back to its toggle, or, where the toggle
	 * is no longer drawn (a withdrawn decision has no Withdraw), to what was
	 * said (F6).
	 */
	async function closed(panelName: Panel) {
		panel = null;
		await tick();
		(section?.querySelector<HTMLElement>(`[data-action="${panelName}"]`) ?? statusRegion)?.focus();
	}

	const noAnswer = (what: string) => `No answer from the server. It is not known whether ${what}.`;

	/** A write's answer: a password refusal given back to the dialog; otherwise the dialog closes and the answer is taken or said. */
	async function answered(res: Response, fallback: string, done: string, after?: () => Promise<void>): Promise<string | void> {
		const refusal = await stepUpRefusal(res);
		if (refusal !== null) return refusal;
		confirming = null;
		if (res.ok) {
			const from = panel;
			panel = null;
			said = { refused: false, words: done };
			if (after) await after();
			else await onSaved(((await res.json()) as { revision: string }).revision);
			if (from !== null) await closed(from);
		} else {
			said = { refused: true, words: await failureMessage(res, fallback) };
		}
	}

	// ─── Each write ──────────────────────────────────────────────────────────

	async function dryRun() {
		if (busy || dirty) return;
		busy = true;
		said = null;
		try {
			const res = await fetch(`/api/decisions/${decisionId}/dry-run`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ revision })
			});
			said = res.ok
				? { refused: false, words: 'A dry run is on its way to your address in the people directory.' }
				: { refused: true, words: await failureMessage(res, 'The dry run was not sent.') };
		} catch {
			said = { refused: true, words: noAnswer('the dry run was sent') };
		} finally {
			busy = false;
		}
	}

	async function open(): Promise<string | void> {
		try {
			const res = await fetch(`/api/decisions/${decisionId}/open`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ revision })
			});
			return await answered(res, 'The decision was not opened.', 'Opened: its participants are being mailed.');
		} catch {
			confirming = null;
			said = { refused: true, words: noAnswer('the decision was opened') };
		}
	}

	async function republish() {
		if (busy || dirty || changeNote.trim() === '') return;
		busy = true;
		said = null;
		try {
			const res = await fetch(`/api/decisions/${decisionId}/republish`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ changeNote, askAgain, revision })
			});
			if (res.ok) {
				panel = null;
				changeNote = '';
				said = { refused: false, words: 'Re-published: its participants are being mailed.' };
				await onSaved(((await res.json()) as { revision: string }).revision);
				await closed('republish');
			} else {
				said = { refused: true, words: await failureMessage(res, 'The decision was not re-published.') };
			}
		} catch {
			said = { refused: true, words: noAnswer('the decision was re-published') };
		} finally {
			busy = false;
		}
	}

	async function close(): Promise<string | void> {
		try {
			const res = await fetch(`/api/decisions/${decisionId}/close`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' }
			});
			return await answered(res, 'The decision was not closed.', 'Closed for input.');
		} catch {
			confirming = null;
			said = { refused: true, words: noAnswer('the decision was closed') };
		}
	}

	async function extend(): Promise<string | void> {
		try {
			const res = await fetch(`/api/decisions/${decisionId}/extend`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ closesAt: closes })
			});
			return await answered(res, 'The decision was not extended.', 'Extended.');
		} catch {
			confirming = null;
			said = { refused: true, words: noAnswer('the decision was extended') };
		}
	}

	async function withdraw(proof: StepUpProof): Promise<string | void> {
		// Whatever was typed is sent (the code review's part B, S4): the dialog asks where the page says the
		// server will (Q29), and also once the server has said so, on a page gone stale; with nothing typed, none.
		const currentPassword = proof.currentPassword || undefined;
		const currentCode = proof.currentCode || undefined;
		try {
			const res = await fetch(`/api/decisions/${decisionId}/withdraw`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ reason, currentPassword, currentCode })
			});
			return await answered(res, 'The decision was not withdrawn.', 'Withdrawn.');
		} catch {
			confirming = null;
			said = { refused: true, words: noAnswer('the decision was withdrawn') };
		}
	}

	async function remove(proof: StepUpProof): Promise<string | void> {
		// Whatever was typed is sent (S4): a decision that holds a record asks (Q9), as the page or the server says.
		const currentPassword = proof.currentPassword || undefined;
		const currentCode = proof.currentCode || undefined;
		try {
			const res = await fetch(`/api/decisions/${decisionId}`, {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ currentPassword, currentCode })
			});
			return await answered(res, 'The decision was not deleted.', 'Deleted.', () => goto(boardId === null ? '/' : `/board/${boardId}/decisions`));
		} catch {
			confirming = null;
			said = { refused: true, words: noAnswer('the decision was deleted') };
		}
	}

	// ─── The confirmations ───────────────────────────────────────────────────

	const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

	/** A survey question as a summary names it (card 2683): its number, and its prompt where it has one. */
	const surveyNamed = (question: Summary['surveyAdding'][number]) => (question.prompt.trim() === '' ? `${question.number}` : `${question.number} ('${question.prompt.trim()}')`);
	/** `what` and the questions it names: "adds survey question 2 ('…')", or "questions" for more than one. */
	const surveyPart = (what: string, list: Summary['surveyAdding']) =>
		list.length === 0 ? [] : [`${what} survey question${list.length === 1 ? '' : 's'} ${list.map(surveyNamed).join(', ')}`];
	/** A list in words: "a", "a and b", "a, b and c". */
	const listed = (parts: string[]) => (parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`);

	/**
	 * Why Tell them only is off: the options this version would add and retire, by label; and (card 2683, R7, R8) the
	 * survey questions it would add, retire or change, by number and prompt, as only a question's help may be told of.
	 */
	function tellOnlyOff(summary: Summary): string {
		const changes = [
			...(summary.adding.length > 0 ? [`adds option ${summary.adding.join(', ')}`] : []),
			...(summary.retiring.length > 0 ? [`retires option ${summary.retiring.join(', ')}`] : []),
			...(summary.changesSurvey
				? [...surveyPart('adds', summary.surveyAdding), ...surveyPart('retires', summary.surveyRetiring), ...surveyPart('changes', summary.surveyChanging)]
				: [])
		];
		const helpOnly = summary.changesSurvey ? " Only a survey question's help can be changed by telling them only." : '';
		return `Tell them only is off: this version ${listed(changes)}, so everyone consulted is asked again; people kept informed are told.${helpOnly}`;
	}
	// Card 2739 (D5): who each choice mails, and with what. Advice: the server reads who the round reached at the write.
	const republishWho = $derived(
		askAgain
			? "Everyone consulted is asked for their view again; anyone consulted whom this round's ask has not reached is sent the invitation instead. Everyone informed is told of the change."
			: "Everyone consulted whom this round's ask reached, and everyone informed, is told of the change. Anyone consulted whom this round's ask has not reached is sent nothing: Resend asks them while the decision is open for input."
	);
	// Card 2682 (D32): how many people the mail-out reaches, said before it goes.
	const mailed = $derived(`Every participant of "${title}" is mailed now: ${mailCount === 1 ? '1 person' : `${mailCount} people`}.`);
	const openMessage = $derived(
		warnings.length === 0 ? mailed : `${mailed} Still to look at: ${warnings.map((warning) => warning.words).join('; ')}.`
	);
	// Card 2744 (D7): an Extend that reopens the decision for input asks whoever the round has not reached.
	const reopenWords = $derived(
		shownStatus !== undefined && !openForInput(shownStatus)
			? ' Anyone consulted who has not yet been asked for their view is sent the invitation now, as the mail limits allow.'
			: ''
	);
	const withdrawMessage = $derived(
		actions.withdrawAsks
			? `"${title}" ends for good, and every participant is mailed your reason. ${asksForPassword(codeAskedHere())}`
			: `"${title}" is withdrawn. It was never opened, so nobody is told.`
	);
	const deleteMessage = $derived(
		actions.deleteAsks
			? `"${title}" and its record (every version, response and event) are deleted for good. ${asksForPassword(codeAskedHere())}`
			: `The draft "${title}" is deleted. It was never opened, so it holds no record.`
	);

	// The results page is where the ruling and the release are made, so its link is a lifecycle control too.
	let anyAction = $derived(
		actions.open || actions.republish || actions.close || actions.extend || actions.withdraw || actions.delete || actions.dryRun || mayReadResults
	);
</script>

<section class="decision-actions" aria-label="What can be done with this decision" bind:this={section}>
	<div class="bar">
		<a class="btn btn-ghost btn-sm" href="/decisions/{decisionId}/preview" data-action="preview">Preview as a participant</a>
		{#if mayReadResults}
			<a class="btn btn-ghost btn-sm" href="/decisions/{decisionId}/results" data-action="results">Results and ruling</a>
		{/if}
		{#if mayReadRecord}
			<a class="btn btn-ghost btn-sm" href="/decisions/{decisionId}/record" data-action="record">Record</a>
		{/if}
		{#if actions.dryRun}
			<button type="button" class="btn btn-ghost btn-sm" data-action="dryRun" disabled={dirty || busy} title={dirty ? SAVE_FIRST : undefined} onclick={dryRun}>
				Send me a dry run
			</button>
		{/if}
		{#if actions.open}
			<button
				type="button"
				class="btn btn-primary btn-sm"
				data-action="open"
				disabled={dirty || refusals.length > 0}
				title={dirty ? SAVE_FIRST : undefined}
				onclick={() => ((said = null), (confirming = 'open'))}
			>
				Open
			</button>
		{/if}
		{#if actions.republish}
			<button
				type="button"
				class="btn btn-ghost btn-sm"
				data-action="republish"
				disabled={dirty}
				title={dirty ? SAVE_FIRST : undefined}
				aria-expanded={panel === 'republish'}
				aria-controls={panelId('republish')}
				onclick={() => show('republish')}
			>
				Re-publish
			</button>
		{/if}
		{#if actions.close}
			<button type="button" class="btn btn-ghost btn-sm" data-action="close" onclick={() => ((said = null), (confirming = 'close'))}>Close</button>
		{/if}
		{#if actions.extend}
			<button type="button" class="btn btn-ghost btn-sm" data-action="extend" aria-expanded={panel === 'extend'} aria-controls={panelId('extend')} onclick={() => show('extend')}>
				Extend
			</button>
		{/if}
		{#if actions.withdraw}
			<button
				type="button"
				class="btn btn-ghost btn-sm danger"
				data-action="withdraw"
				aria-expanded={panel === 'withdraw'}
				aria-controls={panelId('withdraw')}
				onclick={() => show('withdraw')}
			>
				Withdraw
			</button>
		{/if}
		{#if actions.delete}
			<button type="button" class="btn btn-ghost btn-sm danger" data-action="delete" onclick={() => ((said = null), (confirming = 'delete'))}>Delete</button>
		{/if}
	</div>

	{#if dirty && (actions.open || actions.republish || actions.dryRun)}
		<p class="note" data-note="dirty">{SAVE_FIRST}: opening, re-publishing and a dry run send the saved working copy.</p>
	{/if}
	{#if actions.open && refusals.length > 0}
		<div class="refusals" data-note="refusals">
			<p class="note">It cannot be opened yet:</p>
			<ul>
				{#each refusals as refusal (refusal.code + refusal.words)}
					<li>{refusal.words}</li>
				{/each}
			</ul>
		</div>
	{/if}
	{#if !anyAction}
		<p class="note">Nothing in its lifecycle can be done by you now.</p>
	{/if}

	{#if panel === 'republish'}
		<form class="panel" id={panelId('republish')} data-panel="republish" onsubmit={(e) => (e.preventDefault(), republish())}>
			<label class="small" for="republish-note-{decisionId}">What changed (participants are told it)</label>
			<textarea id="republish-note-{decisionId}" class="field" rows="3" maxlength="2000" bind:value={changeNote}></textarea>
			<fieldset>
				<legend class="small">Then</legend>
				<label><input type="radio" name="ask-again-{decisionId}" value={true} bind:group={askAgain} /> Ask everyone again</label>
				<label>
					<input
						type="radio"
						name="ask-again-{decisionId}"
						value={false}
						bind:group={askAgain}
						disabled={tellOnlyRefused}
						aria-describedby={tellOnlyRefused ? `tell-only-${decisionId}` : undefined}
					/>
					Tell them only
				</label>
				{#if republishSummary !== null && tellOnlyRefused}
					<p class="note" id="tell-only-{decisionId}" data-note="tell-only">{tellOnlyOff(republishSummary)}</p>
				{/if}
				<p class="note" data-note="republish-who">{republishWho}</p>
			</fieldset>
			<div class="panel-actions">
				<button type="button" class="btn btn-ghost btn-sm" onclick={() => closed('republish')}>Cancel</button>
				<button type="submit" class="btn btn-primary btn-sm" disabled={busy || dirty || changeNote.trim() === ''}>Re-publish</button>
			</div>
		</form>
	{:else if panel === 'extend'}
		<form class="panel" id={panelId('extend')} data-panel="extend" onsubmit={(e) => (e.preventDefault(), (confirming = 'extend'))}>
			<label class="small" for="extend-closes-{decisionId}">New closing time (UTC)</label>
			<input id="extend-closes-{decisionId}" class="field" type="datetime-local" aria-describedby="extend-help-{decisionId}" bind:value={closes} />
			<p id="extend-help-{decisionId}" class="help" data-help="extend">{CLOSES_HELP}</p>
			<div class="panel-actions">
				<button type="button" class="btn btn-ghost btn-sm" onclick={() => closed('extend')}>Cancel</button>
				<button type="submit" class="btn btn-primary btn-sm" disabled={closes === ''}>Extend…</button>
			</div>
		</form>
	{:else if panel === 'withdraw'}
		<form class="panel" id={panelId('withdraw')} data-panel="withdraw" onsubmit={(e) => (e.preventDefault(), (confirming = 'withdraw'))}>
			<label class="small" for="withdraw-reason-{decisionId}">Why it is withdrawn{actions.withdrawAsks ? ' (every participant is told)' : ''}</label>
			<textarea id="withdraw-reason-{decisionId}" class="field" rows="3" maxlength="2000" bind:value={reason}></textarea>
			<div class="panel-actions">
				<button type="button" class="btn btn-ghost btn-sm" onclick={() => closed('withdraw')}>Cancel</button>
				<button type="submit" class="btn btn-sm btn-confirm-danger" disabled={reason.trim() === ''}>Withdraw…</button>
			</div>
		</form>
	{/if}

	<!-- F6: drawn from the start, so a screen reader hears each change of its words; a refusal is an alert of its own. -->
	<p class="done" role="status" data-said="done" tabindex="-1" bind:this={statusRegion}>{said !== null && !said.refused ? said.words : ''}</p>
	{#if said?.refused}
		<p class="refused" role="alert">{said.words}</p>
	{/if}
</section>

{#if confirming === 'open'}
	<ConfirmModal
		title="Open this decision?"
		message={openMessage}
		confirmText={warnings.length === 0 ? 'Open' : `Open with ${plural(warnings.length, 'warning')}`}
		confirmDanger={false}
		onConfirm={open}
		onCancel={() => (confirming = null)}
	/>
{:else if confirming === 'close'}
	<ConfirmModal
		title="Close for input?"
		message={`"${title}" stops taking responses now. Its decider can still extend it.`}
		confirmText="Close"
		confirmDanger={false}
		onConfirm={close}
		onCancel={() => (confirming = null)}
	/>
{:else if confirming === 'extend'}
	<ConfirmModal
		title="Extend this decision?"
		message={`"${title}" closes at ${closes.replace('T', ' ')} UTC, and is open for input until then.${reopenWords}`}
		confirmText="Extend"
		confirmDanger={false}
		onConfirm={extend}
		onCancel={() => (confirming = null)}
	/>
{:else if confirming === 'withdraw'}
	<ConfirmModal title="Withdraw this decision?" message={withdrawMessage} confirmText="Withdraw" askPassword={actions.withdrawAsks} onConfirm={withdraw} onCancel={() => (confirming = null)} />
{:else if confirming === 'delete'}
	<ConfirmModal title="Delete this decision?" message={deleteMessage} confirmText="Delete" askPassword={actions.deleteAsks} onConfirm={remove} onCancel={() => (confirming = null)} />
{/if}

<style>
	.decision-actions { display: flex; flex-direction: column; gap: var(--space-xs); margin-bottom: var(--space-md); }
	.bar { display: flex; flex-wrap: wrap; gap: var(--space-sm); align-items: center; }
	.bar a { text-decoration: none; }
	.note { font-size: 0.78rem; color: var(--text-tertiary); margin: 0; }
	.refusals ul { margin: 0; padding-left: var(--space-lg); font-size: 0.78rem; color: var(--accent-rose); }
	.refused { font-size: 0.8rem; color: var(--accent-rose); margin: 0; }
	.done { font-size: 0.8rem; color: var(--accent-emerald, var(--text-secondary)); margin: 0; }
	.danger { color: var(--accent-rose) !important; }
	.panel {
		display: flex; flex-direction: column; gap: var(--space-xs); max-width: 560px;
		padding: var(--space-md); border: 1px solid var(--glass-border); border-radius: var(--radius-md); background: var(--bg-base);
	}
	.panel fieldset { border: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 2px; font-size: 0.82rem; }
	.panel-actions { display: flex; justify-content: flex-end; gap: var(--space-sm); }
	.field {
		width: 100%; box-sizing: border-box; padding: var(--space-xs) var(--space-sm);
		border: 1px solid var(--glass-border); border-radius: var(--radius-sm);
		background: var(--bg-elevated); color: var(--text-primary); font-size: 0.82rem; font-family: var(--font-family);
	}
	.small { font-size: 0.72rem; color: var(--text-secondary); margin: 0; }
	.help { font-size: 0.7rem; color: var(--text-tertiary); margin: 0; }
</style>
