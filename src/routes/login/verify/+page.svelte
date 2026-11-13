<script lang="ts">
	import { enhance } from '$app/forms';
	import SignInReport from '$lib/components/SignInReport.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	/** A six-digit code, or two groups of three with a space between (the review's CR11). */
	const CODE_PATTERN = '\\d{3} ?\\d{3}';

	/** Which field is shown: the recovery code from the start while authenticator codes are locked (CR11); the switch below changes it. */
	let useRecoveryCode = $derived(data.codesLocked);
	let submitting = $state(false);

	/** The report after a right code, when there is something to report (card 2769, decision 16). */
	let report = $derived(form && 'signedIn' in form ? form.report : null);
	let failure = $derived(form && 'error' in form ? form : null);
</script>

<svelte:head>
	<title>Two-Step Sign-In — DumpFire</title>
</svelte:head>

<div class="verify-page">
	<div class="verify-container glass">
		<div class="verify-header">
			<span class="verify-icon">🔐</span>
			{#if report}
				<h1>You are signed in</h1>
			{:else}
				<h1>Two-step sign-in</h1>
				{#if data.username}
					<p class="verify-subtitle">Signing in as <strong>{data.username}</strong></p>
				{/if}
			{/if}
		</div>

		{#if report}
			<SignInReport {report} />
		{:else}
			{#if failure}
				<div class="error-banner" role="alert" id="verify-error">
					<p>{failure.error}</p>
					{#if failure.restart}
						<p><a href="/login">Sign in again</a></p>
					{/if}
				</div>
			{:else if data.codesNotice}
				<div class="error-banner" role="status">
					<p>{data.codesNotice}</p>
				</div>
			{/if}

			<!-- After an answer that ends the sign-in, only the way back to the
			     sign-in page (CR11). The answer is shown where it is: reloading
			     the page's data would send a browser that is now signed in away
			     from the report. -->
			{#if !failure?.restart}
				<form method="POST" use:enhance={() => {
					submitting = true;
					return async ({ result, update }) => {
						submitting = false;
						// Locked: the recovery code is the way on (CR11).
						if (result.type === 'failure' && result.status === 403) useRecoveryCode = true;
						await update({ invalidateAll: false });
					};
				}} class="verify-form">
					{#if useRecoveryCode}
						<div class="form-group">
							<label for="verify-recovery">Recovery code</label>
							<!-- svelte-ignore a11y_autofocus -->
							<input
								id="verify-recovery"
								name="recoveryCode"
								type="text"
								placeholder="XXXX-XXXX-XXXX-XXXX"
								autocomplete="off"
								autocapitalize="characters"
								autocorrect="off"
								spellcheck="false"
								aria-invalid={failure ? 'true' : undefined}
								aria-describedby={failure ? 'verify-error' : undefined}
								autofocus
								required
							/>
						</div>
					{:else}
						<div class="form-group">
							<label for="verify-code">Code from your authenticator app</label>
							<!-- svelte-ignore a11y_autofocus -->
							<input
								id="verify-code"
								name="code"
								type="text"
								inputmode="numeric"
								autocomplete="one-time-code"
								pattern={CODE_PATTERN}
								maxlength="7"
								placeholder="123456"
								aria-invalid={failure ? 'true' : undefined}
								aria-describedby={failure ? 'verify-error' : undefined}
								autofocus
								required
							/>
						</div>
					{/if}

					<button type="submit" class="btn-primary submit-btn" disabled={submitting}>
						{submitting ? 'Checking…' : 'Sign In'}
					</button>
					<button type="button" class="switch" onclick={() => (useRecoveryCode = !useRecoveryCode)}>
						{useRecoveryCode ? 'Use a code from your authenticator app instead' : 'Use a recovery code instead'}
					</button>
				</form>
			{/if}
		{/if}
	</div>
</div>

<style>
	.verify-page {
		min-height: 100vh;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: var(--space-xl);
	}

	.verify-container {
		width: 100%;
		max-width: 460px;
		padding: var(--space-2xl);
		border-radius: var(--radius-xl);
	}

	.verify-header {
		text-align: center;
		margin-bottom: var(--space-xl);
	}

	.verify-icon {
		font-size: 2.5rem;
		display: block;
		margin-bottom: var(--space-md);
	}

	.verify-header h1 {
		font-size: 1.5rem;
		margin-bottom: var(--space-xs);
	}

	.verify-subtitle {
		color: var(--text-secondary);
		font-size: 0.85rem;
	}

	.error-banner {
		padding: var(--space-md) var(--space-lg);
		background: rgba(244, 63, 94, 0.1);
		border: 1px solid rgba(244, 63, 94, 0.3);
		border-radius: var(--radius-md);
		color: var(--accent-rose);
		font-size: 0.85rem;
		font-weight: 500;
		margin-bottom: var(--space-xl);
	}

	.error-banner p {
		margin: 0;
	}

	.error-banner a {
		color: inherit;
		text-decoration: underline;
	}

	.verify-form {
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

	.submit-btn {
		width: 100%;
		padding: var(--space-md) !important;
		font-size: 0.95rem !important;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.switch {
		background: none;
		border: none;
		color: var(--text-secondary);
		font-size: 0.8rem;
		text-decoration: underline;
		cursor: pointer;
	}
</style>
