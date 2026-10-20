<!--
  ResetPasswordDialog.svelte — The admin page's password dialog: an
  administrator's reset of another account's password, with what it ends
  counted beforehand, or their own change on their own row (card 2281, slice
  C1b: moved from src/routes/admin/+page.svelte).

  Drawn by the users panel after its section, and opened by its 🔑 through
  `openResetDialog`, which the panel reaches with `bind:this`.
-->
<script lang="ts">
	import type { PageData } from '../../../routes/admin/$types';
	import { invalidateAll } from '$app/navigation';
	import { answerBody, failureMessage } from '$lib/api';
	import { NO_ANSWER, showToast } from '$lib/admin/send';
	import { toasts } from '$lib/stores/toast';

	/** What the admin page's load gave it, passed on as it is: the accounts and who is signed in. */
	let { data }: { data: PageData } = $props();

	let resetPasswordUserId = $state<number | null>(null);
	let resetPasswordValue = $state('');
	/** The password the administrator has now. Asked for only when the account in the dialog is their own. */
	let resetPasswordCurrent = $state('');
	/**
	 * The dialog is open on the signed-in administrator's own row. The reset
	 * route refuses the caller's own account: their password is changed where
	 * everyone's is, with the one they have, and their other sessions end.
	 */
	let resettingOwnPassword = $derived(resetPasswordUserId !== null && resetPasswordUserId === data.currentUser?.id);
	/** The account in the dialog, from the page's list of users as last read. */
	let resetTarget = $derived(data.users.find((u) => u.id === resetPasswordUserId));
	/**
	 * The page's data has been read again since the dialog opened. The list
	 * the page was loaded with may be older than a key made since, so until
	 * then no count is shown.
	 */
	let resetKeysRead = $state(false);
	/** Which opening of the dialog the latest read belongs to. */
	let resetOpenings = 0;
	/**
	 * How many API keys that account holds. A reset ends every one of them, and
	 * the dialog says how many before it is confirmed: one of them may be the
	 * key a script or an integration runs on. Null until the count has been
	 * read again, and for an account the caller may not reset, which the page
	 * is given no count for.
	 */
	let resetTargetKeys = $derived(resetKeysRead ? (resetTarget?.apiKeys ?? null) : null);
	/**
	 * How many webhooks that account set that are on, and how many of its
	 * report schedules are on. A reset switches off the first and pauses the
	 * second (card 2168), and the dialog says how many, by the same rule as the
	 * keys: null until read again, and for an account the caller may not reset.
	 */
	let resetTargetWebhooks = $derived(resetKeysRead ? (resetTarget?.webhooks ?? null) : null);
	let resetTargetSchedules = $derived(resetKeysRead ? (resetTarget?.reportSchedules ?? null) : null);

	/** Open the dialog on an account, and read the key counts again for it. */
	export async function openResetDialog(userId: number) {
		resetPasswordUserId = userId;
		resetPasswordValue = '';
		resetPasswordCurrent = '';
		resetKeysRead = false;
		const opening = ++resetOpenings;
		try {
			await invalidateAll();
		} catch {
			// Not read: the dialog shows no count rather than an old one.
			return;
		}
		// Only if the dialog is still open on the same account, and was not
		// opened again meanwhile.
		if (opening === resetOpenings && resetPasswordUserId === userId) resetKeysRead = true;
	}

	/** `1 session`, `2 API keys`: a count with its noun. */
	const counted = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

	async function resetPassword() {
		if (!resetPasswordUserId || !resetPasswordValue || resetPasswordValue.length < 8) return;
		if (resettingOwnPassword && !resetPasswordCurrent) return;
		const started = toasts.navigation();
		let res: Response;
		try {
			res = resettingOwnPassword
				? await fetch('/api/account/password', {
						method: 'PUT',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ currentPassword: resetPasswordCurrent, newPassword: resetPasswordValue })
					})
				: await fetch(`/api/users/${resetPasswordUserId}/password`, {
						method: 'PUT',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ password: resetPasswordValue })
					});
		} catch {
			// The dialog stays open: whether the password was set is not known.
			showToast(NO_ANSWER, 'error', started);
			return;
		}
		if (res.ok) {
			const own = resettingOwnPassword;
			resetPasswordUserId = null;
			resetPasswordValue = '';
			resetPasswordCurrent = '';
			if (own) {
				showToast('Password changed');
			} else {
				// What the reset ended, in the answer's own counts.
				const result = await answerBody(res);
				const sessionsEnded = result?.sessionsEnded;
				const apiKeysEnded = result?.apiKeysEnded;
				const webhooksSwitchedOff = result?.webhooksSwitchedOff;
				const reportSchedulesPaused = result?.reportSchedulesPaused;
				showToast(
					typeof sessionsEnded === 'number' &&
						typeof apiKeysEnded === 'number' &&
						typeof webhooksSwitchedOff === 'number' &&
						typeof reportSchedulesPaused === 'number'
						? `Password reset: ${counted(sessionsEnded, 'session')} and ${counted(apiKeysEnded, 'API key')} ended, ` +
								`${counted(webhooksSwitchedOff, 'webhook')} switched off and ${counted(reportSchedulesPaused, 'report schedule')} paused`
						: 'Password reset'
				);
				// The counts are read again: the account now holds no key, and has no
				// webhook or report schedule on.
				await invalidateAll();
			}
		} else {
			// The server's own words: a refusal says whose password this is not to set.
			showToast(await failureMessage(res, 'Failed to reset password'), 'error', started);
		}
	}
</script>

<!-- Password Reset Modal (inline) -->
{#if resetPasswordUserId}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div class="modal-overlay" role="dialog" aria-modal="true">
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<div class="modal-content" onclick={(e) => e.stopPropagation()} role="document">
			<h2>🔑 {resettingOwnPassword ? 'Change Your Password' : 'Reset Password'}</h2>
			{#if resettingOwnPassword}
				<!-- Their own account: the password they have is asked for, as on the Account page. -->
				<p>This is your own account. Enter your current password and a new one. Your other sessions will be signed out.</p>
				<!-- Sent with no endApiKeys, so the keys are kept. The Account page offers the choice. -->
				<p>Your API keys and the webhooks you set up keep working. To end the keys and switch off those webhooks too, change your password on the <a href="/account">Account page</a>.</p>
				<input type="password" placeholder="Current password" bind:value={resetPasswordCurrent} class="form-input" style="width: 100%; margin: var(--space-md) 0 0;" autocomplete="current-password" />
			{:else}
				<p>Enter a new password for {resetTarget?.username || 'user'}.</p>
				{#if resetTargetKeys !== null && resetTargetKeys > 0}
					<p class="warning-text">They have {counted(resetTargetKeys, 'API key')}, which {resetTargetKeys === 1 ? 'stops' : 'stop'} working.</p>
				{/if}
				{#if resetTargetWebhooks !== null && resetTargetWebhooks > 0}
					<p class="warning-text">They set up {counted(resetTargetWebhooks, 'webhook')}, which {resetTargetWebhooks === 1 ? 'is' : 'are'} switched off.</p>
				{/if}
				{#if resetTargetSchedules !== null && resetTargetSchedules > 0}
					<p class="warning-text">They have {counted(resetTargetSchedules, 'report schedule')}, which {resetTargetSchedules === 1 ? 'is' : 'are'} paused.</p>
				{/if}
				<p>They are signed out everywhere, every API key they have stops working, any invite not yet used stops working, the webhooks they set up are switched off and their report schedules are paused.</p>
			{/if}
			<input type="password" placeholder="New password (min 8 chars)" bind:value={resetPasswordValue} class="form-input" style="width: 100%; margin: var(--space-md) 0;" autocomplete="new-password" />
			<div class="modal-actions">
				<button class="btn-ghost" onclick={() => (resetPasswordUserId = null)}>Cancel</button>
				<button class="btn-primary" onclick={resetPassword} disabled={resetPasswordValue.length < 8 || (resettingOwnPassword && !resetPasswordCurrent)}>{resettingOwnPassword ? 'Change Password' : 'Reset Password'}</button>
			</div>
		</div>
	</div>
{/if}
