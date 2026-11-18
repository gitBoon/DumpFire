<!--
  ResetPasswordDialog.svelte — The admin page's password dialog: an
  administrator's reset of another account's password, with what it ends
  counted beforehand, or their own change on their own row (card 2281, slice
  C1b: moved from src/routes/admin/+page.svelte).

  Drawn by the users panel after its section, and opened by its 🔑 through
  `openResetDialog`, which the panel reaches with `bind:this`.

  Card 2701: a reset of another account's password asks for the
  administrator's own too, as their own change always did; a refusal of it is
  said in the dialog, which stays open with the field cleared and focused.

  Card 2886: the dialog holds the keyboard as the other admin dialogs do
  (`$lib/dialog-focus`'s `holdFocus`): the focus in the password as it opens,
  Tab kept inside, Escape presses Cancel, and the focus back on 🔑 as it closes.
  Enter in the code field (and in the password, once a code is typed) moves
  the focus on to the new password; it never sends. It names itself, as the
  others do.
-->
<script lang="ts">
	import type { PageData } from '../../../routes/admin/$types';
	import { invalidateAll } from '$app/navigation';
	import { answerBody, failureMessage } from '$lib/api';
	import { NO_ANSWER, showToast } from '$lib/admin/send';
	import CurrentPasswordField from '$lib/components/CurrentPasswordField.svelte';
	import { holdFocus } from '$lib/dialog-focus';
	import { toasts } from '$lib/stores/toast';
	import { passwordKeptAfter, proofTyped, stepUpRefusal } from '$lib/step-up-words';

	/** What the admin page's load gave it, passed on as it is: the accounts and who is signed in. */
	let { data }: { data: PageData } = $props();

	let resetPasswordUserId = $state<number | null>(null);
	let resetPasswordValue = $state('');
	/**
	 * The password the administrator has now: asked for on every row, their
	 * own (the Account page's change) and another's (a reset asks for it
	 * again, card 2701). Cleared once sent.
	 */
	let resetPasswordCurrent = $state('');
	/**
	 * The sign-in code typed beside it (card 2770), on both rows, held and
	 * cleared as the password is. Both rows' routes check it beside the
	 * password (card 2771): your own row's, `PUT /api/account/password`, through
	 * the step-up as every other.
	 */
	let resetCodeCurrent = $state('');
	/**
	 * The server's refusal of that password or code, said in the dialog until
	 * the next try (card 2701), its field focused again (`CurrentPasswordField`).
	 */
	let resetRefusal = $state<string | null>(null);
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
		resetCodeCurrent = '';
		resetRefusal = null;
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

	/**
	 * Cancel, which Escape presses (card 2886): one way to close the dialog
	 * sending nothing. Its handler stays in the markup, where it clears the
	 * password, the code and the refusal; the script sets no account but in
	 * `openResetDialog` and a finished reset (`tests/page-failures.test.ts`).
	 */
	let cancelButton = $state<HTMLButtonElement>();

	/** The new-password box, where Enter in the code field moves the focus (card 2886). */
	let newPasswordInput = $state<HTMLInputElement>();

	/** Enter in the code field, or in the password once a code is typed: on to the new password, never a send. */
	function toNewPassword() {
		newPasswordInput?.focus();
	}

	/** `1 session`, `2 API keys`: a count with its noun. */
	const counted = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

	async function resetPassword() {
		if (!resetPasswordUserId || !resetPasswordValue || resetPasswordValue.length < 8) return;
		if (!proofTyped(resetPasswordCurrent, resetCodeCurrent)) return;
		const started = toasts.navigation();
		// Sent, and cleared from the dialog: typed again after a refusal.
		const currentPassword = resetPasswordCurrent;
		const currentCode = resetCodeCurrent;
		resetPasswordCurrent = '';
		resetCodeCurrent = '';
		resetRefusal = null;
		let res: Response;
		try {
			res = resettingOwnPassword
				? await fetch('/api/account/password', {
						method: 'PUT',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ currentPassword, currentCode, newPassword: resetPasswordValue })
					})
				: await fetch(`/api/users/${resetPasswordUserId}/password`, {
						method: 'PUT',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ password: resetPasswordValue, currentPassword, currentCode })
					});
		} catch {
			// The dialog stays open: whether the password was set is not known.
			showToast(NO_ANSWER, 'error', started);
			return;
		}
		// The administrator's own password refused (card 2701): said in the
		// dialog, which stays open with the field focused to type it again; the
		// password kept for a refusal decided before it was compared, and only
		// the code typed again (card 2771, D9).
		const refusal = await stepUpRefusal(res);
		if (refusal !== null) {
			resetRefusal = refusal;
			resetPasswordCurrent = passwordKeptAfter(refusal, currentPassword);
			return;
		}
		if (res.ok) {
			const own = resettingOwnPassword;
			resetPasswordUserId = null;
			resetPasswordValue = '';
			resetPasswordCurrent = '';
			resetCodeCurrent = '';
			// What the change or the reset ended, in the answer's own counts.
			const result = await answerBody(res);
			if (own) {
				// Card 2894 (D1): the holder's own change always pauses their report schedules.
				const ownPaused = result?.reportSchedulesPaused;
				showToast(typeof ownPaused === 'number' ? `Password changed: ${counted(ownPaused, 'report schedule')} paused` : 'Password changed');
			} else {
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
			}
			// The counts are read again: the account now has no report schedule on,
			// and after a reset holds no key and has no webhook on.
			await invalidateAll();
		} else {
			// The server's own words: a refusal says whose password this is not to set.
			showToast(await failureMessage(res, 'Failed to reset password'), 'error', started);
		}
	}
</script>

<!-- Password Reset Modal (inline) -->
{#if resetPasswordUserId}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div class="modal-overlay" role="dialog" aria-modal="true" aria-label={resettingOwnPassword ? 'Change Your Password' : 'Reset Password'}>
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<div class="modal-content" onclick={(e) => e.stopPropagation()} role="document" use:holdFocus={{ first: 'input:not(:disabled)', onEscape: () => cancelButton?.click() }}>
			<h2>🔑 {resettingOwnPassword ? 'Change Your Password' : 'Reset Password'}</h2>
			{#if resettingOwnPassword}
				<!-- Their own account: the password they have is asked for, as on the Account page. -->
				<p>This is your own account. Enter your current password, a code from your authenticator app, and a new one. Your other sessions will be signed out. Your report schedules are paused.</p>
				<!-- Sent with no endApiKeys, so the keys are kept. The Account page offers the choice. -->
				<p>Your API keys and the webhooks you set up keep working. To end the keys and switch off those webhooks too, change your password on the <a href="/account">Account page</a>.</p>
				<CurrentPasswordField label="Current password" bind:value={resetPasswordCurrent} bind:code={resetCodeCurrent} refusal={resetRefusal} onEnter={toNewPassword} />
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
				<!-- The administrator's own password, which a reset asks for again (card 2701). -->
				<CurrentPasswordField bind:value={resetPasswordCurrent} bind:code={resetCodeCurrent} refusal={resetRefusal} onEnter={toNewPassword} />
			{/if}
			<input type="password" placeholder="New password (min 8 chars)" aria-label="New password" bind:value={resetPasswordValue} bind:this={newPasswordInput} class="form-input" style="width: 100%; margin: 0 0 var(--space-md);" autocomplete="new-password" />
			<div class="modal-actions">
				<button class="btn-ghost" bind:this={cancelButton} onclick={() => { resetPasswordUserId = null; resetPasswordCurrent = ''; resetCodeCurrent = ''; resetRefusal = null; }}>Cancel</button>
				<button class="btn-primary" onclick={resetPassword} disabled={resetPasswordValue.length < 8 || !proofTyped(resetPasswordCurrent, resetCodeCurrent)}>{resettingOwnPassword ? 'Change Password' : 'Reset Password'}</button>
			</div>
		</div>
	</div>
{/if}
