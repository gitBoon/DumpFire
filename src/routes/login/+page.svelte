<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionData } from './$types';

	let { form }: { form: ActionData } = $props();

	let showPassword = $state(false);
	let submitting = $state(false);
	let clientError = $state('');
	let isOriginError = $state(false);
</script>

<svelte:head>
	<title>Login — DumpFire</title>
</svelte:head>

<div class="login-page">
	<div class="login-container glass">
		<div class="login-header">
			<span class="login-icon">🔥</span>
			<h1>DumpFire</h1>
			<p class="login-subtitle">Sign in to your account</p>
		</div>

		{#if form?.error || clientError}
			<div class="error-banner" class:origin-error={isOriginError}>
				<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.5v4M8 10.5v.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
				<div>
					<p>{form?.error || clientError}</p>
					{#if isOriginError}
						<p class="origin-hint">The <code>ORIGIN</code> environment variable doesn't match the URL you're using to access DumpFire. Update it to <code>{typeof window !== 'undefined' ? window.location.origin : ''}</code> and restart the container.</p>
					{/if}
				</div>
			</div>
		{/if}

		<form method="POST" use:enhance={() => {
			clientError = '';
			isOriginError = false;
			submitting = true;
			return async ({ result, update }) => {
				submitting = false;
				if (result.type === 'error') {
					if (result.status === 403) {
						clientError = 'Request blocked — ORIGIN mismatch detected.';
						isOriginError = true;
					} else {
						clientError = result.error?.message || `Server error (${result.status}).`;
					}
				} else if (result.type === 'failure') {
					await update();
				} else {
					await update();
				}
			};
		}} class="login-form">
			<div class="form-group">
				<label for="login-identity">Username or Email</label>
				<input
					id="login-identity"
					name="identity"
					type="text"
					placeholder="Enter your username or email"
					value={form?.identity ?? ''}
					autocomplete="username"
					autofocus
					required
				/>
			</div>

			<div class="form-group">
				<label for="login-password">Password</label>
				<div class="password-wrapper">
					<input
						id="login-password"
						name="password"
						type={showPassword ? 'text' : 'password'}
						placeholder="Enter your password"
						autocomplete="current-password"
						required
					/>
					<button type="button" class="password-toggle" onclick={() => (showPassword = !showPassword)}>
						{showPassword ? '🙈' : '👁️'}
					</button>
				</div>
			</div>

			<button type="submit" class="btn-primary submit-btn">
				<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6 2l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
				Sign In
			</button>
		</form>
	</div>
</div>

<style>
	.login-page {
		min-height: 100vh;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: var(--space-xl);
	}

	.login-container {
		width: 100%;
		max-width: 420px;
		padding: var(--space-2xl);
		border-radius: var(--radius-xl);
		animation: fadeInUp 0.5s ease-out;
	}

	.login-header {
		text-align: center;
		margin-bottom: var(--space-2xl);
	}

	.login-icon {
		font-size: 3rem;
		display: block;
		margin-bottom: var(--space-md);
		animation: bounceIn 0.6s ease-out;
		filter: drop-shadow(0 0 12px rgba(245, 158, 11, 0.4));
	}

	.login-header h1 {
		font-size: 1.75rem;
		margin-bottom: var(--space-xs);
		background: linear-gradient(135deg, var(--text-primary), var(--accent-purple));
		-webkit-background-clip: text;
		-webkit-text-fill-color: transparent;
		background-clip: text;
	}

	.login-subtitle {
		color: var(--text-secondary);
		font-size: 0.85rem;
	}

	.error-banner {
		display: flex;
		align-items: flex-start;
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

	.error-banner svg {
		flex-shrink: 0;
		margin-top: 2px;
	}

	.error-banner.origin-error {
		background: rgba(245, 158, 11, 0.1);
		border-color: rgba(245, 158, 11, 0.4);
		color: var(--accent-amber);
	}

	.error-banner p {
		margin: 0;
	}

	.origin-hint {
		margin-top: var(--space-xs) !important;
		font-size: 0.78rem;
		font-weight: 400;
		line-height: 1.5;
		opacity: 0.9;
	}

	.origin-hint code {
		background: rgba(0, 0, 0, 0.15);
		padding: 1px 5px;
		border-radius: 3px;
		font-size: 0.75rem;
		font-family: 'Courier New', monospace;
	}

	.login-form {
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

	.submit-btn {
		width: 100%;
		padding: var(--space-md) !important;
		font-size: 0.95rem !important;
		margin-top: var(--space-sm);
		display: flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-sm);
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
