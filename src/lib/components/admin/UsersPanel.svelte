<!--
  UsersPanel.svelte — The admin page's User Management: Add User, and each
  account's row with what the caller may do to it, its role, 🔑, 📧 and 🗑️
  (card 2281, slice C1b: moved from src/routes/admin/+page.svelte).

  Shown to every administrator. The password dialog is drawn after the
  section, as it was on the page, and 🔑 opens it through `bind:this`. The
  link of an invite whose mail was not sent is the page's (`inviteLink`,
  bound here): its dialog is drawn by the page where it was, after the
  page's own dialogs. Delete asks first through the page's confirm dialog,
  and after an invite the mail panel is read again through the page.
-->
<script lang="ts">
	import type { PageData } from '../../../routes/admin/$types';
	import { untrack } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { answerBody, failureMessage, userDeleteWarning } from '$lib/api';
	import { mayManageAccount } from '$lib/account-rule';
	import { NO_ANSWER, sent, showToast } from '$lib/admin/send';
	import EmojiPicker from '$lib/components/EmojiPicker.svelte';
	import { toasts } from '$lib/stores/toast';
	import ResetPasswordDialog from './ResetPasswordDialog.svelte';

	let {
		data,
		isSuperadmin,
		confirm,
		loadMailStatus,
		inviteLink = $bindable()
	}: {
		/** What the admin page's load gave it, passed on as it is. */
		data: PageData;
		isSuperadmin: boolean;
		/** The page's confirm dialog, which asks before an account is deleted. */
		confirm: (title: string, message: string, action: () => Promise<void>) => void;
		/** The mail panel's own read of what mail has done, which the page draws for every administrator (card 2395). */
		loadMailStatus: () => void;
		/**
		 * The page's: the link of an invite whose mail was not sent, which its
		 * dialog shows, and the control the focus goes back to after Done (card
		 * 2365's review: + Add User for Create, or the row's 📧).
		 */
		inviteLink: { url: string; username: string; message: string; returnTo?: HTMLElement } | null;
	} = $props();

	/**
	 * + Add User: where the focus goes back to once an invite link from Create
	 * is dismissed. Create itself is off while the invite is out and gone with
	 * the form once it is answered, so the dialog found the focus on nothing.
	 */
	let addUserButton = $state<HTMLButtonElement>();

	/** The password dialog, opened by 🔑. */
	let resetDialog = $state<ReturnType<typeof ResetPasswordDialog>>();

	// ─── User Management ──────────────────────────────────────────────────

	let showCreateUser = $state(false);
	let newUsername = $state('');
	let newEmail = $state('');
	let newPassword = $state('');
	let newUserRole = $state('user');
	let newUserEmoji = $state('👤');
	let creatingUser = $state(false);

	/**
	 * The one invite out at a time (card 2196, R-S5): the account a 📧 was
	 * pressed for, or 'new' for Create User with no password. While it is set
	 * every 📧 and Create User are disabled, and the pressed 📧 reads "…". An
	 * invite now waits for its mail, a second or two, and a second press used
	 * to issue a second invite, which ends the first one's link.
	 */
	let inviteInFlight = $state<number | 'new' | null>(null);

	async function createUser() {
		if (!newUsername.trim() || !newEmail.trim()) return;
		// Password required if non-empty, must be 8+ chars
		if (newPassword && newPassword.length < 8) {
			showToast('Password must be at least 8 characters', 'error');
			return;
		}
		if (inviteInFlight !== null || inviteLink !== null) return;
		const started = toasts.navigation();
		creatingUser = true;
		// With no password an invite is issued, and its mail waited for.
		if (!newPassword) inviteInFlight = 'new';
		try {
			const body: Record<string, unknown> = {
				username: newUsername.trim(),
				email: newEmail.trim(),
				emoji: newUserEmoji,
				role: newUserRole
			};
			if (newPassword) body.password = newPassword;
			// A refusal is read with failureMessage: a proxy's page in place of
			// one used to make the page's own reading of it throw.
			const res = await sent(
				() =>
					fetch('/api/users', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify(body)
					}),
				'Failed to create user'
			);
			if (!res) return;
			const result = await answerBody(res);
			showCreateUser = false;
			const made = typeof result?.username === 'string' ? result.username : newUsername.trim();
			newUsername = ''; newEmail = ''; newPassword = ''; newUserRole = 'user'; newUserEmoji = '👤';
			await invalidateAll();
			// The user was made either way. Its invite mail not sent: the link,
			// for the caller to pass on (card 2196), and never "invite email sent!".
			if (result?.mailSent === false) {
				const said = `User ${made} was made, but the invite mail could not be sent: ${result.mailProblem}.`;
				if (typeof result.inviteUrl === 'string') {
					inviteLink = { url: result.inviteUrl, username: made, message: said, returnTo: addUserButton };
				} else {
					showToast(`${said} Send a new invite with 📧 once mail works.`, 'error', started);
				}
				return;
			}
			showToast(result?.invited ? 'User created — invite email sent!' : 'User created');
		} finally {
			creatingUser = false;
			inviteInFlight = null;
			// The panel the dialog points to, read again so it shows this mail:
			// every administrator's since card 2395.
			loadMailStatus();
		}
	}

	/**
	 * The role chosen in each account's picker and not yet saved, by account
	 * (card 2376). Choosing sends nothing: on Windows, Up and Down on a closed
	 * picker change it at once, and the picker saved every role arrowed past,
	 * Admin included. Change sends the one chosen. The picker shows it until
	 * it is saved or put back, the account is deleted, or a re-read drops it.
	 */
	let chosenRole = $state(new Map<number, string>());

	function setChosen(userId: number, role: string | null) {
		const next = new Map(chosenRole);
		if (role === null) next.delete(userId);
		else next.set(userId, role);
		chosenRole = next;
	}

	/**
	 * The accounts whose role change is out, each with its name for the status
	 * line. A second Change meanwhile sends nothing (card 2376: a second
	 * choice was sent while the first was out). The picker and Change are
	 * marked busy rather than turned off, which would drop the keyboard's
	 * focus to the page.
	 */
	let changingRole = $state(new Map<number, string>());

	function markChanging(userId: number, username: string | null) {
		const next = new Map(changingRole);
		if (username === null) next.delete(userId);
		else next.set(userId, username);
		changingRole = next;
	}

	/** What a screen reader is told while a change is out (card 2376), politely; the toast says how it ended. */
	let savingSaid = $derived([...changingRole.values()].map((name) => `Saving ${name}'s role…`).join(' '));

	/** The role the page's data gives the account now. */
	function storedUserRole(userId: number): string | undefined {
		return data.users.find((u) => u.id === userId)?.role;
	}

	/**
	 * A role chosen and not saved is dropped when the page's data is read
	 * again and the account is gone or already has it (the card 2376 review,
	 * as on the team pages: the choice outlived the row). A choice whose change
	 * is out is left to that change, which clears it as it ends.
	 */
	$effect.pre(() => {
		const accounts = data.users;
		untrack(() => {
			const stale = [...chosenRole].filter(([userId, role]) => {
				if (changingRole.has(userId)) return false;
				const stored = accounts.find((u) => u.id === userId)?.role;
				return stored === undefined || stored === role;
			});
			if (stale.length === 0) return;
			const next = new Map(chosenRole);
			for (const [userId] of stale) next.delete(userId);
			chosenRole = next;
		});
	});

	/** A role chosen in a row's picker, kept for Change. While its change is out, another choice goes back to the role being saved. */
	function chooseUserRole(userId: number, select: HTMLSelectElement) {
		if (changingRole.has(userId)) {
			select.value = chosenRole.get(userId) ?? select.value;
			return;
		}
		setChosen(userId, select.value === storedUserRole(userId) ? null : select.value);
	}

	/**
	 * Change: saves the role chosen in the row's picker. Refused or not
	 * answered, the picker shows the role the account has again.
	 */
	async function changeUserRole(userId: number, username: string) {
		const newRole = chosenRole.get(userId);
		if (changingRole.has(userId) || newRole === undefined) return;
		if (newRole === storedUserRole(userId)) {
			setChosen(userId, null);
			return;
		}
		const putBack = () => setChosen(userId, null);
		const started = toasts.navigation();
		markChanging(userId, username);
		try {
			let res: Response;
			try {
				res = await fetch(`/api/users/${userId}`, {
					method: 'PUT',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ role: newRole })
				});
			} catch {
				putBack();
				showToast(NO_ANSWER, 'error', started);
				return;
			}
			if (res.ok) {
				// A change of role ends any invite to the account not yet used: it
				// was sent to the account as it was. The answer says how many.
				const result = await answerBody(res);
				const invitesEnded = result?.invitesEnded;
				await invalidateAll();
				setChosen(userId, null);
				showToast(
					typeof invitesEnded === 'number' && invitesEnded > 0
						? 'Role updated. The invite sent to this account earlier no longer works: send a new one with 📧.'
						: 'Role updated'
				);
			} else {
				putBack();
				showToast(await failureMessage(res, 'Failed to update role'), 'error', started);
			}
		} finally {
			markChanging(userId, null);
		}
	}

	/**
	 * The teams the account is the only owner of, from the page's data, by
	 * name and then id, as the delete's refusal names them (card 2377): an
	 * owner row of theirs and no other owner in the team. For the
	 * confirmation, which says the delete will be refused (card 2380).
	 */
	function soleOwnerOf(userId: number): string[] {
		return data.teams
			.filter((team) => {
				const owners = team.members.filter((m) => m.role === 'owner');
				return owners.length > 0 && owners.every((m) => m.userId === userId);
			})
			.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id - b.id))
			.map((team) => team.name);
	}

	async function deleteUser(userId: number) {
		if (!(await sent(() => fetch(`/api/users/${userId}`, { method: 'DELETE' }), 'Failed to delete user'))) return;
		// A role chosen for the account and not saved goes with it (the card 2376 review).
		setChosen(userId, null);
		await invalidateAll();
		showToast('User deleted');
	}

	/**
	 * 📧: a new invite, which ends the account's earlier one. The server waits
	 * for its mail and says whether it went (card 2196): sent, the toast; not
	 * sent, the dialog with the link to pass on, or, where the server could no
	 * longer show it, the server's words in a toast that stays. "Invite sent"
	 * only for an answer that says `mailSent: true`. Either way the mail panel
	 * is read again, so it shows this mail.
	 */
	async function resendInvite(userId: number, control?: HTMLElement) {
		if (inviteInFlight !== null || inviteLink !== null) return;
		const started = toasts.navigation();
		inviteInFlight = userId;
		try {
			const res = await sent(() => fetch(`/api/users/${userId}/invite`, { method: 'POST' }), 'Failed to send invite');
			if (!res) return;
			const result = await answerBody(res);
			const said = typeof result?.message === 'string' ? result.message : '';
			if (result?.mailSent === false) {
				if (typeof result.inviteUrl === 'string') {
					const username = data.users.find((u) => u.id === userId)?.username ?? 'this user';
					inviteLink = { url: result.inviteUrl, username, message: said, returnTo: control };
				} else {
					showToast(said || 'The invite was made, but its mail could not be sent.', 'error', started);
				}
				return;
			}
			if (result?.mailSent === true) {
				showToast(said || 'Invite sent!');
				return;
			}
			// An answer that says neither is not taken as a mail that went.
			showToast('The invite was made, but the answer did not say whether its mail was sent.', 'error', started);
		} finally {
			inviteInFlight = null;
			// The panel the dialog points to, read again so it shows this mail:
			// every administrator's since card 2395.
			loadMailStatus();
		}
	}
</script>

<!-- User Management -->
<section class="admin-card glass fade-in-up" style="animation-delay: 200ms">
	<div class="section-header">
		<h2>👥 User Management</h2>
		<button class="btn-primary btn-sm" onclick={() => (showCreateUser = true)} bind:this={addUserButton}>+ Add User</button>
	</div>
	<!-- A role being saved, said politely to a screen reader (card 2376). -->
	<p class="saving-status" role="status">{savingSaid}</p>
	<p class="section-desc">Each row shows only what you may do to that account. Only the superadmin changes an administrator's account, and nobody else changes the superadmin's: those rows show 🔒. On your own row there is only 🔑, to change your password.</p>

	{#if showCreateUser}
		<div class="inline-form">
			<div class="form-row">
				<input type="text" placeholder="Username" bind:value={newUsername} class="form-input" />
				<input type="email" placeholder="Email" bind:value={newEmail} class="form-input" />
				<input type="password" placeholder="Password (blank = send invite)" bind:value={newPassword} class="form-input" />
			</div>
			<div class="form-row">
				<EmojiPicker value={newUserEmoji} onSelect={(e) => (newUserEmoji = e)} />
				<select bind:value={newUserRole} class="form-input">
					<option value="user">User</option>
					{#if isSuperadmin}<option value="admin">Admin</option>{/if}
				</select>
				<button class="btn-primary btn-sm" onclick={createUser} disabled={creatingUser || inviteInFlight !== null || inviteLink !== null || !newUsername || !newEmail}>
					{creatingUser ? 'Creating...' : 'Create'}
				</button>
				<button class="btn-ghost btn-sm" onclick={() => (showCreateUser = false)}>Cancel</button>
			</div>
		</div>
	{/if}

	{#if data.users.length === 0}
		<p class="empty-msg">No users yet.</p>
	{:else}
		<div class="user-list">
			{#each data.users as u (u.id)}
				<div class="user-row">
					<span class="user-row-emoji">{u.emoji}</span>
					<div class="user-row-info">
						<span class="user-row-name">{u.username}</span>
						<span class="user-row-email">{u.email}</span>
					</div>
					<span class="role-badge role-{u.role}">{u.role}</span>
					<!-- Only what the server would let you do to this account (the rule in $lib/account-rule.ts). On your own row, only the password. -->
					{#if mayManageAccount(data.currentUser, u)}
						{#if u.id !== data.currentUser.id}
							<!-- The picker and Change for the superadmin alone: anyone else may give only User, so the picker had one choice and Change could never do anything (the card 2376 review); the badge says the role. -->
							{#if isSuperadmin}
								<!-- Choosing sends nothing; Change saves it (card 2376). Busy, not off, while its change is out: off, it would drop the focus. -->
								<select
									value={chosenRole.get(u.id) ?? u.role}
									aria-busy={changingRole.has(u.id) ? 'true' : undefined}
									onchange={(e) => chooseUserRole(u.id, e.currentTarget)}
									class="role-select"
									aria-label="{u.username}'s role"
								>
									<option value="user">User</option>
									<option value="admin">Admin</option>
								</select>
								<button
									class="btn-ghost btn-sm role-change"
									aria-disabled={chosenRole.has(u.id) && !changingRole.has(u.id) ? undefined : 'true'}
									onclick={() => changeUserRole(u.id, u.username)}
									aria-label="Change {u.username}'s role"
								>Change</button>
							{/if}
						{/if}
						<button class="btn-ghost btn-sm" onclick={() => resetDialog?.openResetDialog(u.id)} title="Reset password">🔑</button>
						{#if u.id !== data.currentUser.id}
							<button class="btn-ghost btn-sm" onclick={(e) => resendInvite(u.id, e.currentTarget)} disabled={inviteInFlight !== null || inviteLink !== null} title="Resend invite email">{inviteInFlight === u.id ? '…' : '📧'}</button>
							<button class="btn-ghost btn-sm danger" onclick={() => confirm('Delete User', userDeleteWarning(u.username, soleOwnerOf(u.id)), () => deleteUser(u.id))} title="Delete user">🗑️</button>
						{/if}
					{:else}
						<span class="superadmin-lock" title={u.role === 'superadmin' ? "The superadmin's account is theirs alone" : "Only the superadmin can change an administrator's account"}>🔒</span>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</section>

<!-- The password dialog, after the section as it was on the page: fixed to the window, not to a card that moves on hover. -->
<ResetPasswordDialog bind:this={resetDialog} {data} />

<style>
	/* User list */
	.user-list { display: flex; flex-direction: column; gap: var(--space-xs); }
	.user-row {
		display: flex; align-items: center; gap: var(--space-sm);
		padding: var(--space-sm) var(--space-md);
		background: var(--bg-base); border: 1px solid var(--glass-border);
		border-radius: var(--radius-md); transition: border-color 0.15s;
	}
	.user-row:hover { border-color: var(--accent-indigo); }
	.user-row-emoji { font-size: 1.2rem; flex-shrink: 0; }
	.user-row-info { flex: 1; min-width: 0; display: flex; flex-direction: column; }
	.user-row-name { font-weight: 600; font-size: 0.85rem; }
	.user-row-email { font-size: 0.72rem; color: var(--text-tertiary); }

	.role-badge {
		font-size: 0.65rem; font-weight: 700; text-transform: uppercase;
		letter-spacing: 0.05em; padding: 2px 8px; border-radius: var(--radius-sm);
	}
	.role-superadmin { background: rgba(245, 158, 11, 0.15); color: var(--accent-amber); }
	.role-admin { background: rgba(99, 102, 241, 0.15); color: var(--accent-indigo); }
	.role-user { background: rgba(100, 116, 139, 0.15); color: var(--text-secondary); }

	.role-select {
		padding: 2px var(--space-sm); border: 1px solid var(--glass-border);
		border-radius: var(--radius-sm); background: var(--bg-base);
		color: var(--text-secondary); font-size: 0.72rem; font-weight: 600;
		cursor: pointer; font-family: var(--font-family);
	}

	/* Change beside the picker (card 2376): dimmed, and sending nothing, until a role other than the account's is chosen. */
	.role-change[aria-disabled='true'] { opacity: 0.35; cursor: default; }
	/* The status line is for screen readers alone. */
	.saving-status {
		position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
		overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
	}

	.superadmin-lock { font-size: 0.9rem; opacity: 0.5; }
</style>
