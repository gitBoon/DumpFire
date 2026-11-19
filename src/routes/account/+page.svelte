<script lang="ts">
	/**
	 * My Account — View profile info and change password.
	 *
	 * Changing the email, changing the password and making an API key each ask
	 * for the current password and a code from the authenticator app, or a
	 * recovery code (card 2771, D9), in `CurrentPasswordField`, as every
	 * listed action asks: the server checks both through the step-up. Each
	 * form copies the two into `currentPassword` and `currentCode` and clears
	 * its fields before it sends; a refusal of the password or the code is
	 * said in the field's alert, and puts the password back only for the
	 * refusals decided before it was compared (`passwordKeptAfter`). Any other
	 * refusal is said in the form's line, as before. Keeping a key made before
	 * two-step sign-in past its deadline asks for the same, in `ConfirmModal`
	 * (card 2772).
	 *
	 * Card 2772 (D6, D9): the warning that someone entered the password, at the
	 * top of the page, with Change my password and That was me (`ConfirmModal`,
	 * which clears only the warning shown); and the Two-step sign-in section,
	 * after Change Password (`TwoStepSection`).
	 */
	import type { PageData } from './$types';
	import { theme, themeIcon } from '$lib/stores/theme';
	import HeaderMenu from '$lib/components/HeaderMenu.svelte';
	import ThemeMenuItems from '$lib/components/ThemeMenuItems.svelte';
	import EmojiPicker from '$lib/components/EmojiPicker.svelte';
	import CurrentPasswordField from '$lib/components/CurrentPasswordField.svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import TwoStepSection from '$lib/components/account/TwoStepSection.svelte';
	import { answerBody, failureMessage } from '$lib/api';
	import { passwordKeptAfter, proofTyped, stepUpRefusal } from '$lib/step-up-words';
	import { ASKS_FOR_PASSWORD, type StepUpProof } from '$lib/step-up-words';
	import { MASTER_PREF, NOTIFICATION_PREFS, type NotificationPrefKey } from '$lib/notification-prefs';
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { parseStamp } from '$lib/timestamps';

	let { data }: { data: PageData } = $props();

	let currentTheme = $state('light');
	theme.subscribe((v) => (currentTheme = v));

	// Email change
	let newEmail = $state(data.user.email);
	/** The current password and the code the email form asks for (card 2771), cleared as it sends. */
	let emailPassword = $state('');
	let emailCode = $state('');
	/** A refusal of the password or the code, in the field's alert. */
	let emailRefusal = $state<string | null>(null);
	let changingEmail = $state(false);
	let emailMessage = $state('');
	let emailError = $state(false);
	let displayedEmail = $state(data.user.email);

	// Avatar
	let currentEmoji = $state(data.user.emoji || '👤');
	let savingEmoji = $state(false);
	/** Why the last change of avatar was not saved, under the avatar (card 2148). */
	let emojiError = $state('');

	/**
	 * The new avatar is shown at once, and the one before it put back if the
	 * server does not keep it. The picker is disabled while the save is on its
	 * way, as the mail switches are, so that a refusal of the first cannot be
	 * put back over a second. Once it is kept, the page's data is read again,
	 * so that the badge in the corner, which the root layout draws from it,
	 * shows it without a reload.
	 */
	async function changeEmoji(emoji: string) {
		if (savingEmoji) return;
		const was = currentEmoji;
		currentEmoji = emoji;
		savingEmoji = true;
		emojiError = '';
		try {
			const res = await fetch('/api/account/emoji', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ emoji })
			});
			if (!res.ok) {
				currentEmoji = was;
				emojiError = await failureMessage(res, 'Your avatar was not changed.');
			} else {
				await invalidateAll();
			}
		} catch {
			currentEmoji = was;
			emojiError = 'No answer from the server. Your avatar may not have been changed.';
		} finally {
			savingEmoji = false;
		}
	}

	// Password change
	/** The current password and the code the password form asks for (card 2771), cleared as it sends. */
	let passwordCurrent = $state('');
	let passwordCode = $state('');
	/** A refusal of the password or the code, in the field's alert. */
	let passwordRefusal = $state<string | null>(null);
	let newPassword = $state('');
	let confirmPassword = $state('');
	let showPasswords = $state(false);
	let changingPassword = $state(false);
	let passwordMessage = $state('');
	let passwordError = $state(false);
	/**
	 * Whether the change ends this account's API keys too, and switches off
	 * the webhooks it set up, which go with the keys on the server (card
	 * 2168). Not ticked unless the holder ticks it: a routine change is not
	 * about an intruder, and ending keys stops every script that uses them.
	 * Offered only when the key list has loaded, with a key in it or with a
	 * webhook of the account's on, so a list that failed to load keeps the
	 * keys, which is the safe side.
	 */
	let endApiKeysToo = $state(false);

	/** `1 API key`, `2 API keys`. */
	const keysInWords = (n: number) => `${n} API key${n === 1 ? '' : 's'}`;

	/** `1 webhook`, `2 webhooks`. */
	const webhooksInWords = (n: number) => `${n} webhook${n === 1 ? '' : 's'}`;

	/** `1 report schedule`, `2 report schedules`. */
	const schedulesInWords = (n: number) => `${n} report schedule${n === 1 ? '' : 's'}`;

	/**
	 * What ticking the box ends, in the words beside it: the keys, the
	 * webhooks the account set up, or both. The box is there for a webhook
	 * with no key left too: revoking the key that set a webhook up switches it
	 * off (card 2893), but one set up before keys were recorded goes on while
	 * the account holds a working key from then, and the server switches every
	 * one off with `endApiKeys` all the same. And since card 2923 it holds
	 * those already switched off, and mails their boards' owners: said in the
	 * last sentence, for both cases.
	 */
	function whatTheBoxEnds(keys: number, hooks: number): string {
		const ends =
			keys > 0 && hooks > 0
				? `End my ${keysInWords(keys)} too, and switch off the ${webhooksInWords(hooks)} I set up.`
				: keys > 0
					? `End my ${keysInWords(keys)} too.`
					: `Switch off the ${webhooksInWords(hooks)} I set up.`;
		return [
			ends,
			'Do this if anyone else may have used your account.',
			keys > 0 ? `Anything that uses ${keys === 1 ? 'the key' : 'the keys'} stops working until it is given a new key.` : '',
			hooks > 0 ? "A webhook switched off sends nothing until the board's owner or an administrator switches it on again." : '',
			// Card 2923 (S9): the owners are mailed, and one already off is held, which the box's change brings about too.
			hooks > 0
				? "The boards' owners are mailed about them, and about any you set up that are already switched off, which can then be switched on only with a new secret."
				: "Any webhook you set up that is already switched off can then be switched on only with a new secret, and its board's owners are mailed about it.",
			// Card 2935 (P8): in words, only where the account may have read a secret (P1).
			data.holdsReadable
				? "Every webhook whose secret you could read, as an administrator or a board's owner, is switched off too, whoever set it up, and can be switched on again only with a new secret; its board's owners are mailed."
				: ''
		]
			.filter(Boolean)
			.join(' ');
	}

	async function changeEmail() {
		if (!newEmail?.trim() || !proofTyped(emailPassword, emailCode) || changingEmail) return;
		if (newEmail.trim() === displayedEmail) {
			emailMessage = 'This is already your current email';
			emailError = true;
			return;
		}

		changingEmail = true;
		emailMessage = '';
		emailError = false;
		emailRefusal = null;

		// Copied and cleared before the send: the fields hold neither once it has gone.
		const currentPassword = emailPassword;
		const currentCode = emailCode;
		emailPassword = '';
		emailCode = '';
		try {
			const res = await fetch('/api/account/email', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ newEmail: newEmail.trim(), currentPassword, currentCode })
			});

			if (res.ok) {
				const result = await res.json();
				emailMessage = 'Email updated successfully!';
				emailError = false;
				displayedEmail = result.email;
				newEmail = result.email;
			} else {
				// A refusal of the password or the code, in the field; any other in the form's line.
				const refusal = await stepUpRefusal(res);
				if (refusal !== null) {
					emailRefusal = refusal;
					emailPassword = passwordKeptAfter(refusal, currentPassword);
				} else {
					emailMessage = await failureMessage(res, 'Failed to update email');
					emailError = true;
				}
			}
		} catch {
			emailMessage = 'No answer from the server. Reload the page to see whether your email was changed.';
			emailError = true;
		} finally {
			changingEmail = false;
		}
	}

	async function changePassword() {
		if (!proofTyped(passwordCurrent, passwordCode) || !newPassword || !confirmPassword || changingPassword) return;
		if (newPassword.length < 8) {
			passwordMessage = 'New password must be at least 8 characters';
			passwordError = true;
			return;
		}
		if (newPassword !== confirmPassword) {
			passwordMessage = 'Passwords do not match';
			passwordError = true;
			return;
		}

		changingPassword = true;
		passwordMessage = '';
		passwordError = false;
		passwordRefusal = null;

		// Only when the box was there to tick: it is not, with no keys and no
		// webhook of the account's on.
		const endApiKeys = endApiKeysToo && offerToEnd;
		// Copied and cleared before the send: the fields hold neither once it has gone.
		const currentPassword = passwordCurrent;
		const currentCode = passwordCode;
		passwordCurrent = '';
		passwordCode = '';
		try {
			const res = await fetch('/api/account/password', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ currentPassword, currentCode, newPassword, endApiKeys })
			});

			if (res.ok) {
				// How many keys the server ended, webhooks it switched off and report schedules it paused, from its answer.
				const answer = await answerBody(res);
				const keysEnded = typeof answer?.apiKeysEnded === 'number' ? answer.apiKeysEnded : 0;
				const hooksOff = typeof answer?.webhooksSwitchedOff === 'number' ? answer.webhooksSwitchedOff : 0;
				const paused = typeof answer?.reportSchedulesPaused === 'number' ? answer.reportSchedulesPaused : 0;
				const ended = [
					keysEnded > 0 ? `your ${keysInWords(keysEnded)} ${keysEnded === 1 ? 'was' : 'were'} ended` : '',
					hooksOff > 0 ? `the ${webhooksInWords(hooksOff)} you set up ${hooksOff === 1 ? 'was' : 'were'} switched off` : ''
				].filter(Boolean);
				// Card 2894 (D1): the schedules paused, always, and where to turn them on again.
				const pausedWords =
					paused > 0
						? `; your ${schedulesInWords(paused)} ${paused === 1 ? 'was' : 'were'} paused: turn ${paused === 1 ? 'it' : 'them'} on again on the Reports page.`
						: '.';
				passwordMessage =
					'Password changed. Your other sessions were signed out' + (ended.length > 0 ? `; ${ended.join(' and ')}` : '') + pausedWords;
				passwordError = false;
				newPassword = '';
				confirmPassword = '';
				endApiKeysToo = false;
				if (endApiKeys) {
					// A key made a moment ago went with the others: its panel goes too.
					newlyCreatedKey = '';
					// The list is read again, so that it no longer shows keys that have gone.
					await loadApiKeys();
				}
				// The page is read again for the counts the form shows: the webhooks
				// switched off with the keys, and the schedules that are on (none now).
				if (endApiKeys || paused > 0) await invalidateAll();
			} else {
				// A refusal of the password or the code, in the field; any other in the form's line.
				const refusal = await stepUpRefusal(res);
				if (refusal !== null) {
					passwordRefusal = refusal;
					passwordCurrent = passwordKeptAfter(refusal, currentPassword);
				} else {
					passwordMessage = await failureMessage(res, 'Failed to change password');
					passwordError = true;
				}
			}
		} catch {
			passwordMessage = 'No answer from the server. Reload the page: if it asks you to sign in, the password was changed.';
			passwordError = true;
		} finally {
			changingPassword = false;
		}
	}

	function getRoleBadge(role: string) {
		const styles: Record<string, string> = {
			superadmin: 'role-superadmin',
			admin: 'role-admin',
			user: 'role-user'
		};
		return styles[role] || 'role-user';
	}

	// Notification preferences. The kinds, their words and the master switch are
	// the one list in $lib/notification-prefs, which the route saves from and
	// the mail reads (card 2146): this page kept a list of its own, which
	// offered a switch the route did not save and left out Mentions.
	type NotifPrefs = Partial<Record<NotificationPrefKey, boolean>>;

	let notifPrefs = $state<NotifPrefs>({});
	// The saved preferences could not be read, so every switch is shown off,
	// as the mail applies them, until any switch is saved (card 2724).
	let notifUnreadable = $state(false);
	let notifLoading = $state(true);
	let notifSaving = $state(false);
	/** Why the last change of a switch was not saved, under the switches (card 2148). */
	let notifError = $state('');

	// API Keys
	type ApiKeyInfo = {
		id: number;
		name: string;
		keyPrefix: string;
		lastUsedAt: string | null;
		expiresAt: string | null;
		createdAt: string;
		/**
		 * The deadline of a key made before two-step sign-in, until it is kept
		 * (migration 0069, card 2772); null when it has none.
		 */
		deadlineAt: string | null;
		/**
		 * How many webhooks revoking the key would switch off now (card 2893,
		 * D5; the code review's CS4): those it set up, and, for the account's
		 * last key from before keys were recorded, those set up before then. The
		 * revoke's confirm says it first.
		 */
		webhooks: number;
	};

	let apiKeys = $state<ApiKeyInfo[]>([]);
	let apiKeysLoading = $state(true);
	/** The key list has been read: until then, `apiKeys` being empty says nothing. */
	let apiKeysRead = $state(false);
	let newKeyName = $state('');
	/** The current password and the code, which making a key asks for (card 2771). Cleared as each attempt is sent. */
	let newKeyPassword = $state('');
	let newKeyCode = $state('');
	/** A refusal of the password or the code, in the field's alert. */
	let keyRefusal = $state<string | null>(null);
	/** Why the last Generate Key was refused, in the server's words. */
	let apiKeyError = $state('');
	/** What the last revoke did, in the key panel's line: the key gone, and how many webhooks it switched off (card 2893, D5). */
	let apiKeyMessage = $state('');
	let generatingKey = $state(false);
	let newlyCreatedKey = $state('');
	let keyCopied = $state(false);
	let deletingKeyId = $state<number | null>(null);
	let confirmDeleteId = $state<number | null>(null);

	/** How many webhooks this account set up that are on, from the page's load (card 2168). */
	let webhooksSet = $derived(data.webhooks ?? 0);
	/** How many of this account's report schedules are on, from the page's load (card 2894): a password change pauses them. */
	let schedulesOn = $derived(data.reportSchedulesOn ?? 0);
	/**
	 * Whether the box is offered: while the list holds a key, or, once the
	 * list has been read, while a webhook the account set is on.
	 */
	let offerToEnd = $derived(apiKeys.length > 0 || (apiKeysRead && webhooksSet > 0));

	// The box to end the keys goes when there is nothing left for it to end,
	// and takes its tick with it, so that it cannot come back ticked beside a
	// key made later.
	$effect(() => {
		if (!offerToEnd) endApiKeysToo = false;
	});

	async function loadApiKeys() {
		try {
			const res = await fetch('/api/account/api-keys');
			if (res.ok) {
				apiKeys = await res.json();
				apiKeysRead = true;
			}
		} catch { /* silent */ }
		apiKeysLoading = false;
	}

	async function generateApiKey() {
		if (!newKeyName.trim() || !proofTyped(newKeyPassword, newKeyCode) || generatingKey) return;
		generatingKey = true;
		newlyCreatedKey = '';
		keyCopied = false;
		apiKeyError = '';
		// The last revoke's line, which is not this action's (the code review's CR7).
		apiKeyMessage = '';
		keyRefusal = null;

		// Making a key asks for the current password and a code: a key outlives
		// a password change the holder makes, so a session alone is not enough
		// to make one. Copied and cleared before the send.
		const currentPassword = newKeyPassword;
		const currentCode = newKeyCode;
		newKeyPassword = '';
		newKeyCode = '';
		try {
			const res = await fetch('/api/account/api-keys', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: newKeyName.trim(), currentPassword, currentCode })
			});

			if (res.ok) {
				const result = await res.json();
				newlyCreatedKey = result.key;
				newKeyName = '';
				await loadApiKeys();
			} else {
				// A refusal of the password or the code, in the field; any other
				// (the ten-key limit, a name that is too long) in the panel's line.
				const refusal = await stepUpRefusal(res);
				if (refusal !== null) {
					keyRefusal = refusal;
					newKeyPassword = passwordKeptAfter(refusal, currentPassword);
				} else {
					apiKeyError = await failureMessage(res, 'Failed to generate the key');
				}
			}
		} catch {
			apiKeyError = 'No answer from the server. Reload the page to see whether the key was made.';
		} finally {
			generatingKey = false;
		}
	}

	async function copyKey() {
		if (!newlyCreatedKey) return;
		await navigator.clipboard.writeText(newlyCreatedKey);
		keyCopied = true;
		setTimeout(() => keyCopied = false, 2000);
	}

	/**
	 * What the confirm of a key's revoke says first (card 2893, S13): how many
	 * webhooks it switches off, which may include ones set up before keys were
	 * recorded (the code review's CS4), so not "it set".
	 */
	const revokeQuestion = (hooks: number) =>
		hooks > 0 ? `Revoke? It switches off ${webhooksInWords(hooks)}.` : 'Revoke?';

	/**
	 * A refusal is said in the key panel's line, and the key stays in the list
	 * (card 2148). A revoke switches off the webhooks the key set up, and those
	 * from before keys were recorded that lose their last key with it (card
	 * 2893, D5; the code review's CS4): the line says how many, from the answer,
	 * and the page is read again for the count of webhooks the password form
	 * offers to switch off.
	 */
	async function revokeKey(id: number) {
		deletingKeyId = id;
		apiKeyError = '';
		apiKeyMessage = '';
		try {
			const res = await fetch(`/api/account/api-keys/${id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
			if (res.ok) {
				const answer = await res.json().catch(() => null);
				const hooksOff = typeof answer?.webhooksSwitchedOff === 'number' ? answer.webhooksSwitchedOff : 0;
				apiKeys = apiKeys.filter(k => k.id !== id);
				apiKeyMessage =
					hooksOff > 0
						? `Key revoked. ${webhooksInWords(hooksOff)} ${hooksOff === 1 ? 'was' : 'were'} switched off.`
						: 'Key revoked.';
				if (hooksOff > 0) await invalidateAll();
			} else {
				apiKeyError = await failureMessage(res, 'The key was not revoked.');
			}
		} catch {
			apiKeyError = 'No answer from the server. Reload the page to see whether the key was revoked.';
		} finally {
			deletingKeyId = null;
			confirmDeleteId = null;
		}
	}

	/** The key whose Keep this key dialog is open, or null (card 2772). */
	let keepingKey = $state<ApiKeyInfo | null>(null);

	/**
	 * Keep this key, confirmed: the key's deadline cleared, with the password
	 * and a code (card 2772, D5). A refusal of the password or the code is
	 * given back for the dialog to show; anything else closes it, a refusal
	 * said in the key panel's line. The list is read again after a success
	 * and after any refusal that is not of the password or the code, so the
	 * row shows the key as it now is.
	 */
	async function keepKey(id: number, proof: StepUpProof): Promise<string | void> {
		apiKeyError = '';
		// The last revoke's line, which is not this action's (the code review's CR7).
		apiKeyMessage = '';
		try {
			const res = await fetch(`/api/account/api-keys/${id}/keep`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ currentPassword: proof.currentPassword, currentCode: proof.currentCode })
			});
			if (res.ok) {
				keepingKey = null;
			} else {
				// A refusal of the password or the code, in the dialog; any other in the panel's line.
				const refusal = await stepUpRefusal(res);
				if (refusal !== null) return refusal;
				keepingKey = null;
				apiKeyError = await failureMessage(res, 'The key was not kept.');
			}
			// Read again after a success and after any other refusal (code review CR4):
			// the key may have been revoked, kept elsewhere, or passed its deadline, and
			// its row shows it as the server has it, never as the page guessed.
			await loadApiKeys();
		} catch {
			keepingKey = null;
			apiKeyError = 'No answer from the server. Reload the page to see whether the key was kept.';
		}
	}

	// The warning at the top of the page (card 2772, D6)
	/** The That was me dialog is open. */
	let dismissing = $state(false);
	/** Why the warning was not cleared, under it. */
	let bannerError = $state('');
	/** The password form's field, which Change my password moves the focus to. */
	let passwordField = $state<ReturnType<typeof CurrentPasswordField>>();

	/** Change my password: the focus in the password form, which is scrolled to. */
	function goToPasswordForm() {
		const field = passwordField?.element();
		field?.scrollIntoView({ block: 'center' });
		field?.focus();
	}

	/**
	 * That was me, confirmed with the password and a code: the warning cleared,
	 * only if it is still the one shown (`bannerAt`, the latest signal's moment
	 * as the page showed it: S3, CS1). A refusal of the
	 * password or the code goes back to the dialog; any other, a newer warning
	 * among them, closes it and is said under the warning.
	 */
	async function dismissBanner(bannerAt: string, proof: StepUpProof): Promise<string | void> {
		bannerError = '';
		try {
			const res = await fetch('/api/account/two-step/banner', {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ bannerAt, currentPassword: proof.currentPassword, currentCode: proof.currentCode })
			});
			if (res.ok) {
				dismissing = false;
				await invalidateAll();
			} else {
				const refusal = await stepUpRefusal(res);
				if (refusal !== null) return refusal;
				dismissing = false;
				bannerError = await failureMessage(res, 'The warning was not cleared.');
				// A newer warning than the one shown: read again, so that it is the one shown.
				if (res.status === 409) await invalidateAll();
			}
		} catch {
			dismissing = false;
			bannerError = 'No answer from the server. Reload the page to see whether the warning was cleared.';
		}
	}

	/**
	 * Whether a key's deadline has passed, as the server decides it
	 * (`deadlinePassed`): one that cannot be read has passed.
	 */
	function pastDeadline(deadlineAt: string): boolean {
		const at = parseStamp(deadlineAt);
		return at === null || at.getTime() <= Date.now();
	}

	// A key's times come in the stored form, `YYYY-MM-DD HH:MM:SS` in UTC, which
	// `new Date()` read as local time (card 2095): read as UTC.
	function formatDate(dateStr: string | null): string {
		if (!dateStr) return 'Never';
		const d = parseStamp(dateStr);
		if (!d) return dateStr;
		return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
	}

	/** A key's expiry or deadline with its time and zone, `2026-11-17 09:12 UTC` (card 2772, E21). */
	function formatMoment(dateStr: string): string {
		const d = parseStamp(dateStr);
		if (!d) return dateStr;
		return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
	}

	onMount(async () => {
		try {
			const res = await fetch('/api/account/notifications');
			if (res.ok) {
				const { unreadable, ...prefs } = await res.json();
				notifPrefs = prefs;
				notifUnreadable = unreadable === true;
			}
		} catch { /* silent */ }
		notifLoading = false;

		await loadApiKeys();
	});

	/**
	 * Turn one switch over, or all of them with the master switch, and save.
	 * A switch is on unless it is stored as `false`, as the mail reads it and
	 * as the switch is drawn. A refusal puts every switch back to what it was
	 * and says why under them; a success shows what the server saved. The
	 * switches are off while a save is on its way, so that no second save can
	 * be put back over by the first.
	 */
	async function toggleNotif(key: NotificationPrefKey) {
		const was = notifPrefs;
		const newVal = notifPrefs[key] === false;
		notifPrefs = { ...notifPrefs, [key]: newVal };

		// If master toggle is turned off, disable all
		if (key === MASTER_PREF && !newVal) {
			const allOff: NotifPrefs = { [MASTER_PREF]: false };
			for (const t of NOTIFICATION_PREFS) allOff[t.key] = false;
			notifPrefs = allOff;
		}
		// If master toggle is turned on, enable all
		if (key === MASTER_PREF && newVal) {
			const allOn: NotifPrefs = { [MASTER_PREF]: true };
			for (const t of NOTIFICATION_PREFS) allOn[t.key] = true;
			notifPrefs = allOn;
		}

		notifSaving = true;
		notifError = '';
		try {
			const res = await fetch('/api/account/notifications', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(notifPrefs)
			});
			if (res.ok) {
				notifPrefs = await res.json();
				notifUnreadable = false;
			} else {
				notifPrefs = was;
				notifError = await failureMessage(res, 'Your notification settings were not saved.');
			}
		} catch {
			notifPrefs = was;
			notifError = 'No answer from the server. Your notification settings may not have been saved.';
		} finally {
			notifSaving = false;
		}
	}
</script>

<svelte:head>
	<title>My Account — DumpFire</title>
</svelte:head>

<div class="account-page">
	<header class="account-header">
		<a href="/" class="back-btn btn-ghost">
			<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
				<path d="M10 12L6 8l4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
			</svg>
		</a>
		<h1>⚙️ My Account</h1>
		<!-- The theme, as the dashboard's More draws it: a menu worked from the keyboard (card 2471). -->
		<HeaderMenu label="Theme" triggerClass="btn-ghost" triggerTitle="Change theme">
			{#snippet trigger()}<span aria-hidden="true">{themeIcon($theme)}</span>{/snippet}
			<ThemeMenuItems heading={false} />
		</HeaderMenu>
	</header>

	<main class="account-content">
		<!-- The warning that someone entered the password, at the top until it is cleared (card 2772, D6, E16). -->
		{#if data.twoStep.banner}
			{@const banner = data.twoStep.banner}
			<section class="account-card security-banner" aria-labelledby="security-banner-heading">
				<h2 id="security-banner-heading">⚠️ Was this you?</h2>
				<p class="security-banner-words">
					{banner.words}{#if banner.at} ({formatMoment(banner.at)}){/if}{#if banner.latestAt && banner.latestAt !== banner.at} It happened again, most recently {formatMoment(banner.latestAt)}.{/if}
				</p>
				<p class="security-banner-words">If that was not you, change your password now.</p>
				{#if bannerError}
					<div class="password-msg error" role="alert">{bannerError}</div>
				{/if}
				<div class="security-banner-actions">
					<button class="btn-primary" onclick={goToPasswordForm}>Change my password</button>
					<button class="btn-ghost" onclick={() => (dismissing = true)}>That was me</button>
				</div>
			</section>
		{/if}

		<!-- Profile section -->
		<section class="account-card glass fade-in-up">
			<h2>👤 Profile</h2>
			<div class="profile-info">
				<div class="profile-avatar-wrap">
					<EmojiPicker value={currentEmoji} onSelect={(e) => changeEmoji(e)} disabled={savingEmoji} />
					<span class="avatar-edit-hint">Click to change</span>
					{#if emojiError}
						<div class="password-msg error avatar-error" role="alert">{emojiError}</div>
					{/if}
				</div>
				<div class="profile-details">
					<div class="profile-row">
						<span class="profile-label">Username</span>
						<span class="profile-value">{data.user.username}</span>
					</div>
					<div class="profile-row">
						<span class="profile-label">Email</span>
						<span class="profile-value">{displayedEmail}</span>
					</div>
					<div class="profile-row">
						<span class="profile-label">Role</span>
						<span class="profile-value">
							<span class="role-badge {getRoleBadge(data.user.role)}">{data.user.role}</span>
						</span>
					</div>
				</div>
			</div>
		</section>

		<!-- Email change section -->
		<section class="account-card glass fade-in-up" style="animation-delay: 0.1s">
			<h2>✉️ Change Email</h2>

			{#if emailMessage}
				<div class="password-msg" class:error={emailError} class:success={!emailError}>
					{emailMessage}
				</div>
			{/if}

			<div class="password-form">
				<div class="form-group">
					<label for="new-email">New Email Address</label>
					<input
						id="new-email"
						type="email"
						bind:value={newEmail}
						placeholder="Enter new email address"
						autocomplete="email"
					/>
				</div>

				<CurrentPasswordField
					label="Confirm password"
					bind:value={emailPassword}
					bind:code={emailCode}
					refusal={emailRefusal}
					readonly={changingEmail}
					onEnter={changeEmail}
				/>

				<div class="password-actions">
					<span></span>
					<button
						class="btn-primary"
						onclick={changeEmail}
						disabled={!newEmail?.trim() || !proofTyped(emailPassword, emailCode) || newEmail.trim() === displayedEmail || changingEmail}
					>
						{changingEmail ? 'Updating...' : 'Update Email'}
					</button>
				</div>
			</div>
		</section>

		<!-- Password change section -->
		<section class="account-card glass fade-in-up" style="animation-delay: 0.2s">
			<h2>🔒 Change Password</h2>

			{#if passwordMessage}
				<div class="password-msg" class:error={passwordError} class:success={!passwordError}>
					{passwordMessage}
				</div>
			{/if}

			<div class="password-form">
				<!-- Always masked: Show passwords reveals the two new ones only (card 2771, D17). -->
				<CurrentPasswordField
					label="Current password"
					bind:value={passwordCurrent}
					bind:code={passwordCode}
					refusal={passwordRefusal}
					readonly={changingPassword}
					bind:this={passwordField}
				/>

				<div class="form-group">
					<label for="new-pass">New Password</label>
					<div class="password-wrapper">
						<input
							id="new-pass"
							type={showPasswords ? 'text' : 'password'}
							bind:value={newPassword}
							placeholder="Minimum 8 characters"
							autocomplete="new-password"
							minlength="8"
						/>
					</div>
				</div>

				<div class="form-group">
					<label for="confirm-pass">Confirm New Password</label>
					<div class="password-wrapper">
						<input
							id="confirm-pass"
							type={showPasswords ? 'text' : 'password'}
							bind:value={confirmPassword}
							placeholder="Re-enter new password"
							autocomplete="new-password"
							minlength="8"
							onkeydown={(e) => e.key === 'Enter' && changePassword()}
						/>
					</div>
				</div>

				{#if offerToEnd}
					<!-- The holder's own change keeps their API keys, and the webhooks they set up, unless they ask. -->
					<div class="end-keys">
						{#if apiKeys.length > 0}
							<p class="end-keys-note">You have {keysInWords(apiKeys.length)}. {apiKeys.length === 1 ? 'It keeps' : 'They keep'} working after a password change unless you tick the box.</p>
						{/if}
						{#if webhooksSet > 0}
							<p class="end-keys-note">You set up {webhooksInWords(webhooksSet)}. {webhooksSet === 1 ? 'It keeps' : 'They keep'} sending your boards' events after a password change unless you tick the box.</p>
						{/if}
						<label class="end-keys-check">
							<input type="checkbox" bind:checked={endApiKeysToo} />
							<span>{whatTheBoxEnds(apiKeys.length, webhooksSet)}</span>
						</label>
					</div>
				{/if}

				{#if schedulesOn > 0}
					<!-- Card 2894 (D1): a change always pauses the account's report schedules; said before the button. -->
					<p class="end-keys-note">Changing your password pauses your {schedulesInWords(schedulesOn)}. Turn on the ones you recognise on the <a href="/reports">Reports page</a> afterwards: it asks for your password and a code.</p>
				{/if}

				<div class="password-actions">
					<label class="show-password-check">
						<input type="checkbox" bind:checked={showPasswords} />
						Show passwords
					</label>
					<button
						class="btn-primary"
						onclick={changePassword}
						disabled={!proofTyped(passwordCurrent, passwordCode) || !newPassword || !confirmPassword || changingPassword}
					>
						{changingPassword ? 'Changing...' : 'Change Password'}
					</button>
				</div>
			</div>
		</section>

		<!-- Two-step sign-in (card 2772, D9) -->
		<TwoStepSection twoStep={data.twoStep} />

		<!-- Email Notifications section -->
		<section class="account-card glass fade-in-up" style="animation-delay: 0.3s">
			<h2>🔔 Email Notifications</h2>
			<p class="notif-desc">Choose which email notifications you'd like to receive.</p>
			{#if notifUnreadable}
				<p class="notif-desc" role="status">Your saved choices could not be read, so you are sent none of these emails. Turn on the ones you want: saving replaces them.</p>
			{/if}

			{#if notifLoading}
				<p class="notif-loading">Loading preferences...</p>
			{:else}
				<div class="notif-list">
					<!-- Master toggle -->
					<div class="notif-row master">
						<div class="notif-info">
							<span class="notif-label">All Email Notifications</span>
							<span class="notif-hint">Master toggle — disables all emails when off</span>
						</div>
						<button class="toggle" class:on={notifPrefs[MASTER_PREF] !== false} onclick={() => toggleNotif(MASTER_PREF)} disabled={notifSaving} aria-label="Toggle all notifications">
							<span class="toggle-thumb"></span>
						</button>
					</div>

					{#each NOTIFICATION_PREFS as type}
						<div class="notif-row" class:disabled={notifPrefs[MASTER_PREF] === false}>
							<div class="notif-info">
								<span class="notif-label">{type.label}</span>
								<span class="notif-hint">{type.description}</span>
							</div>
							<button class="toggle" class:on={notifPrefs[type.key] !== false && notifPrefs[MASTER_PREF] !== false} onclick={() => toggleNotif(type.key)} disabled={notifSaving || notifPrefs[MASTER_PREF] === false} aria-label="Toggle {type.label}">
								<span class="toggle-thumb"></span>
							</button>
						</div>
					{/each}
				</div>

				{#if notifSaving}
					<p class="notif-saving">Saving...</p>
				{/if}
				{#if notifError}
					<div class="password-msg error notif-error" role="alert">{notifError}</div>
				{/if}
			{/if}
		</section>

		<!-- API Keys section -->
		<section class="account-card glass fade-in-up" style="animation-delay: 0.4s">
			<h2>🔑 API Keys</h2>
			<p class="notif-desc">Generate API keys for automation and external integrations. Generating a key asks for your password and a code from your authenticator app. See <a href="/docs" target="_blank">API documentation</a> for usage.</p>

			<!-- New key creation -->
			<div class="apikey-create">
				{#if apiKeyError}
					<div class="password-msg error" role="alert">{apiKeyError}</div>
				{/if}
				{#if apiKeyMessage}
					<div class="password-msg success" role="status">{apiKeyMessage}</div>
				{/if}
				<div class="apikey-create-row">
					<input
						id="apikey-name"
						type="text"
						bind:value={newKeyName}
						placeholder="Key name (e.g. CI Pipeline, n8n)"
						aria-label="Key name"
						maxlength="100"
						onkeydown={(e) => e.key === 'Enter' && generateApiKey()}
					/>
				</div>
				<CurrentPasswordField
					label="Your current password"
					bind:value={newKeyPassword}
					bind:code={newKeyCode}
					refusal={keyRefusal}
					readonly={generatingKey}
					onEnter={generateApiKey}
				/>
				<div class="password-actions">
					<span></span>
					<button
						id="apikey-generate-btn"
						class="btn-primary"
						onclick={generateApiKey}
						disabled={!newKeyName.trim() || !proofTyped(newKeyPassword, newKeyCode) || generatingKey}
					>
						{generatingKey ? 'Generating...' : 'Generate Key'}
					</button>
				</div>

				{#if newlyCreatedKey}
					<div class="apikey-reveal">
						<div class="apikey-reveal-header">
							<span class="apikey-reveal-icon">⚠️</span>
							<span>Copy your key now — it won't be shown again</span>
						</div>
						<div class="apikey-reveal-value">
							<code id="apikey-plaintext">{newlyCreatedKey}</code>
							<button
								id="apikey-copy-btn"
								class="btn-ghost apikey-copy-btn"
								onclick={copyKey}
							>
								{keyCopied ? '✅ Copied!' : '📋 Copy'}
							</button>
						</div>
					</div>
				{/if}
			</div>

			<!-- Existing keys -->
			{#if apiKeysLoading}
				<p class="notif-loading">Loading API keys...</p>
			{:else if apiKeys.length === 0}
				<p class="apikey-empty">No API keys yet. Generate one above to get started.</p>
			{:else}
				<div class="apikey-list">
					{#each apiKeys as key (key.id)}
						<div class="apikey-row">
							<div class="apikey-info">
								<span class="apikey-name">{key.name}</span>
								<code class="apikey-prefix">{key.keyPrefix}•••</code>
								<span class="apikey-meta">
									Created {formatDate(key.createdAt)}
									 · Last used: {formatDate(key.lastUsedAt)}
									 · {key.expiresAt ? `Expires ${formatMoment(key.expiresAt)}` : 'No expiry'}
									 · Revoking it switches off {webhooksInWords(key.webhooks ?? 0)}
								</span>
								<!-- A key made before two-step sign-in (card 2772): its deadline, and Keep while it has not passed. -->
								{#if key.deadlineAt !== null && pastDeadline(key.deadlineAt)}
									<span class="apikey-deadline passed">Stopped working on {formatMoment(key.deadlineAt)}. Generate a new key.</span>
								{:else if key.deadlineAt !== null}
									<span class="apikey-deadline">⚠️ Made before two-step sign-in: stops working on {formatMoment(key.deadlineAt)} unless you keep it</span>
									<button class="btn-ghost-sm apikey-keep" onclick={() => (keepingKey = key)}>Keep this key</button>
								{/if}
							</div>
							{#if confirmDeleteId === key.id}
								<div class="apikey-confirm-delete">
									<span class="apikey-confirm-text">{revokeQuestion(key.webhooks ?? 0)}</span>
									<button
										class="btn-danger-sm"
										onclick={() => revokeKey(key.id)}
										disabled={deletingKeyId === key.id}
									>
										{deletingKeyId === key.id ? '...' : 'Yes'}
									</button>
									<button class="btn-ghost-sm" onclick={() => confirmDeleteId = null}>No</button>
								</div>
							{:else}
								<button
									class="btn-ghost-sm apikey-revoke"
									onclick={() => confirmDeleteId = key.id}
								>
									Revoke
								</button>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		</section>
	</main>
</div>

<!-- Keep this key asks for the password and a code (card 2772). Outside the page's cards: fixed to the window. -->
{#if keepingKey}
	{@const key = keepingKey}
	<ConfirmModal
		title="Keep this key"
		message={`Keep “${key.name}” past its deadline? It goes on working as it is, with no deadline. ${ASKS_FOR_PASSWORD}`}
		confirmText="Keep"
		confirmDanger={false}
		askPassword
		onConfirm={(proof) => keepKey(key.id, proof)}
		onCancel={() => (keepingKey = null)}
	/>
{/if}

<!-- That was me asks for the password and a code, and clears only the warning shown (card 2772, D6). -->
<!-- It sends the latest signal the page shows, not the banner's first: one that came after it is never cleared unseen (CS1). -->
{#if dismissing && data.twoStep.banner?.latestAt}
	{@const bannerAt = data.twoStep.banner.latestAt}
	<ConfirmModal
		title="That was me"
		message={`Clear this warning? Do this only if it was you who entered your password. ${ASKS_FOR_PASSWORD}`}
		confirmText="Clear the warning"
		confirmDanger={false}
		askPassword
		onConfirm={(proof) => dismissBanner(bannerAt, proof)}
		onCancel={() => (dismissing = false)}
	/>
{/if}

<style>
	.account-page { min-height: 100vh; }

	.account-header {
		display: flex; align-items: center; gap: var(--space-md);
		padding: var(--space-md) var(--space-xl);
		border-bottom: 1px solid var(--glass-border);
	}
	.account-header h1 { flex: 1; font-size: 1.25rem; }
	.back-btn { padding: var(--space-sm); }

	/* The page's last line stops above the user badge (card 2239). */
	.account-content {
		max-width: 600px; margin: 0 auto;
		padding: var(--space-2xl) var(--space-2xl) var(--user-badge-space);
		display: flex; flex-direction: column; gap: var(--space-xl);
	}

	.fade-in-up {
		animation: fadeInUp 0.5s ease-out both;
	}
	@keyframes fadeInUp {
		from { opacity: 0; transform: translateY(16px); }
		to { opacity: 1; transform: translateY(0); }
	}

	.account-card {
		padding: var(--space-xl); border-radius: var(--radius-lg);
	}
	.account-card h2 {
		font-size: 1.05rem; margin-bottom: var(--space-xl);
		padding-bottom: var(--space-md);
		border-bottom: 1px solid var(--glass-border);
	}

	/* The warning at the top of the page (card 2772) */
	.security-banner {
		background: rgba(245, 158, 11, 0.08);
		border: 1px solid rgba(245, 158, 11, 0.35);
	}
	.security-banner h2 { margin-bottom: var(--space-md); }
	.security-banner-words { font-size: 0.88rem; color: var(--text-primary); margin: 0 0 var(--space-sm); }
	.security-banner-actions { display: flex; flex-wrap: wrap; gap: var(--space-sm); margin-top: var(--space-md); }

	/* Profile */
	.profile-info { display: flex; gap: var(--space-xl); align-items: flex-start; }
	.profile-avatar-wrap {
		display: flex; flex-direction: column; align-items: center; gap: 4px; flex-shrink: 0;
	}
	.avatar-edit-hint {
		font-size: 0.6rem; color: var(--text-tertiary); text-transform: uppercase;
		letter-spacing: 0.05em; font-weight: 600;
	}
	.profile-details { flex: 1; display: flex; flex-direction: column; gap: var(--space-md); }
	.profile-row { display: flex; align-items: center; gap: var(--space-md); }
	.profile-label {
		font-size: 0.72rem; font-weight: 600; text-transform: uppercase;
		letter-spacing: 0.05em; color: var(--text-tertiary); width: 80px; flex-shrink: 0;
	}
	.profile-value { font-size: 0.9rem; font-weight: 500; }

	.role-badge {
		font-size: 0.65rem; font-weight: 700; text-transform: uppercase;
		letter-spacing: 0.05em; padding: 2px 8px; border-radius: var(--radius-sm);
	}
	.role-superadmin { background: rgba(245, 158, 11, 0.15); color: var(--accent-amber); }
	.role-admin { background: rgba(99, 102, 241, 0.15); color: var(--accent-indigo); }
	.role-user { background: rgba(100, 116, 139, 0.15); color: var(--text-secondary); }

	/* Password form */
	.password-form { display: flex; flex-direction: column; gap: var(--space-lg); }
	.form-group label {
		display: block; font-size: 0.72rem; font-weight: 600;
		color: var(--text-secondary); text-transform: uppercase;
		letter-spacing: 0.05em; margin-bottom: var(--space-xs);
	}
	.password-wrapper { position: relative; }

	.password-msg {
		padding: var(--space-sm) var(--space-md);
		border-radius: var(--radius-sm);
		font-size: 0.82rem; font-weight: 500;
		margin-bottom: var(--space-md);
	}
	.password-msg.error {
		background: rgba(244, 63, 94, 0.1); border: 1px solid rgba(244, 63, 94, 0.3);
		color: var(--accent-rose);
	}
	.password-msg.success {
		background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.3);
		color: var(--accent-emerald);
	}
	/* A change of avatar or of a mail switch that was not saved, under the control. */
	.avatar-error { margin: 0; max-width: 180px; font-size: 0.72rem; text-align: center; }
	.notif-error { margin: var(--space-sm) 0 0; }

	.password-actions {
		display: flex; align-items: center; justify-content: space-between;
		margin-top: var(--space-sm);
	}
	.show-password-check {
		display: flex; align-items: center; gap: var(--space-xs);
		font-size: 0.78rem; color: var(--text-tertiary); cursor: pointer;
		text-transform: none !important; letter-spacing: 0 !important;
		font-weight: 400 !important;
	}
	.show-password-check input { cursor: pointer; }

	/* Ending the API keys with a password change */
	.end-keys {
		display: flex; flex-direction: column; gap: var(--space-sm);
		padding: var(--space-md);
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		border-radius: var(--radius-md);
	}
	.end-keys-note { font-size: 0.82rem; color: var(--text-secondary); margin: 0; }
	.end-keys-check {
		display: flex; align-items: flex-start; gap: var(--space-sm);
		font-size: 0.8rem; color: var(--text-primary); cursor: pointer; line-height: 1.4;
	}
	.end-keys-check input { width: auto; flex-shrink: 0; margin-top: 3px; cursor: pointer; }

	/* Notification preferences */
	.notif-desc { font-size: 0.82rem; color: var(--text-secondary); margin-bottom: var(--space-md); }
	.notif-loading, .notif-saving { font-size: 0.78rem; color: var(--text-tertiary); }
	.notif-list { display: flex; flex-direction: column; gap: 2px; }
	.notif-row {
		display: flex; align-items: center; justify-content: space-between;
		padding: var(--space-sm) var(--space-md);
		border-radius: var(--radius-sm);
		transition: opacity 0.2s ease;
	}
	.notif-row.master {
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		border-radius: var(--radius-md); margin-bottom: var(--space-sm);
	}
	.notif-row.disabled { opacity: 0.4; pointer-events: none; }
	.notif-info { display: flex; flex-direction: column; gap: 1px; }
	.notif-label { font-size: 0.85rem; font-weight: 600; color: var(--text-primary); }
	.notif-hint { font-size: 0.7rem; color: var(--text-tertiary); }

	/* Toggle switch */
	.toggle {
		width: 44px; height: 24px; border-radius: 12px; border: none; cursor: pointer;
		background: var(--glass-border); position: relative; flex-shrink: 0;
		transition: background 0.2s ease;
	}
	.toggle.on { background: var(--accent-indigo); }
	.toggle:disabled { cursor: not-allowed; }
	.toggle-thumb {
		position: absolute; top: 2px; left: 2px;
		width: 20px; height: 20px; border-radius: 50%;
		background: white; box-shadow: 0 1px 3px rgba(0,0,0,0.2);
		transition: transform 0.2s ease;
	}
	.toggle.on .toggle-thumb { transform: translateX(20px); }

	/* API Keys */
	.apikey-create { margin-bottom: var(--space-xl); }
	.apikey-create-row {
		display: flex; flex-wrap: wrap; gap: var(--space-sm); align-items: stretch;
		margin-bottom: var(--space-sm);
	}
	.apikey-create-row input { flex: 1 1 160px; }

	.apikey-reveal {
		margin-top: var(--space-md);
		padding: var(--space-md);
		background: rgba(245, 158, 11, 0.08);
		border: 1px solid rgba(245, 158, 11, 0.25);
		border-radius: var(--radius-md);
	}
	.apikey-reveal-header {
		display: flex; align-items: center; gap: var(--space-xs);
		font-size: 0.78rem; font-weight: 600; color: var(--accent-amber);
		margin-bottom: var(--space-sm);
	}
	.apikey-reveal-value {
		display: flex; align-items: center; gap: var(--space-sm);
		background: var(--bg-surface); padding: var(--space-sm) var(--space-md);
		border-radius: var(--radius-sm); overflow: hidden;
	}
	.apikey-reveal-value code {
		flex: 1; font-size: 0.72rem; word-break: break-all;
		color: var(--text-primary); font-family: 'JetBrains Mono', monospace;
	}
	.apikey-copy-btn { flex-shrink: 0; font-size: 0.75rem; }

	.apikey-empty {
		font-size: 0.82rem; color: var(--text-tertiary);
		text-align: center; padding: var(--space-xl) 0;
	}

	.apikey-list {
		display: flex; flex-direction: column; gap: 2px;
	}
	.apikey-row {
		display: flex; align-items: center; justify-content: space-between;
		padding: var(--space-sm) var(--space-md);
		border-radius: var(--radius-sm);
		transition: background 0.15s ease;
	}
	.apikey-row:hover { background: var(--bg-surface); }
	.apikey-info {
		display: flex; flex-direction: column; gap: 2px; min-width: 0;
	}
	.apikey-name {
		font-size: 0.85rem; font-weight: 600; color: var(--text-primary);
	}
	.apikey-prefix {
		font-size: 0.7rem; font-family: 'JetBrains Mono', monospace;
		color: var(--text-secondary); background: var(--bg-surface);
		padding: 1px 6px; border-radius: var(--radius-sm); width: fit-content;
	}
	.apikey-meta {
		font-size: 0.68rem; color: var(--text-tertiary);
	}
	.apikey-deadline {
		font-size: 0.68rem; color: var(--accent-amber);
	}
	.apikey-deadline.passed { color: var(--accent-rose); }
	.apikey-keep { width: fit-content; margin-top: 2px; }

	.apikey-confirm-delete {
		display: flex; align-items: center; gap: var(--space-xs);
	}
	.apikey-confirm-text {
		font-size: 0.75rem; color: var(--accent-rose); font-weight: 600;
	}
	.btn-danger-sm {
		padding: 2px 10px; font-size: 0.72rem; border-radius: var(--radius-sm);
		background: var(--accent-rose); color: white; border: none; cursor: pointer;
		font-weight: 600;
	}
	.btn-danger-sm:disabled { opacity: 0.5; cursor: not-allowed; }
	.btn-ghost-sm {
		padding: 2px 10px; font-size: 0.72rem; border-radius: var(--radius-sm);
		background: transparent; color: var(--text-secondary); border: 1px solid var(--glass-border);
		cursor: pointer; font-weight: 500;
	}
	.apikey-revoke { color: var(--accent-rose); }
</style>
