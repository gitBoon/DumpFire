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
		/** The mail panel's own read of what mail has done, which the page draws for the superadmin. */
		loadMailStatus: () => void;
		/** The page's: the link of an invite whose mail was not sent, which its dialog shows. */
		inviteLink: { url: string; username: string; message: string } | null;
	} = $props();

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
					inviteLink = { url: result.inviteUrl, username: made, message: said };
				} else {
					showToast(`${said} Send a new invite with 📧 once mail works.`, 'error', started);
				}
				return;
			}
			showToast(result?.invited ? 'User created — invite email sent!' : 'User created');
		} finally {
			creatingUser = false;
			inviteInFlight = null;
			// The panel the dialog points to, read again so it shows this mail.
			if (isSuperadmin) loadMailStatus();
		}
	}

	/**
	 * The role chosen in a row's select. The select shows it before the
	 * answer comes, so it is put back to the role the account has when the
	 * change is not made.
	 */
	async function changeUserRole(userId: number, select: HTMLSelectElement) {
		const newRole = select.value;
		const putBack = () => {
			select.value = data.users.find((u) => u.id === userId)?.role ?? select.value;
		};
		const started = toasts.navigation();
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
			showToast(
				typeof invitesEnded === 'number' && invitesEnded > 0
					? 'Role updated. The invite sent to this account earlier no longer works: send a new one with 📧.'
					: 'Role updated'
			);
		} else {
			putBack();
			showToast(await failureMessage(res, 'Failed to update role'), 'error', started);
		}
	}

	async function deleteUser(userId: number) {
		if (!(await sent(() => fetch(`/api/users/${userId}`, { method: 'DELETE' }), 'Failed to delete user'))) return;
		await invalidateAll();
		showToast('User deleted');
	}

	/**
	 * 📧: a new invite, which ends the account's earlier one. The server waits
	 * for its mail and says whether it went (card 2196): sent, the toast; not
	 * sent, the dialog with the link to pass on, or, where the server could no
	 * longer show it, the server's words in a toast that stays. "Invite sent"
	 * only for an answer that says `mailSent: true`. Either way the mail panel
	 * is read again, for the superadmin, so it shows this mail.
	 */
	async function resendInvite(userId: number) {
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
					inviteLink = { url: result.inviteUrl, username, message: said };
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
			// The panel the dialog points to, read again so it shows this mail.
			if (isSuperadmin) loadMailStatus();
		}
	}
</script>

<!-- User Management -->
<section class="admin-card glass fade-in-up" style="animation-delay: 200ms">
	<div class="section-header">
		<h2>👥 User Management</h2>
		<button class="btn-primary btn-sm" onclick={() => (showCreateUser = true)}>+ Add User</button>
	</div>
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
							<select
								value={u.role}
								onchange={(e) => changeUserRole(u.id, e.currentTarget)}
								class="role-select"
							>
								<option value="user">User</option>
								{#if isSuperadmin}<option value="admin">Admin</option>{/if}
							</select>
						{/if}
						<button class="btn-ghost btn-sm" onclick={() => resetDialog?.openResetDialog(u.id)} title="Reset password">🔑</button>
						{#if u.id !== data.currentUser.id}
							<button class="btn-ghost btn-sm" onclick={() => resendInvite(u.id)} disabled={inviteInFlight !== null || inviteLink !== null} title="Resend invite email">{inviteInFlight === u.id ? '…' : '📧'}</button>
							<button class="btn-ghost btn-sm danger" onclick={() => confirm('Delete User', userDeleteWarning(u.username), () => deleteUser(u.id))} title="Delete user">🗑️</button>
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

	.superadmin-lock { font-size: 0.9rem; opacity: 0.5; }
</style>
