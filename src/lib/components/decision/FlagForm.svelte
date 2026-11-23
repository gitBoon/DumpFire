<!--
  FlagForm.svelte — a participant's objection or request to talk to the
  decider, on both participant pages (card 2684, R3, R4, R12 and R22).

  It says who sees what is raised (`flagWhoSees`): whoever decides, named as
  the decider now, and DumpFire's administrators, with the participant's
  name; nobody else, never released; an objection is answered before the
  ruling and is no veto. Then the participant's own, oldest first, each with
  its kind, moment and the decider's reply or that there is none yet, every
  text plain, never markdown. The decider is never named as who replied: the
  page is given no name (R22).

  Two forms, each drawn only where the page says the participant may use it
  now (`mayObject`, `mayAskToTalk`). The objection's reason is required, at
  most 4,000 characters; the request to talk's note optional, at most 2,000;
  each with its count and `FLAG_TEXT_NOTE` under it. Send posts
  `{ ...extra, kind, reason }` as JSON to `url`: the signed-in page's route,
  or the personal link's with the token in `extra`, so that no address holds
  it. Where a form is not drawn it says why (`flagsClosedWords`), worked out
  from the page's data alone, as the question form does.

  A flag recorded joins the list, its box is emptied, and the page's data is
  read again (`invalidateAll`), so a form goes once the last allowed is raised
  or while a request to talk waits for its outcome. A refusal (a 409 or a 429
  among them) is said in the server's words and what was typed is kept; after
  a 409 the page's data is read again too. What was done, or refused, is said
  in a status region that stays drawn, only its words changing; once a flag
  is recorded it takes the focus, as the form used may then be gone (code
  review C-E-L4).
-->
<script lang="ts">
	import { tick } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { failureMessage } from '$lib/api';
	import { FLAG_TEXT_RULES, FLAGS_PER_PARTICIPANT_VERSION, type FlagKind } from '$lib/decision-rules';
	import type { OwnFlag } from '$lib/decision-view-types';
	import { FLAG_KIND_WORDS, FLAG_TEXT_NOTE, flagRepliedWords, flagsClosedWords, flagUnrepliedWords, flagWhoSees, shownMoment } from '$lib/decision-words';

	let {
		url,
		extra = {},
		flags = [],
		mayObject,
		mayAskToTalk,
		decider,
		shownStatus,
		versionNumber
	}: {
		/** Where Send posts. */
		url: string;
		/** Sent beside the flag: the personal link's token. */
		extra?: Record<string, unknown>;
		/** The participant's own objections and requests to talk, oldest first, as the page was given them. */
		flags?: OwnFlag[];
		/** Whether the participant may object now. */
		mayObject: boolean;
		/** Whether the participant may ask to talk now. */
		mayAskToTalk: boolean;
		/** The decider's name now, or "the decider". */
		decider: string;
		/** The decision's shown status. */
		shownStatus: string;
		/** The version the page shows: the caps count per version (R5). */
		versionNumber: number;
	} = $props();

	const id = $props.id();

	/** The page's list, with a flag just recorded added until the page's data, read again, gives it. */
	let raised = $derived<OwnFlag[]>([...flags]);
	let reasons = $state<Record<FlagKind, string>>({ objection: '', talk: '' });
	let sending = $state<FlagKind | null>(null);
	/** What was done, or the last refusal, said in the status region. */
	let said = $state<{ refused: boolean; words: string } | null>(null);
	let saidRegion = $state<HTMLElement>();

	const ready = (kind: FlagKind) => sending === null && (!FLAG_TEXT_RULES[kind].required || reasons[kind].trim() !== '');
	/** Why the form for `kind` is not drawn, from the page's data. */
	const closedWords = (kind: FlagKind) =>
		flagsClosedWords(
			kind,
			raised.filter((flag) => flag.kind === kind && flag.versionNumber === versionNumber).length,
			FLAGS_PER_PARTICIPANT_VERSION[kind],
			raised.some((flag) => flag.kind === 'talk' && flag.reply === null),
			shownStatus
		);
	/** Ruled, superseded or withdrawn: one line says so for both forms. */
	const shut = $derived(shownStatus !== 'open' && shownStatus !== 'awaiting_ruling');

	async function send(kind: FlagKind) {
		if (!ready(kind)) return;
		sending = kind;
		said = null;
		let recorded = false;
		let conflicted = false;
		const what = kind === 'objection' ? 'Your objection' : 'Your request to talk';
		try {
			const res = await fetch(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ...extra, kind, reason: reasons[kind] })
			});
			if (res.ok) {
				const answer = (await res.json()) as { flag: OwnFlag };
				raised = [...raised, answer.flag];
				reasons[kind] = '';
				said = { refused: false, words: `${what} was recorded on ${shownMoment(answer.flag.raisedAt, '')}.` };
				recorded = true;
			} else {
				said = { refused: true, words: await failureMessage(res, `${what} was not recorded.`) };
				conflicted = res.status === 409;
			}
		} catch {
			said = { refused: true, words: `No answer from the server. It is not known whether ${what.toLowerCase()} was recorded.` };
		} finally {
			sending = null;
		}
		// The page's data read again: its list, and whether another may be raised; after a 409 too, so the form shows why it is closed.
		if (recorded || conflicted) await invalidateAll();
		// Recorded, the form may be gone (the last allowed, or a request to talk now waiting), so the words take the focus
		// rather than leave it nowhere (code review C-E-L4).
		if (recorded) {
			await tick();
			saidRegion?.focus();
		}
	}
</script>

{#snippet form(kind: FlagKind, open: boolean)}
	{#if open}
		{@const rule = FLAG_TEXT_RULES[kind]}
		<form
			data-form={kind}
			onsubmit={(e) => {
				e.preventDefault();
				send(kind);
			}}
		>
			<h3>{kind === 'objection' ? 'I object' : 'I need to talk to the decider'}</h3>
			<label class="field-label" for="{id}-{kind}">{kind === 'objection' ? 'Why you cannot live with this decision (required)' : 'A note for the decider (optional)'}</label>
			<textarea
				id="{id}-{kind}"
				class="field"
				rows={kind === 'objection' ? 4 : 3}
				maxlength={rule.max}
				required={rule.required}
				aria-describedby="{id}-{kind}-count {id}-{kind}-note"
				bind:value={reasons[kind]}
			></textarea>
			<p class="count" id="{id}-{kind}-count">{reasons[kind].length} of {rule.max.toLocaleString('en-GB')} characters</p>
			<p class="note" id="{id}-{kind}-note">{FLAG_TEXT_NOTE}</p>
			<button type="submit" class="btn-primary send" data-action={kind} disabled={!ready(kind)} aria-busy={sending === kind ? 'true' : undefined}
				>{kind === 'objection' ? 'Send my objection' : 'Ask to talk'}</button
			>
		</form>
	{:else if !shut}
		<p class="closed" data-note="{kind}-closed">{closedWords(kind)}</p>
	{/if}
{/snippet}

<div class="flag-form" data-block="flags">
	<p class="who-sees" data-note="flag-who-sees">{flagWhoSees(decider)}</p>

	{#if raised.length > 0}
		<h3>What you have raised</h3>
		<ul class="flags" data-list="own-flags">
			{#each raised as flag, index (index)}
				<li data-flag-kind={flag.kind}>
					<p class="line">
						<strong>{FLAG_KIND_WORDS[flag.kind]}</strong>
						<span class="meta">{shownMoment(flag.raisedAt, '')}{flag.versionNumber !== versionNumber ? `, about version ${flag.versionNumber}` : ''}</span>
					</p>
					{#if flag.reason !== ''}<p class="text" data-text="reason">{flag.reason}</p>{/if}
					{#if flag.reply !== null}
						<p class="meta" data-note="replied">{flagRepliedWords(flag.kind)}, {shownMoment(flag.repliedAt, '')}:</p>
						<p class="text reply" data-text="reply">{flag.reply}</p>
					{:else}
						<p class="meta" data-note="no-reply">{flagUnrepliedWords(flag.kind)}</p>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}

	{#if shut}
		<p class="closed" data-note="flags-closed">{closedWords('objection')}</p>
	{/if}
	{@render form('objection', mayObject)}
	{@render form('talk', mayAskToTalk)}

	<!-- Drawn from the start, so a screen reader hears each change of its words; it takes the focus once a flag is recorded. -->
	<p class="said" class:refused={said?.refused} role="status" data-said="flag" tabindex="-1" bind:this={saidRegion}>{said?.words ?? ''}</p>
</div>

<style>
	.flag-form { display: flex; flex-direction: column; gap: var(--space-sm); font-size: 1rem; }
	.flag-form p { margin: 0; }
	.who-sees, .closed, .note { font-size: 0.9rem; color: var(--text-secondary); }
	h3 { font-size: 1rem; margin: var(--space-xs) 0 0; }
	.flags { margin: 0; padding-left: var(--space-lg); display: flex; flex-direction: column; gap: var(--space-sm); }
	.line { display: flex; flex-wrap: wrap; gap: var(--space-sm); align-items: baseline; }
	.meta { font-size: 0.85rem; color: var(--text-secondary); }
	.text { white-space: pre-wrap; overflow-wrap: anywhere; }
	.reply { padding-left: var(--space-md); border-left: 2px solid var(--glass-border); }
	form { display: flex; flex-direction: column; gap: var(--space-xs); }
	.field-label { font-size: 0.9rem; color: var(--text-secondary); }
	/* 16px, so a phone does not zoom; every tap target 44px tall at least (card 2677, decision 22). */
	.field {
		font-size: 16px; font-family: var(--font-family); padding: var(--space-sm); width: 100%; box-sizing: border-box;
		border: 1px solid var(--glass-border); border-radius: var(--radius-sm); background: var(--bg-elevated); color: var(--text-primary);
	}
	.count { font-size: 0.8rem; color: var(--text-tertiary); text-align: right; }
	.send { min-height: 44px; font-size: 1rem; align-self: flex-start; }
	.said { font-size: 0.9rem; color: var(--accent-emerald, var(--text-secondary)); }
	.said.refused { color: var(--accent-rose); }
</style>
