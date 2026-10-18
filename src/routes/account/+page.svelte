<script lang="ts">
	/**
	 * My Account — View profile info and change password.
	 */
	import type { PageData } from './$types';
	import { theme } from '$lib/stores/theme';
	import ThemePicker from '$lib/components/ThemePicker.svelte';
	import EmojiPicker from '$lib/components/EmojiPicker.svelte';
	import { answerBody, failureMessage } from '$lib/api';
	import { MASTER_PREF, NOTIFICATION_PREFS, type NotificationPrefKey } from '$lib/notification-prefs';
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { parseStamp } from '$lib/timestamps';

	let { data }: { data: PageData } = $props();

	let currentTheme = $state('light');
	theme.subscribe((v) => (currentTheme = v));

	// Email change
	let newEmail = $state(data.user.email);
	let emailPassword = $state('');
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
	let currentPassword = $state('');
	let newPassword = $state('');
	let confirmPassword = $state('');
	let showPasswords = $state(false);
	let changingPassword = $state(false);
	let passwordMessage = $state('');
	let passwordError = $state(false);
	/**
	 * Whether the change ends this account's API keys too. Not ticked unless
	 * the holder ticks it: a routine change is not about an intruder, and
	 * ending keys stops every script that uses them. Offered only when the key
	 * list has loaded with a key in it, so a list that failed to load keeps
	 * the keys, which is the safe side.
	 */
	let endApiKeysToo = $state(false);

	/** `1 API key`, `2 API keys`. */
	const keysInWords = (n: number) => `${n} API key${n === 1 ? '' : 's'}`;

	async function changeEmail() {
		if (!newEmail?.trim() || !emailPassword) return;
		if (newEmail.trim() === displayedEmail) {
			emailMessage = 'This is already your current email';
			emailError = true;
			return;
		}

		changingEmail = true;
		emailMessage = '';
		emailError = false;

		try {
			const res = await fetch('/api/account/email', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ newEmail: newEmail.trim(), password: emailPassword })
			});

			if (res.ok) {
				const result = await res.json();
				emailMessage = 'Email updated successfully!';
				emailError = false;
				displayedEmail = result.email;
				newEmail = result.email;
				emailPassword = '';
			} else {
				emailMessage = await failureMessage(res, 'Failed to update email');
				emailError = true;
			}
		} catch {
			emailMessage = 'No answer from the server. Reload the page to see whether your email was changed.';
			emailError = true;
		} finally {
			changingEmail = false;
		}
	}

	async function changePassword() {
		if (!currentPassword || !newPassword || !confirmPassword) return;
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

		// Only when the box was there to tick: it is not, with no keys.
		const endApiKeys = endApiKeysToo && apiKeys.length > 0;
		try {
			const res = await fetch('/api/account/password', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ currentPassword, newPassword, endApiKeys })
			});

			if (res.ok) {
				// How many keys the server ended, from its answer.
				const ended = (await answerBody(res))?.apiKeysEnded;
				const keysEnded = typeof ended === 'number' ? ended : 0;
				passwordMessage =
					'Password changed. Your other sessions were signed out' +
					(keysEnded > 0 ? `, and your ${keysInWords(keysEnded)} ${keysEnded === 1 ? 'was' : 'were'} ended.` : '.');
				passwordError = false;
				currentPassword = '';
				newPassword = '';
				confirmPassword = '';
				endApiKeysToo = false;
				if (endApiKeys) {
					// A key made a moment ago went with the others: its panel goes too.
					newlyCreatedKey = '';
					// The list is read again, so that it no longer shows keys that have gone.
					await loadApiKeys();
				}
			} else {
				passwordMessage = await failureMessage(res, 'Failed to change password');
				passwordError = true;
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
	};

	let apiKeys = $state<ApiKeyInfo[]>([]);
	let apiKeysLoading = $state(true);
	let newKeyName = $state('');
	/** The current password, which making a key asks for. Cleared after each attempt. */
	let newKeyPassword = $state('');
	/** Why the last Generate Key was refused, in the server's words. */
	let apiKeyError = $state('');
	let generatingKey = $state(false);
	let newlyCreatedKey = $state('');
	let keyCopied = $state(false);
	let deletingKeyId = $state<number | null>(null);
	let confirmDeleteId = $state<number | null>(null);

	// The box to end the keys goes when the last key does, and takes its tick
	// with it, so that it cannot come back ticked beside a key made later.
	$effect(() => {
		if (apiKeys.length === 0) endApiKeysToo = false;
	});

	async function loadApiKeys() {
		try {
			const res = await fetch('/api/account/api-keys');
			if (res.ok) apiKeys = await res.json();
		} catch { /* silent */ }
		apiKeysLoading = false;
	}

	async function generateApiKey() {
		if (!newKeyName.trim() || !newKeyPassword || generatingKey) return;
		generatingKey = true;
		newlyCreatedKey = '';
		keyCopied = false;
		apiKeyError = '';

		// Making a key asks for the current password: a key outlives a password
		// change the holder makes, so a session alone is not enough to make one.
		const password = newKeyPassword;
		newKeyPassword = '';
		try {
			const res = await fetch('/api/account/api-keys', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: newKeyName.trim(), password })
			});

			if (res.ok) {
				const result = await res.json();
				newlyCreatedKey = result.key;
				newKeyName = '';
				await loadApiKeys();
			} else {
				// A wrong password, the ten-key limit, a name that is too long.
				apiKeyError = await failureMessage(res, 'Failed to generate the key');
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

	/** A refusal is said in the key panel's line, and the key stays in the list (card 2148). */
	async function revokeKey(id: number) {
		deletingKeyId = id;
		apiKeyError = '';
		try {
			const res = await fetch(`/api/account/api-keys/${id}`, { method: 'DELETE' });
			if (res.ok) {
				apiKeys = apiKeys.filter(k => k.id !== id);
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

	// A key's times come in the stored form, `YYYY-MM-DD HH:MM:SS` in UTC, which
	// `new Date()` read as local time (card 2095): read as UTC.
	function formatDate(dateStr: string | null): string {
		if (!dateStr) return 'Never';
		const d = parseStamp(dateStr);
		if (!d) return dateStr;
		return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
	}

	onMount(async () => {
		try {
			const res = await fetch('/api/account/notifications');
			if (res.ok) notifPrefs = await res.json();
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
		<ThemePicker />
	</header>

	<main class="account-content">
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

				<div class="form-group">
					<label for="email-pass">Confirm Password</label>
					<div class="password-wrapper">
						<input
							id="email-pass"
							type="password"
							bind:value={emailPassword}
							placeholder="Enter your password to confirm"
							autocomplete="current-password"
							onkeydown={(e) => e.key === 'Enter' && changeEmail()}
						/>
					</div>
				</div>

				<div class="password-actions">
					<span></span>
					<button
						class="btn-primary"
						onclick={changeEmail}
						disabled={!newEmail?.trim() || !emailPassword || newEmail.trim() === displayedEmail || changingEmail}
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
				<div class="form-group">
					<label for="current-pass">Current Password</label>
					<div class="password-wrapper">
						<input
							id="current-pass"
							type={showPasswords ? 'text' : 'password'}
							bind:value={currentPassword}
							placeholder="Enter current password"
							autocomplete="current-password"
						/>
					</div>
				</div>

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

				{#if apiKeys.length > 0}
					<!-- The holder's own change keeps their API keys unless they ask. -->
					<div class="end-keys">
						<p class="end-keys-note">You have {keysInWords(apiKeys.length)}. {apiKeys.length === 1 ? 'It keeps' : 'They keep'} working after a password change unless you tick the box.</p>
						<label class="end-keys-check">
							<input type="checkbox" bind:checked={endApiKeysToo} />
							<span>End my {keysInWords(apiKeys.length)} too. Do this if anyone else may have used your account. Anything that uses {apiKeys.length === 1 ? 'it' : 'them'} stops working until it is given a new key.</span>
						</label>
					</div>
				{/if}

				<div class="password-actions">
					<label class="show-password-check">
						<input type="checkbox" bind:checked={showPasswords} />
						Show passwords
					</label>
					<button
						class="btn-primary"
						onclick={changePassword}
						disabled={!currentPassword || !newPassword || !confirmPassword || changingPassword}
					>
						{changingPassword ? 'Changing...' : 'Change Password'}
					</button>
				</div>
			</div>
		</section>

		<!-- Email Notifications section -->
		<section class="account-card glass fade-in-up" style="animation-delay: 0.3s">
			<h2>🔔 Email Notifications</h2>
			<p class="notif-desc">Choose which email notifications you'd like to receive.</p>

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
			<p class="notif-desc">Generate API keys for automation and external integrations. Generating a key asks for your password. See <a href="/docs" target="_blank">API documentation</a> for usage.</p>

			<!-- New key creation -->
			<div class="apikey-create">
				{#if apiKeyError}
					<div class="password-msg error" role="alert">{apiKeyError}</div>
				{/if}
				<div class="apikey-create-row">
					<input
						id="apikey-name"
						type="text"
						bind:value={newKeyName}
						placeholder="Key name (e.g. CI Pipeline, n8n)"
						maxlength="100"
						onkeydown={(e) => e.key === 'Enter' && generateApiKey()}
					/>
					<input
						id="apikey-password"
						type="password"
						bind:value={newKeyPassword}
						placeholder="Your current password"
						aria-label="Your current password"
						autocomplete="current-password"
						onkeydown={(e) => e.key === 'Enter' && generateApiKey()}
					/>
					<button
						id="apikey-generate-btn"
						class="btn-primary"
						onclick={generateApiKey}
						disabled={!newKeyName.trim() || !newKeyPassword || generatingKey}
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
								</span>
							</div>
							{#if confirmDeleteId === key.id}
								<div class="apikey-confirm-delete">
									<span class="apikey-confirm-text">Revoke?</span>
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
	}
	.apikey-create-row input { flex: 1 1 160px; }
	.apikey-create-row button { white-space: nowrap; }

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
