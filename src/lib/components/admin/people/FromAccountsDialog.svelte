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

  Each person made is linked to an account and given its address, which
  decide where a decision's record mail and personal links go, so the server
  asks for the caller's own password (card 2697's code review, part B, S1):
  sent as `currentPassword` from the field here, cleared once sent. A refusal
  of the password keeps the dialog open, its words beside the field.
-->
<script lang="ts">
	import type { PageData } from '../../../../routes/admin/people/$types';
	import { invalidateAll } from '$app/navigation';
	import { answerBody } from '$lib/api';
	import { sentAsking, showToast } from '$lib/admin/send';
	import CurrentPasswordField from '$lib/components/CurrentPasswordField.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import Dialog from '$lib/components/ui/Dialog.svelte';
	import { page } from '$app/state';
	import { codeAskedHere } from '$lib/code-asked';
	import { asksForPassword, passwordKeptAfter, proofTyped } from '$lib/step-up-words';

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

	/** The caller's own password: held here alone, and cleared once sent. */
	let currentPassword = $state('');
	/** The sign-in code typed beside it (card 2770), held and cleared as the password is. */
	let stepUpCode = $state('');
	/** The server's refusal of the last password sent, shown beside the field. */
	let refusal = $state<string | null>(null);

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
		if (ticked.length === 0 || !proofTyped(currentPassword, stepUpCode, page.data.codeAsked) || saving) return;
		saving = true;
		const password = currentPassword;
		const currentCode = stepUpCode;
		currentPassword = '';
		stepUpCode = '';
		refusal = null;
		try {
			const res = await sentAsking(
				() =>
					fetch('/api/people/from-accounts', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ userIds: ticked, currentPassword: password, currentCode })
					}),
				'No one was added'
			);
			if (typeof res === 'string') {
				// A refusal of the password itself: the dialog stays, the field cleared to type again,
				// or kept for a refusal decided before it was compared (card 2771, D9).
				refusal = res;
				currentPassword = passwordKeptAfter(res, password);
				return;
			}
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

{#snippet accountsActions()}
	<Button variant="outline" class="accounts-cancel" onclick={onClose}>Cancel</Button>
	<Button onclick={add} disabled={ticked.length === 0 || !proofTyped(currentPassword, stepUpCode, page.data.codeAsked)} aria-busy={saving ? 'true' : undefined}>
		Add {ticked.length} {ticked.length === 1 ? 'person' : 'people'}
	</Button>
{/snippet}

<!-- Card 3078: the kit's frame, on the same focus rules. -->
<Dialog
	aria-label="Add from Accounts"
	title="Add from Accounts"
	size="md"
	class="from-accounts-dialog"
	footerClass="modal-actions"
	initialFocus=".modal-actions .accounts-cancel"
	onEscape={onClose}
	footer={accountsActions}
>
	<p class="ui-hint">Each account ticked becomes a person named by its username, with its address, linked to it.</p>
	<!-- Code review S1: an account's address is its holder's own, and nobody has confirmed it. -->
	<p class="ui-hint">An account's address is set by its holder and is not confirmed: check each is the person you mean before adding them.</p>
	{#if offered.length === 0}
		<p class="dialog-empty">Every account is already linked to a person.</p>
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
		<!-- The code review's part B, S1: each person made is given an account and its address. -->
		<p class="ui-hint">Each account's address decides where that person's decision mail and personal links go. {asksForPassword(codeAskedHere())}</p>
		<CurrentPasswordField bind:value={currentPassword} bind:code={stepUpCode} {refusal} readonly={saving} onEnter={add} kit />
	{/if}
</Dialog>

<style>
	/* Card 3076: the kit's colours. Card 3078: the frame and buttons the kit's dialog. */
	.dialog-empty { font-size: 0.875rem; color: var(--ui-muted-foreground); text-align: center; padding: var(--space-xl); }
	/* The accounts to tick: a bordered list that scrolls within itself. */
	.account-list { display: flex; flex-direction: column; gap: 2px; max-height: 320px; overflow-y: auto; padding: var(--space-sm) var(--space-md); border: 1px solid var(--ui-border); border-radius: var(--ui-radius); }
	.account-row { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-sm); padding: var(--space-xs) 0; font-size: 0.82rem; }
	.account-row.matched { color: var(--ui-muted-foreground); }
	.account-name { font-weight: 600; }
	.account-email { color: var(--ui-muted-foreground); font-size: 0.75rem; }
	/* Said in the text colour, marked by its edge (F3). */
	.account-match { padding-left: 0.375rem; border-left: 2px solid var(--ui-warning); font-size: 0.75rem; color: var(--ui-foreground); }
</style>
