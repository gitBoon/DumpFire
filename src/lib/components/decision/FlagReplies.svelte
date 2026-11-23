<!--
  FlagReplies.svelte — every objection and request to talk on a decision, on
  its results page, for its decider and DumpFire's administrators alone (card
  2684, R7, R11, R12 and R23).

  Objections with no answer first, then the rest, each oldest first as the
  page gave them: its kind, the participant's name, when, by which way in and
  about which version, what they said, and the reply with who gave it, by name
  alone, never by account (S-L4). Every text plain, never markdown.

  A reply box is drawn on a flag with no reply only where the caller may reply
  now (`mayReply`: the current decider, with board edit) and the flag can still
  take one: a request to talk's outcome at any status the page has, an
  objection's answer only while the decision is open or awaiting its ruling
  (R7). Above it, who reads the reply (`flagReplyWhoSees`): the participant,
  and anyone holding their personal link (S-L3). It sends `{ reply }` as JSON
  to `/api/decisions/[id]/flags/[flagId]/reply`. An administrator is given no
  box, and is told who replies (`FLAG_REPLY_ELSEWHERE`); on a withdrawn
  decision everyone is told that replies are closed (`FLAG_REPLIES_CLOSED`),
  the decider among them (code review C-E-L1).

  A reply recorded empties its box and reads the page's data again
  (`invalidateAll`): the list, and the results revision a ruling sends (R10).
  A refusal is said in the server's words, what was typed kept; after a 409
  the page's data is read again too. What was done, or refused, is said in a
  status region that stays drawn. It takes the focus once a reply is
  recorded, as the box that was used is then gone; on a refusal the focus goes
  back to the box, or to the region where the page read again has no box for
  the flag (code review C-E-L5).
-->
<script lang="ts">
	import { tick } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { failureMessage } from '$lib/api';
	import { REPLY_TEXT_RULE } from '$lib/decision-rules';
	import type { ResultFlag } from '$lib/decision-view-types';
	import { FLAG_KIND_WORDS, FLAG_REPLIES_CLOSED, FLAG_REPLY_ELSEWHERE, flagRepliedWords, flagReplyWhoSees, flagUnrepliedWords, shownMoment } from '$lib/decision-words';

	let {
		decisionId,
		flags,
		mayReply,
		shownStatus
	}: {
		decisionId: number;
		/** Every objection and request to talk, oldest first, as the page was given them. */
		flags: ResultFlag[];
		/** Whether the caller may reply now: the current decider alone, with board edit. */
		mayReply: boolean;
		/** The decision's shown status: an objection is answered only before the ruling. */
		shownStatus: string;
	} = $props();

	const id = $props.id();
	const TEXT_MAX = REPLY_TEXT_RULE.max;

	const unansweredObjection = (flag: ResultFlag) => flag.kind === 'objection' && flag.reply === null;
	/** Unanswered objections first, the order otherwise kept (R23). */
	const ordered = $derived([...flags.filter(unansweredObjection), ...flags.filter((flag) => !unansweredObjection(flag))]);
	const beforeRuling = $derived(shownStatus === 'open' || shownStatus === 'awaiting_ruling');
	/** Whether the caller may reply to this flag now (R7). */
	const replyable = (flag: ResultFlag) => mayReply && flag.reply === null && (flag.kind === 'talk' || beforeRuling);
	const unreplied = $derived(flags.some((flag) => flag.reply === null));
	/** Withdrawn: nobody replies any more, the decider among them, so that is what is said (code review C-E-L1). */
	const repliesClosed = $derived(shownStatus === 'withdrawn' && unreplied);
	/**
	 * Whether anything here waits for a reply the caller may not give: then who gives it is said, unless replies are
	 * closed, which is said in its place. Only a viewer who is not the decider is not given `mayReply` on a decision that
	 * is not withdrawn: the page gives the decider who has lost board edit no results, and no status but withdrawn (and a
	 * draft, which has none) refuses the decider a reply.
	 */
	const waitsOnAnother = $derived(!mayReply && unreplied);

	let replies = $state<Record<number, string>>({});
	let sending = $state<number | null>(null);
	/** What was done, or the last refusal, said in the status region. */
	let said = $state<{ refused: boolean; words: string } | null>(null);
	let saidRegion = $state<HTMLElement>();

	const ready = (flagId: number) => sending === null && (replies[flagId] ?? '').trim() !== '';

	async function send(flag: ResultFlag) {
		if (!ready(flag.flagId)) return;
		sending = flag.flagId;
		said = null;
		let recorded = false;
		let conflicted = false;
		try {
			const res = await fetch(`/api/decisions/${decisionId}/flags/${flag.flagId}/reply`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ reply: replies[flag.flagId] })
			});
			if (res.ok) {
				replies[flag.flagId] = '';
				said = { refused: false, words: flag.kind === 'objection' ? `Your answer to ${flag.name}'s objection was recorded.` : `The outcome of the talk with ${flag.name} was recorded.` };
				recorded = true;
			} else {
				said = { refused: true, words: await failureMessage(res, 'Your reply was not recorded.') };
				conflicted = res.status === 409;
			}
		} catch {
			said = { refused: true, words: 'No answer from the server. It is not known whether your reply was recorded.' };
		} finally {
			sending = null;
		}
		// The page's data read again: the list, and the revision a ruling sends (R10); after a 409 too, as the flag may have changed.
		if (recorded || conflicted) await invalidateAll();
		await tick();
		// Recorded, the box is gone, so the words take the focus; refused, it stays in the box, what was typed kept
		// (code review C-E-L5), unless the page read again has no box for the flag any more.
		const box = recorded ? null : document.getElementById(`${id}-${flag.flagId}`);
		(box ?? saidRegion)?.focus();
	}
</script>

<div class="flag-replies">
	{#if repliesClosed}
		<p class="note" data-note="replies-closed">{FLAG_REPLIES_CLOSED}</p>
	{:else if waitsOnAnother}
		<p class="note" data-note="reply-elsewhere">{FLAG_REPLY_ELSEWHERE}</p>
	{/if}
	<ul class="flags" data-list="flags">
		{#each ordered as flag (flag.flagId)}
			<li data-flag={flag.flagId} data-flag-kind={flag.kind}>
				<p class="line">
					<strong>{FLAG_KIND_WORDS[flag.kind]}</strong>
					<span>from <strong data-field="name">{flag.name}</strong></span>
					<span class="meta">{shownMoment(flag.raisedAt, '')}{flag.via === 'link' ? ', by link' : ''}, version {flag.versionNumber}</span>
				</p>
				{#if flag.reason !== ''}
					<p class="text" data-text="reason">{flag.reason}</p>
				{:else}
					<p class="meta">No note</p>
				{/if}
				{#if flag.reply !== null}
					<p class="meta" data-note="replied">{flagRepliedWords(flag.kind, flag.repliedByName)}, {shownMoment(flag.repliedAt, '')}:</p>
					<p class="text reply" data-text="reply">{flag.reply}</p>
				{:else if replyable(flag)}
					<form
						data-form="reply"
						onsubmit={(e) => {
							e.preventDefault();
							send(flag);
						}}
					>
						<p class="note" id="{id}-{flag.flagId}-who-sees" data-note="reply-who-sees">{flagReplyWhoSees(flag.name)}</p>
						<label class="field-label" for="{id}-{flag.flagId}">
							{flag.kind === 'objection' ? `Your answer to ${flag.name}'s objection` : `What came of the talk with ${flag.name}`}
						</label>
						<textarea
							id="{id}-{flag.flagId}"
							class="field"
							rows="3"
							maxlength={TEXT_MAX}
							required
							aria-describedby="{id}-{flag.flagId}-who-sees {id}-{flag.flagId}-count"
							bind:value={() => replies[flag.flagId] ?? '', (value) => (replies[flag.flagId] = value)}
						></textarea>
						<p class="count" id="{id}-{flag.flagId}-count">{(replies[flag.flagId] ?? '').length} of {TEXT_MAX.toLocaleString('en-GB')} characters</p>
						<button type="submit" class="btn btn-primary btn-sm" data-action="reply" disabled={!ready(flag.flagId)} aria-busy={sending === flag.flagId ? 'true' : undefined}
							>{flag.kind === 'objection' ? 'Send answer' : 'Record outcome'}</button
						>
					</form>
				{:else}
					<p class="meta" data-note="no-reply">{flagUnrepliedWords(flag.kind)}</p>
				{/if}
			</li>
		{/each}
	</ul>
	<!-- Drawn from the start, so a screen reader hears each change of its words; it takes the focus, the box used being gone. -->
	<p class="said" class:refused={said?.refused} role="status" data-said="flag-reply" tabindex="-1" bind:this={saidRegion}>{said?.words ?? ''}</p>
</div>

<style>
	.flag-replies { display: flex; flex-direction: column; gap: var(--space-sm); min-width: 0; }
	.flag-replies p { margin: 0; }
	.flags { margin: 0; padding-left: var(--space-lg); display: flex; flex-direction: column; gap: var(--space-md); font-size: 0.88rem; }
	.line { display: flex; flex-wrap: wrap; gap: var(--space-xs) var(--space-sm); align-items: baseline; overflow-wrap: anywhere; }
	.meta, .note { font-size: 0.82rem; color: var(--text-secondary); }
	.text { white-space: pre-wrap; overflow-wrap: anywhere; }
	.reply { padding-left: var(--space-md); border-left: 2px solid var(--glass-border); }
	form { display: flex; flex-direction: column; gap: var(--space-xs); margin-top: var(--space-xs); }
	.field-label { font-size: 0.82rem; color: var(--text-secondary); }
	.field {
		width: 100%; box-sizing: border-box; padding: var(--space-xs) var(--space-sm);
		border: 1px solid var(--glass-border); border-radius: var(--radius-sm);
		background: var(--bg-elevated); color: var(--text-primary); font-size: 16px; font-family: var(--font-family);
	}
	.count { font-size: 0.7rem; color: var(--text-tertiary); text-align: right; }
	button { align-self: flex-end; min-height: 44px; }
	.said { font-size: 0.85rem; color: var(--accent-emerald, var(--text-secondary)); min-height: 1em; }
	.said.refused { color: var(--accent-rose); }
</style>
