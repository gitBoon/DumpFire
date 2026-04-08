<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionData } from './$types';

	let { form }: { form: ActionData } = $props();

	let showPassword = $state(false);
	let selectedEmoji = $state('🔥');
	let username = $state(form?.username ?? '');
	let email = $state(form?.email ?? '');

	const emojiOptions = ['🔥', '👤', '🦊', '🐱', '🐶', '🦁', '🐼', '🐸', '🦉', '🐙', '🦄', '🐝', '🐳', '🚀', '⚡', '💎', '🎯', '🛡️'];
</script>

<svelte:head>
	<title>Setup — DumpFire</title>
</svelte:head>

<div class="setup-page">
	<div class="setup-container glass">
		<div class="setup-header">
			<span class="setup-icon">🔥</span>
			<h1>Welcome to DumpFire</h1>
			<p class="setup-subtitle">Create your superadmin account to get started.</p>
		</div>

		{#if form?.error}
			<div class="error-banner">
				<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.5v4M8 10.5v.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
				{form.error}
			</div>
		{/if}

		<form method="POST" use:enhance class="setup-form">
			<input type="hidden" name="emoji" value={selectedEmoji} />

			<div class="form-group">
				<label for="setup-username">Username</label>
				<input
					id="setup-username"
					name="username"
					type="text"
					placeholder="e.g. admin"
					bind:value={username}
					autocomplete="username"
					autofocus
					required
				/>
			</div>

			<div class="form-group">
				<label for="setup-email">Email</label>
				<input
					id="setup-email"
					name="email"
					type="email"
					placeholder="admin@example.com"
					bind:value={email}
					autocomplete="email"
					required
				/>
			</div>

			<div class="form-group">
				<label for="setup-password">Password</label>
				<div class="password-wrapper">
					<input
						id="setup-password"
						name="password"
						type={showPassword ? 'text' : 'password'}
						placeholder="Minimum 8 characters"
						autocomplete="new-password"
						minlength="8"
						required
					/>
					<button type="button" class="password-toggle" onclick={() => (showPassword = !showPassword)}>
						{showPassword ? '🙈' : '👁️'}
					</button>
				</div>
			</div>

			<div class="form-group">
				<label for="setup-confirm">Confirm Password</label>
				<input
					id="setup-confirm"
					name="confirmPassword"
					type={showPassword ? 'text' : 'password'}
					placeholder="Re-enter password"
					autocomplete="new-password"
					minlength="8"
					required
				/>
			</div>

			<div class="form-group">
				<label>Avatar</label>
				<div class="emoji-grid">
					{#each emojiOptions as emoji}
						<button
							type="button"
							class="emoji-btn"
							class:active={selectedEmoji === emoji}
							onclick={() => (selectedEmoji = emoji)}
						>
							{emoji}
						</button>
					{/each}
				</div>
			</div>

			<button type="submit" class="btn-primary submit-btn">
				<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M13.5 2.5l-8 8L2 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
				Create Account & Start
			</button>
		</form>

		<div class="setup-footer">
			<span class="shield-icon">🛡️</span>
			<p>This creates the <strong>superadmin</strong> account. You can add more users from the admin panel later.</p>
		</div>
	</div>
</div>

<style>
	.setup-page {
		min-height: 100vh;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: var(--space-xl);
	}

	.setup-container {
		width: 100%;
		max-width: 460px;
		padding: var(--space-2xl);
		border-radius: var(--radius-xl);
		animation: fadeInUp 0.5s ease-out;
	}

	.setup-header {
		text-align: center;
		margin-bottom: var(--space-2xl);
	}

	.setup-icon {
		font-size: 3rem;
		display: block;
		margin-bottom: var(--space-md);
		animation: bounceIn 0.6s ease-out;
	}

	.setup-header h1 {
		font-size: 1.5rem;
		margin-bottom: var(--space-xs);
		background: linear-gradient(135deg, var(--text-primary), var(--accent-purple));
		-webkit-background-clip: text;
		-webkit-text-fill-color: transparent;
		background-clip: text;
	}

	.setup-subtitle {
		color: var(--text-secondary);
		font-size: 0.85rem;
	}

	.error-banner {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
		padding: var(--space-md) var(--space-lg);
		background: rgba(244, 63, 94, 0.1);
		border: 1px solid rgba(244, 63, 94, 0.3);
		border-radius: var(--radius-md);
		color: var(--accent-rose);
		font-size: 0.85rem;
		font-weight: 500;
		margin-bottom: var(--space-xl);
	}

	.setup-form {
		display: flex;
		flex-direction: column;
		gap: var(--space-lg);
	}

	.form-group label {
		display: block;
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--text-secondary);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		margin-bottom: var(--space-sm);
	}

	.password-wrapper {
		position: relative;
	}

	.password-wrapper input {
		padding-right: 3rem;
	}

	.password-toggle {
		position: absolute;
		right: 8px;
		top: 50%;
		transform: translateY(-50%);
		background: none;
		border: none;
		font-size: 1rem;
		cursor: pointer;
		padding: 4px;
		opacity: 0.6;
		transition: opacity 0.15s;
	}

	.password-toggle:hover {
		opacity: 1;
	}

	.emoji-grid {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-xs);
	}

	.emoji-btn {
		width: 40px;
		height: 40px;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 1.2rem;
		border-radius: var(--radius-md);
		background: var(--bg-base);
		border: 1px solid var(--glass-border);
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.emoji-btn:hover {
		border-color: var(--accent-purple);
		background: var(--bg-elevated);
		transform: scale(1.1);
	}

	.emoji-btn.active {
		border-color: var(--accent-purple);
		background: var(--accent-purple-glow);
		box-shadow: var(--shadow-glow-purple);
		transform: scale(1.1);
	}

	.submit-btn {
		width: 100%;
		padding: var(--space-md) !important;
		font-size: 0.95rem !important;
		margin-top: var(--space-md);
		display: flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-sm);
	}

	.setup-footer {
		margin-top: var(--space-2xl);
		text-align: center;
		padding-top: var(--space-lg);
		border-top: 1px solid var(--glass-border);
	}

	.shield-icon {
		font-size: 1.3rem;
		display: block;
		margin-bottom: var(--space-xs);
	}

	.setup-footer p {
		font-size: 0.78rem;
		color: var(--text-tertiary);
		line-height: 1.5;
	}

	.setup-footer strong {
		color: var(--accent-amber);
	}

	@keyframes fadeInUp {
		from { opacity: 0; transform: translateY(20px); }
		to { opacity: 1; transform: translateY(0); }
	}

	@keyframes bounceIn {
		0% { transform: scale(0); opacity: 0; }
		60% { transform: scale(1.2); opacity: 1; }
		100% { transform: scale(1); }
	}
</style>
