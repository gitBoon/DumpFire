<script lang="ts">
	/**
	 * My Account — View profile info and change password.
	 */
	import type { PageData } from './$types';
	import { theme } from '$lib/stores/theme';
	import ThemePicker from '$lib/components/ThemePicker.svelte';
	import EmojiPicker from '$lib/components/EmojiPicker.svelte';
	import { onMount } from 'svelte';

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

	async function changeEmoji(emoji: string) {
		currentEmoji = emoji;
		savingEmoji = true;
		await fetch('/api/account/emoji', {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ emoji })
		});
		savingEmoji = false;
	}

	// Password change
	let currentPassword = $state('');
	let newPassword = $state('');
	let confirmPassword = $state('');
	let showPasswords = $state(false);
	let changingPassword = $state(false);
	let passwordMessage = $state('');
	let passwordError = $state(false);

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
			const errData = await res.json().catch(() => ({ message: 'Failed to update email' }));
			emailMessage = errData.message || 'Failed to update email';
			emailError = true;
		}
		changingEmail = false;
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

		const res = await fetch('/api/account/password', {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ currentPassword, newPassword })
		});

		if (res.ok) {
			passwordMessage = 'Password changed successfully!';
			passwordError = false;
			currentPassword = '';
			newPassword = '';
			confirmPassword = '';
		} else {
			const errData = await res.json().catch(() => ({ message: 'Failed to change password' }));
			passwordMessage = errData.message || 'Failed to change password';
			passwordError = true;
		}
		changingPassword = false;
	}

	function getRoleBadge(role: string) {
		const styles: Record<string, string> = {
			superadmin: 'role-superadmin',
			admin: 'role-admin',
			user: 'role-user'
		};
		return styles[role] || 'role-user';
	}

	// Notification preferences
	type NotifPrefs = Record<string, boolean>;
	const NOTIF_TYPES = [
		{ key: 'email_assigned', label: 'Task Assignments', desc: 'When you are assigned to a card' },
		{ key: 'email_comments', label: 'Comments', desc: 'When someone comments on a board you belong to' },
		{ key: 'email_moved', label: 'Card Moves', desc: 'When a card you are assigned to is moved' },
		{ key: 'email_requests', label: 'Task Requests', desc: 'When someone submits or replies to a request' },
		{ key: 'email_request_progress', label: 'Request Progress', desc: 'Updates on tasks you requested until completion' },
		{ key: 'email_board_shared', label: 'Board Sharing', desc: 'When a board is shared with you' }
	];

	let notifPrefs = $state<NotifPrefs>({});
	let notifLoading = $state(true);
	let notifSaving = $state(false);

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
	let generatingKey = $state(false);
	let newlyCreatedKey = $state('');
	let keyCopied = $state(false);
	let deletingKeyId = $state<number | null>(null);
	let confirmDeleteId = $state<number | null>(null);

	async function loadApiKeys() {
		try {
			const res = await fetch('/api/account/api-keys');
			if (res.ok) apiKeys = await res.json();
		} catch { /* silent */ }
		apiKeysLoading = false;
	}

	async function generateApiKey() {
		if (!newKeyName.trim() || generatingKey) return;
		generatingKey = true;
		newlyCreatedKey = '';
		keyCopied = false;

		const res = await fetch('/api/account/api-keys', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: newKeyName.trim() })
		});

		if (res.ok) {
			const result = await res.json();
			newlyCreatedKey = result.key;
			newKeyName = '';
			await loadApiKeys();
		}
		generatingKey = false;
	}

	async function copyKey() {
		if (!newlyCreatedKey) return;
		await navigator.clipboard.writeText(newlyCreatedKey);
		keyCopied = true;
		setTimeout(() => keyCopied = false, 2000);
	}

	async function revokeKey(id: number) {
		deletingKeyId = id;
		const res = await fetch(`/api/account/api-keys/${id}`, { method: 'DELETE' });
		if (res.ok) {
			apiKeys = apiKeys.filter(k => k.id !== id);
		}
		deletingKeyId = null;
		confirmDeleteId = null;
	}

	function formatDate(dateStr: string | null): string {
		if (!dateStr) return 'Never';
		const d = new Date(dateStr);
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

	async function toggleNotif(key: string) {
		const newVal = !notifPrefs[key];
		notifPrefs = { ...notifPrefs, [key]: newVal };

		// If master toggle is turned off, disable all
		if (key === 'email_all' && !newVal) {
			const allOff: NotifPrefs = { email_all: false };
			for (const t of NOTIF_TYPES) allOff[t.key] = false;
			notifPrefs = allOff;
		}
		// If master toggle is turned on, enable all
		if (key === 'email_all' && newVal) {
			const allOn: NotifPrefs = { email_all: true };
			for (const t of NOTIF_TYPES) allOn[t.key] = true;
			notifPrefs = allOn;
		}

		notifSaving = true;
		await fetch('/api/account/notifications', {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(notifPrefs)
		});
		notifSaving = false;
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
					<EmojiPicker value={currentEmoji} onSelect={(e) => changeEmoji(e)} />
					<span class="avatar-edit-hint">Click to change</span>
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
						<button class="toggle" class:on={notifPrefs.email_all !== false} onclick={() => toggleNotif('email_all')} aria-label="Toggle all notifications">
							<span class="toggle-thumb"></span>
						</button>
					</div>

					{#each NOTIF_TYPES as type}
						<div class="notif-row" class:disabled={notifPrefs.email_all === false}>
							<div class="notif-info">
								<span class="notif-label">{type.label}</span>
								<span class="notif-hint">{type.desc}</span>
							</div>
							<button class="toggle" class:on={notifPrefs[type.key] !== false && notifPrefs.email_all !== false} onclick={() => toggleNotif(type.key)} disabled={notifPrefs.email_all === false} aria-label="Toggle {type.label}">
								<span class="toggle-thumb"></span>
							</button>
						</div>
					{/each}
				</div>

				{#if notifSaving}
					<p class="notif-saving">Saving...</p>
				{/if}
			{/if}
		</section>

		<!-- API Keys section -->
		<section class="account-card glass fade-in-up" style="animation-delay: 0.4s">
			<h2>🔑 API Keys</h2>
			<p class="notif-desc">Generate API keys for automation and external integrations. See <a href="/DUMPFIRE_API.md" target="_blank">API documentation</a> for usage.</p>

			<!-- New key creation -->
			<div class="apikey-create">
				<div class="apikey-create-row">
					<input
						id="apikey-name"
						type="text"
						bind:value={newKeyName}
						placeholder="Key name (e.g. CI Pipeline, n8n)"
						maxlength="100"
						onkeydown={(e) => e.key === 'Enter' && generateApiKey()}
					/>
					<button
						id="apikey-generate-btn"
						class="btn-primary"
						onclick={generateApiKey}
						disabled={!newKeyName.trim() || generatingKey}
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

	.account-content {
		max-width: 600px; margin: 0 auto;
		padding: var(--space-2xl);
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
		display: flex; gap: var(--space-sm); align-items: stretch;
	}
	.apikey-create-row input { flex: 1; }
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
