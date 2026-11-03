<!--
  FromAccountsDialog.svelte — Add from accounts (card 2674, plan 4.3): a
  person for each account ticked, named by its username, with its address and
  linked to it.

  Every account no person is linked to is listed, unticked: the administrator
  ticks each on purpose, as its address is its holder's own and unconfirmed
  (code review S1). One whose address is a person's cannot be ticked: Add from accounts
  never links an existing person, as an account's address is its holder's
  own and unconfirmed, and that person is linked by hand from their own form
  (plan decision 13). The server skips such an account whatever is sent.

  Drawn by /admin/people. Sends POST /api/people/from-accounts, and says in a
  toast how many were added and each account skipped, with why.
-->
<script lang="ts">
	import type { PageData } from '../../../../routes/admin/people/$types';
	import { invalidateAll } from '$app/navigation';
	import { answerBody } from '$lib/api';
	import { sent, showToast } from '$lib/admin/send';
	import { holdFocus } from '$lib/dialog-focus';

	let {
		data,
		onClose
	}: {
		/** What the page's load gave it: the people and the accounts. */
		data: PageData;
		onClose: () => void;
	} = $props();

	/** Each account no person is linked to, with the person whose address it has, if any. */
	let offered = $derived(
		data.accounts
			.filter((account) => account.personId === null)
			.map((account) => ({
				...account,
				matches: data.people.find((p) => p.email.toLowerCase() === account.email.toLowerCase()) ?? null
			}))
	);

	/** The accounts ticked: none as the dialog opens, each ticked on purpose. */
	let ticked = $state<number[]>([]);
	let saving = $state(false);

	function toggle(userId: number, on: boolean) {
		ticked = on ? [...ticked, userId] : ticked.filter((id) => id !== userId);
	}

	/** An account's username, for what the toast says of it. */
	const usernameOf = (userId: number) => data.accounts.find((a) => a.id === userId)?.username ?? `account ${userId}`;

	/** Why an account was skipped, with the person its address matches named rather than numbered; the server's words if no name is found. */
	function reasonOf(reason: string): string {
		const match = /^address matches person (\d+); link by hand$/.exec(reason);
		if (!match) return reason;
		const person = data.people.find((p) => p.id === Number(match[1]));
		return person ? `address matches person ${person.fullName}; link by hand` : reason;
	}

	async function add() {
		if (ticked.length === 0 || saving) return;
		saving = true;
		try {
			const res = await sent(
				() =>
					fetch('/api/people/from-accounts', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ userIds: ticked })
					}),
				'No one was added'
			);
			if (!res) return;
			const answer = await answerBody(res);
			const created = typeof answer?.created === 'number' ? answer.created : 0;
			const skipped = Array.isArray(answer?.skipped) ? (answer.skipped as { userId: number; reason: string }[]) : [];
			await invalidateAll();
			const added = `${created} ${created === 1 ? 'person' : 'people'} added from accounts`;
			if (skipped.length === 0) {
				showToast(added);
			} else {
				// A skip stays until it is closed, with why for each.
				showToast(`${added}, ${skipped.length} skipped: ${skipped.map((s) => `${usernameOf(s.userId)} (${reasonOf(s.reason)})`).join('; ')}`, 'warning');
			}
			onClose();
		} finally {
			saving = false;
		}
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="modal-overlay" role="dialog" aria-modal="true" aria-label="Add from Accounts">
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div class="modal-content from-accounts-dialog" onclick={(e) => e.stopPropagation()} role="document" use:holdFocus={{ first: '.modal-actions .btn-ghost', onEscape: onClose }}>
		<h2>Add from Accounts</h2>
		<p class="dialog-hint">Each account ticked becomes a person named by its username, with its address, linked to it.</p>
		<!-- Code review S1: an account's address is its holder's own, and nobody has confirmed it. -->
		<p class="dialog-hint">An account's address is set by its holder and is not confirmed: check each is the person you mean before adding them.</p>
		{#if offered.length === 0}
			<p class="empty-msg">Every account is already linked to a person.</p>
		{:else}
			<div class="account-list">
				{#each offered as account (account.id)}
					<label class="account-row" class:matched={account.matches !== null}>
						<input
							type="checkbox"
							checked={account.matches === null && ticked.includes(account.id)}
							disabled={account.matches !== null}
							onchange={(e) => toggle(account.id, e.currentTarget.checked)}
						/>
						<span class="account-name">{account.emoji} {account.username}</span>
						<span class="account-email">{account.email}</span>
						{#if account.matches}
							<span class="account-match">matches person {account.matches.fullName}: link by hand</span>
						{/if}
					</label>
				{/each}
			</div>
		{/if}
		<div class="modal-actions">
			<button class="btn-ghost" onclick={onClose}>Cancel</button>
			<button class="btn-primary" onclick={add} disabled={ticked.length === 0} aria-busy={saving ? 'true' : undefined}>
				Add {ticked.length} {ticked.length === 1 ? 'person' : 'people'}
			</button>
		</div>
	</div>
</div>

<style>
	.from-accounts-dialog { max-width: 600px; width: 100%; }
	.from-accounts-dialog h2 { font-size: 1.1rem; margin-bottom: var(--space-sm); }
	.dialog-hint { font-size: 0.8rem; color: var(--text-secondary); margin-bottom: var(--space-lg); }
	.empty-msg { font-size: 0.85rem; color: var(--text-tertiary); text-align: center; padding: var(--space-xl); }
	.account-list { display: flex; flex-direction: column; gap: 2px; max-height: 320px; overflow-y: auto; margin-bottom: var(--space-xl); }
	.account-row { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-sm); padding: var(--space-xs) 0; font-size: 0.82rem; }
	.account-row.matched { color: var(--text-tertiary); }
	.account-name { font-weight: 600; }
	.account-email { color: var(--text-tertiary); font-size: 0.75rem; }
	.account-match { font-size: 0.75rem; color: var(--accent-amber); }
	.modal-actions { display: flex; justify-content: flex-end; gap: var(--space-md); }
</style>
