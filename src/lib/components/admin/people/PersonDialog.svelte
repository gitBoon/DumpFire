<!--
  PersonDialog.svelte — Add a person to the people directory, or change one
  (card 2674, plan 4.3): full name, email, job title, the account they are
  linked to, and their groups.

  Drawn by /admin/people. Saves through POST /api/people or PUT
  /api/people/:id, says a refusal in the server's words (`sentAsking`), and
  reads the page's data again once saved.

  A person's address and account decide where a decision's record mail and
  personal links go, so the server asks for the caller's own password with a
  change of either (card 2697, Q21), and with every new person, who is always
  given an address (the code review's part B, S1). A change sends `email` and
  `userId` only when they change (the address compared trimmed and in lower
  case, as it is stored), and with them `currentPassword`, from a field shown
  only then; a rename, a job title or groups send neither and ask nothing. A
  new person sends every field and the password. A refusal of the password
  keeps the dialog open, its words beside the field and the field cleared to
  type again.

  For a person who is not active, the address on file is shown above the
  field through `asciiShown` (card 3020, R3), each look-alike or hidden
  character as its code point. Marking them active is the page's, not this
  dialog's: it does not send `status`.
-->
<script lang="ts">
	import type { PageData } from '../../../../routes/admin/people/$types';
	import { untrack } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { sentAsking, showToast } from '$lib/admin/send';
	import CurrentPasswordField from '$lib/components/CurrentPasswordField.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import Dialog from '$lib/components/ui/Dialog.svelte';
	import { page } from '$app/state';
	import { codeAskedHere } from '$lib/code-asked';
	import { asksForPassword, passwordKeptAfter, proofTyped } from '$lib/step-up-words';
	import { asciiShown } from '$lib/printable';

	type DirectoryPerson = PageData['people'][number];

	let {
		data,
		person,
		onClose
	}: {
		/** What the page's load gave it: the people, groups and accounts. */
		data: PageData;
		/** The person to change, or null to add one. */
		person: DirectoryPerson | null;
		onClose: () => void;
	} = $props();

	// The form starts from the person as the dialog opened on them.
	const start = untrack(() => (person ? { ...person, groupIds: [...person.groupIds] } : null));
	let fullName = $state(start?.fullName ?? '');
	let email = $state(start?.email ?? '');
	let jobTitle = $state(start?.jobTitle ?? '');
	/** The account's id as the select's value, or '' for none. */
	let userId = $state(start?.userId != null ? String(start.userId) : '');
	let groupIds = $state<number[]>(start?.groupIds ? [...start.groupIds] : []);
	let saving = $state(false);

	/** The accounts this person may be linked to: those no other person has, and their own. */
	let linkable = $derived(data.accounts.filter((account) => account.personId === null || account.personId === start?.id));

	/** The caller's own password, asked for with a change of address or account: held here alone, and cleared once sent. */
	let currentPassword = $state('');
	/** The sign-in code typed beside it (card 2770), held and cleared as the password is. */
	let stepUpCode = $state('');
	/** The server's refusal of the last password sent, shown beside the field. */
	let refusal = $state<string | null>(null);

	/** A new person sends every field; a change sends the address and the account only where they change. */
	let emailChanged = $derived(start === null || email.trim().toLowerCase() !== start.email.toLowerCase());
	let accountChanged = $derived(start === null || userId !== (start.userId != null ? String(start.userId) : ''));
	/**
	 * Whether the server will ask for the password: a new person, who is given
	 * an address (card 2697's code review, part B, S1), or a change of a
	 * person's address or account (Q21).
	 */
	let asks = $derived(start === null || emailChanged || accountChanged);

	let canSave = $derived(fullName.trim() !== '' && email.trim() !== '' && (!asks || proofTyped(currentPassword, stepUpCode, page.data.codeAsked)));

	/**
	 * The address or the account changed back, so that nothing asks: the
	 * password and code typed for it go, as the field goes (card 2770, the code
	 * review's CR2). In the inputs' own handlers, which run after `bind:value`.
	 */
	function forgetProofIfNotAsked() {
		if (asks) return;
		currentPassword = '';
		stepUpCode = '';
	}

	function toggleGroup(groupId: number, on: boolean) {
		groupIds = on ? [...groupIds, groupId] : groupIds.filter((id) => id !== groupId);
	}

	async function save() {
		if (!canSave || saving) return;
		saving = true;
		const password = currentPassword;
		const currentCode = stepUpCode;
		currentPassword = '';
		stepUpCode = '';
		refusal = null;
		try {
			const res = await sentAsking(
				() =>
					fetch(start ? `/api/people/${start.id}` : '/api/people', {
						method: start ? 'PUT' : 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							fullName: fullName.trim(),
							email: emailChanged ? email.trim() : undefined,
							jobTitle: jobTitle.trim(),
							userId: accountChanged ? (userId === '' ? null : Number(userId)) : undefined,
							// Only groups still in the page's data: one another administrator deleted is dropped, not sent to be refused.
							groupIds: groupIds.filter((id) => data.groups.some((g) => g.id === id)),
							currentPassword: asks ? password : undefined,
							currentCode: asks ? currentCode : undefined
						})
					}),
				start ? 'The person was not saved' : 'The person was not added'
			);
			if (typeof res === 'string') {
				// A refusal of the password itself: the dialog stays, the field cleared to type again,
				// or kept for a refusal decided before it was compared (card 2771, D9).
				refusal = res;
				currentPassword = passwordKeptAfter(res, password);
				return;
			}
			if (!res) return;
			await invalidateAll();
			showToast(start ? 'Person saved' : 'Person added');
			onClose();
		} finally {
			saving = false;
		}
	}
</script>

{#snippet personActions()}
	<Button variant="outline" onclick={onClose}>Cancel</Button>
	<Button onclick={save} disabled={!canSave} aria-busy={saving ? 'true' : undefined}>{start ? 'Save' : 'Add Person'}</Button>
{/snippet}

<!-- Card 3078: the kit's frame, on the same focus rules. -->
<Dialog
	aria-label={start ? 'Edit Person' : 'Add Person'}
	title={start ? 'Edit Person' : 'Add Person'}
	size="md"
	class="person-dialog"
	footerClass="modal-actions"
	initialFocus="input"
	onEscape={onClose}
	footer={personActions}
>
	<div class="dialog-fields">
		<label class="dialog-field">
			<span class="ui-label">Full name</span>
			<input type="text" class="ui-input" bind:value={fullName} maxlength="200" />
		</label>
		{#if start && start.status !== 'active'}
			<!-- Card 3020 (R3): a person who is not active may hold an address a backup whose seal did not verify chose; shown as it is. -->
			<p class="ui-hint address-on-file">Address on file: {asciiShown(start.email)}</p>
		{/if}
		<label class="dialog-field">
			<span class="ui-label">Email</span>
			<input type="email" class="ui-input" bind:value={email} maxlength="254" oninput={forgetProofIfNotAsked} />
		</label>
		<label class="dialog-field">
			<span class="ui-label">Job title</span>
			<input type="text" class="ui-input" bind:value={jobTitle} maxlength="200" />
		</label>
		<label class="dialog-field">
			<span class="ui-label">Account</span>
			<select class="ui-select" bind:value={userId} onchange={forgetProofIfNotAsked}>
				<option value="">None</option>
				{#each linkable as account (account.id)}
					<option value={String(account.id)}>{account.emoji} {account.username} ({account.email})</option>
				{/each}
			</select>
		</label>
		<!-- Plan review R1: an account's address is its holder's own, and nobody has confirmed it. -->
		<p class="ui-hint">An account's address is set by its holder and is not confirmed: check it is this person before linking.</p>
		<fieldset class="dialog-field">
			<legend class="ui-label">Groups</legend>
			{#if data.groups.length === 0}
				<p class="ui-hint">No groups yet.</p>
			{:else}
				<div class="tick-list">
					{#each data.groups as group (group.id)}
						<label class="tick">
							<input type="checkbox" checked={groupIds.includes(group.id)} onchange={(e) => toggleGroup(group.id, e.currentTarget.checked)} />
							{group.name}
						</label>
					{/each}
				</div>
			{/if}
		</fieldset>
		{#if asks}
			<!-- Card 2697 (Q21, and the code review's part B, S1): an address or an account decides where decision mail and personal links go. -->
			<p class="ui-hint">
				{start ? "A new address or account changes where this person's decision mail and personal links go." : "This person's address and account decide where their decision mail and personal links go."}
				{asksForPassword(codeAskedHere())}
			</p>
			<CurrentPasswordField bind:value={currentPassword} bind:code={stepUpCode} {refusal} readonly={saving} onEnter={save} kit />
		{/if}
	</div>
</Dialog>

<style>
	/* Card 3076: the fields the kit's (ui-field.css), their names the kit's label. Card 3078: the frame and buttons the kit's dialog. */
	.dialog-fields { display: flex; flex-direction: column; gap: var(--space-md); }
	.dialog-field { display: flex; flex-direction: column; gap: 0.375rem; border: none; padding: 0; margin: 0; }
	.dialog-field legend { margin-bottom: var(--space-xs); padding: 0; }
	.dialog-fields .ui-hint { margin: 0; }
	/* The groups to tick: a bordered list that scrolls within itself. */
	.tick-list { display: flex; flex-wrap: wrap; gap: var(--space-xs) var(--space-md); max-height: 160px; overflow-y: auto; padding: var(--space-sm) var(--space-md); border: 1px solid var(--ui-border); border-radius: var(--ui-radius); }
	.tick { display: flex; align-items: center; gap: var(--space-xs); font-size: 0.8125rem; color: var(--ui-foreground); }
</style>
