<!--
  DeliveryPanel.svelte — how each participant of an opened decision has been
  mailed, in the editor's side column (card 2697, decision 21, Q13), shown to
  its author, its decider and administrators, whom the server hands
  `delivery` alone.

  Each row is a participant and the server's words for them: their latest
  record mail and how it went (sent, refused with the problem in words, not
  sent as a later change replaced it, not sent for no link address, or being
  sent), their latest skip, and their link's latest ending. Nothing of an
  address, a response or a total is handed over. A skip is shown only where
  it is newer than the latest mail (card 2740's code review): the server
  leaves an older one out, deciding a tie on the same moment by the record's
  order, and the panel never draws one older than the mail line above it.

  Resend is offered only where the server says `resendInvitation` would send
  now (`resendable`); where the rest or the daily cap holds a participant
  back, the moment it may, in UTC; otherwise the write's own words. Resend
  sends `POST …/resend` saying it is JSON, with no body (Q17). A refusal is
  said in the server's words on its row; a success hands the next revision
  up, and the page reads its data again.

  To an administrator alone, whom the server hands `directory` (B2b, Q9,
  Q22): Attach account (the account the people directory holds for the
  person), Clear account, and Use the directory's address, which names the
  address it will copy and sends none. Each is offered only where the server
  says the write would take it (`canAttach`, `canClear`,
  `canUseDirectoryAddress`: the writes' own rules, the code review's part B,
  F2), so the panel copies none of them. Each changes which credential
  answers for the participant, or where their record mail and next link go,
  so each goes through `ConfirmModal` asking for the caller's own password,
  sending `{ account, currentPassword, currentCode }` or `{ currentPassword,
  currentCode }` alone (card 2770). A
  refusal of the password keeps the dialog open, its words in it and the
  field cleared; any other refusal is said on the row, and the dialog closes.

  Its row and directory types are the edit page's own (F5). A row whose
  Resend goes once it is sent (the rest now holds it) hands the focus to the
  row itself, which says why (F6).
-->
<script lang="ts">
	import { tick } from 'svelte';
	import type { PageData } from '../../../routes/decisions/[id]/edit/$types';
	import { failureMessage } from '$lib/api';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import { ASKS_FOR_PASSWORD, stepUpRefusal, type StepUpProof } from '$lib/step-up-words';

	type Participant = PageData['participants'][number];
	/** What the server offers the administrator on a participant's row: an administrator's alone. */
	type DirectoryFact = NonNullable<PageData['directory']>[number];
	type Row = NonNullable<PageData['delivery']>[number];

	let {
		decisionId,
		participants,
		delivery,
		directory = null,
		onSaved
	}: {
		decisionId: number;
		/** Every participant row, through the server's projection: the names the rows are drawn with. */
		participants: Participant[];
		/** Each participant's delivery, as the server worked it out. */
		delivery: Row[];
		/** The people directory's address and account for each participant: handed to an administrator alone, else null. */
		directory?: DirectoryFact[] | null;
		/** A re-send or an administrator's change was taken: the decision's revision after it. */
		onSaved: (revision: string) => void | Promise<void>;
	} = $props();

	/** Each record mail by name. */
	const MAIL_NAMES: Readonly<Record<string, string>> = {
		invitation: 'Invitation',
		asked_again: 'Asked again',
		told_of_change: 'Told of a change',
		withdrawn: 'Told of the withdrawal',
		ruling: 'Told of the ruling'
	};

	/** A stored moment as shown: to the minute, in UTC, as stored (no `Date` is made of it). */
	const shown = (at: string) => `${at.slice(0, 16)} UTC`;

	function outcomeWords(mail: NonNullable<Row['lastMail']>): string {
		switch (mail.outcome) {
			case 'sent':
				return 'sent';
			case 'failed':
				return `not sent: ${mail.problem ?? 'the mail could not be sent'}`;
			case 'superseded':
				return 'not sent: a later change replaced it';
			case 'no_link_address':
				return 'not sent: this server has no address to make the link on';
			case 'pending':
				return 'being sent';
		}
	}

	const named = $derived(new Map(participants.map((p) => [p.id, p])));

	/** The refusal of the last Resend on each row, in the server's words. */
	let refused = $state<Record<number, string>>({});
	let sending = $state<number | null>(null);

	/** The panel, where a row is found by its participant: where the focus goes when the row's Resend goes (F6). */
	let panelElement = $state<HTMLElement>();

	/**
	 * After a Resend, the button may be gone from its row, once the page's data
	 * is read again and the rest holds the participant: the focus, which was on
	 * it, would fall to the page. It goes to the row instead, which says from
	 * when they may be mailed again (F6). A button still there keeps it.
	 */
	async function keepFocusOn(participantId: number) {
		await tick();
		const row = panelElement?.querySelector<HTMLElement>(`[data-participant="${participantId}"]`);
		if (!row || row.querySelector('[data-action="resend"]')) return;
		if (document.activeElement === null || document.activeElement === document.body || !document.contains(document.activeElement)) row.focus();
	}

	async function resend(participantId: number) {
		if (sending !== null) return;
		sending = participantId;
		refused = { ...refused, [participantId]: '' };
		try {
			const res = await fetch(`/api/decisions/${decisionId}/participants/${participantId}/resend`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' }
			});
			if (res.ok) {
				const answer = (await res.json()) as { revision: string };
				await onSaved(answer.revision);
			} else {
				refused = { ...refused, [participantId]: await failureMessage(res, 'The invitation was not sent again.') };
			}
		} catch {
			refused = { ...refused, [participantId]: 'No answer from the server. It is not known whether the invitation was sent again.' };
		} finally {
			sending = null;
		}
		await keepFocusOn(participantId);
	}

	// ─── The administrator's actions (B2b) ───────────────────────────────────

	const facts = $derived(new Map((directory ?? []).map((fact) => [fact.participantId, fact])));

	/** What the server offers the administrator on a row (F2): nothing where it handed no fact. */
	function offers(fact: DirectoryFact | undefined): { attach: boolean; clear: boolean; address: string | null } {
		if (!fact) return { attach: false, clear: false, address: null };
		return { attach: fact.canAttach, clear: fact.canClear, address: fact.canUseDirectoryAddress ? fact.directoryAddress : null };
	}

	type Asking = { action: 'attach' | 'clear' | 'address'; participantId: number; name: string; address: string | null };
	/** The administrator's action waiting on its confirmation and password. */
	let asking = $state<Asking | null>(null);

	const confirmTitle = (a: Asking) => (a.action === 'attach' ? 'Attach account' : a.action === 'clear' ? 'Clear account' : "Use the directory's address");
	function confirmMessage(a: Asking): string {
		if (a.action === 'attach') {
			return `${a.name} will be reached through the account the people directory holds for them, and their personal link ends. ${ASKS_FOR_PASSWORD}`;
		}
		if (a.action === 'clear') return `${a.name}'s account is cleared from this decision: they are reached by a personal link from now on. ${ASKS_FOR_PASSWORD}`;
		return `${a.name}'s address on this decision becomes ${a.address}, the one the people directory holds. Their personal link ends; nothing is sent. ${ASKS_FOR_PASSWORD}`;
	}

	/**
	 * Send the action with the password typed. A refusal of the password is
	 * given back for the dialog to show; any other answer closes it, a refusal
	 * said on the row.
	 */
	async function confirmAction(a: Asking, proof: StepUpProof): Promise<string | void> {
		const { currentPassword, currentCode } = proof;
		let res: Response;
		try {
			if (a.action === 'address') {
				res = await fetch(`/api/decisions/${decisionId}/participants/${a.participantId}/address`, {
					method: 'PUT',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ currentPassword, currentCode })
				});
			} else {
				const account = a.action === 'attach' ? 'person' : 'none';
				res = await fetch(`/api/decisions/${decisionId}/participants/${a.participantId}/account`, {
					method: 'PUT',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ account, currentPassword, currentCode })
				});
			}
		} catch {
			asking = null;
			refused = { ...refused, [a.participantId]: 'No answer from the server. It is not known whether this was done.' };
			return;
		}
		const refusal = await stepUpRefusal(res);
		if (refusal !== null) return refusal;
		asking = null;
		if (res.ok) {
			refused = { ...refused, [a.participantId]: '' };
			const answer = (await res.json()) as { revision: string };
			await onSaved(answer.revision);
		} else {
			refused = { ...refused, [a.participantId]: await failureMessage(res, 'Nothing was changed.') };
		}
	}
</script>

<section class="delivery" aria-labelledby="delivery-heading" bind:this={panelElement}>
	<h3 id="delivery-heading">Delivery</h3>
	{#if delivery.length === 0}
		<p class="note">Nobody is on this decision.</p>
	{:else}
		<ul>
			{#each delivery as row (row.participantId)}
				{@const who = named.get(row.participantId)}
				<li class="delivery-row" data-participant={row.participantId} tabindex="-1">
					<div class="who">
						<span class="name">{who?.name ?? 'A participant'}</span>
						{#if who}<span class="role">{who.removedAt === null ? who.role : 'removed'}</span>{/if}
					</div>
					{#if row.lastMail}
						<p class="line" data-line="mail">
							{MAIL_NAMES[row.lastMail.mail] ?? 'A mail'}{row.lastMail.resend ? ', sent again' : ''}, {shown(row.lastMail.at)}: {outcomeWords(row.lastMail)}
						</p>
					{:else}
						<p class="line note" data-line="mail">Not mailed yet</p>
					{/if}
					{#if row.lastSkip && (row.lastMail === null || row.lastSkip.at >= row.lastMail.at)}
						<p class="line flag" data-line="skip">{MAIL_NAMES[row.lastSkip.mail] ?? 'A mail'} not sent, {shown(row.lastSkip.at)}: {row.lastSkip.words}</p>
					{/if}
					{#if row.lastRevoked}
						<p class="line" data-line="revoked">{row.lastRevoked.words}, {shown(row.lastRevoked.at)}</p>
					{/if}
					{#if row.resendable}
						<button type="button" class="btn btn-ghost btn-xs" data-action="resend" disabled={sending !== null} onclick={() => resend(row.participantId)}>
							{sending === row.participantId ? 'Sending…' : 'Resend'}
						</button>
					{:else if row.resendFrom}
						<p class="line note" data-line="from">Resend from {shown(row.resendFrom)}</p>
					{:else if row.refusal}
						<p class="line note" data-line="refusal">{row.refusal}</p>
					{/if}
					{#if directory !== null}
						{@const offer = offers(facts.get(row.participantId))}
						{#if offer.attach || offer.clear || offer.address !== null}
							<div class="admin-actions" data-actions="admin">
								{#if offer.attach}
									<button type="button" class="btn btn-ghost btn-xs" onclick={() => (asking = { action: 'attach', participantId: row.participantId, name: who?.name ?? 'This participant', address: null })}>
										Attach account
									</button>
								{/if}
								{#if offer.clear}
									<button type="button" class="btn btn-ghost btn-xs" onclick={() => (asking = { action: 'clear', participantId: row.participantId, name: who?.name ?? 'This participant', address: null })}>
										Clear account
									</button>
								{/if}
								{#if offer.address !== null}
									<button
										type="button"
										class="btn btn-ghost btn-xs"
										onclick={() => (asking = { action: 'address', participantId: row.participantId, name: who?.name ?? 'This participant', address: offer.address })}
									>
										Use the directory's address
									</button>
								{/if}
							</div>
						{/if}
					{/if}
					{#if refused[row.participantId]}
						<p class="delivery-error" role="alert">{refused[row.participantId]}</p>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</section>

{#if asking}
	{@const a = asking}
	<ConfirmModal
		title={confirmTitle(a)}
		message={confirmMessage(a)}
		confirmText={confirmTitle(a)}
		confirmDanger={false}
		askPassword
		onConfirm={(proof: StepUpProof) => confirmAction(a, proof)}
		onCancel={() => (asking = null)}
	/>
{/if}

<style>
	.delivery h3 { font-size: 0.9rem; margin: 0 0 var(--space-sm); }
	ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-sm); }
	.delivery-row { display: flex; flex-direction: column; gap: 2px; font-size: 0.8rem; padding-bottom: var(--space-xs); border-bottom: 1px solid var(--glass-border); }
	.delivery-row button { align-self: flex-start; }
	.admin-actions { display: flex; flex-wrap: wrap; gap: var(--space-xs); }
	.who { display: flex; align-items: baseline; gap: var(--space-xs); }
	.name { font-weight: 600; }
	.role { font-size: 0.72rem; color: var(--text-tertiary); }
	.line { margin: 0; font-size: 0.75rem; color: var(--text-secondary); }
	.note { color: var(--text-tertiary); }
	.flag { color: var(--accent-rose); }
	.delivery-error { font-size: 0.78rem; color: var(--accent-rose); margin: var(--space-xs) 0 0; }
</style>
