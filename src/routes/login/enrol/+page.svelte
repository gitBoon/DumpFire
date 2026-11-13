<script lang="ts">
	import { enhance } from '$app/forms';
	import SignInReport from '$lib/components/SignInReport.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let submitting = $state(false);

	/** A six-digit code, or two groups of three with a space between (the review's CR11). */
	const CODE_PATTERN = '\\d{3} ?\\d{3}';

	/** The report after a confirm, when there is something to report (card 2769, decision 16, as on the code page). */
	let report = $derived(form && 'signedIn' in form ? form.report : null);
	let failure = $derived(form && 'error' in form ? form : null);
</script>

<svelte:head>
	<title>Set Up Two-Step Sign-In — DumpFire</title>
</svelte:head>

<div class="enrol-page">
	<div class="enrol-container glass">
		<div class="enrol-header">
			<span class="enrol-icon">🔐</span>
			{#if report}
				<h1>You are signed in</h1>
			{:else}
				<h1>Set up two-step sign-in</h1>
				{#if data.stage === 'secret_shown' || data.stage === 'codes_shown'}
					<p class="enrol-subtitle">For <strong>{data.username}</strong></p>
				{/if}
			{/if}
		</div>

		{#if failure}
			<div class="error-banner" role="alert" id="enrol-error">
				<p>{failure.error}</p>
				{#if failure.restart}
					<p><a href="/login">Sign in again</a></p>
				{/if}
			</div>
		{/if}

		{#if report}
			<SignInReport {report} />
		{:else if failure?.restart}
			<!-- The set-up has ended: only the way back to the sign-in page (CR11). -->
		{:else if data.stage === 'secret_shown'}
			<ol class="steps">
				<li>Open an authenticator app on your phone and scan this QR code.</li>
			</ol>
			<img class="qr" src={data.qr} alt="QR code to scan with your authenticator app" width="220" height="220" />
			<p class="manual">
				Or add it by hand: account <strong>{data.username}</strong>, issuer <strong>{data.issuer}</strong>, key
			</p>
			<p class="secret"><code>{data.secret}</code></p>

			<form method="POST" action="?/code" use:enhance={() => {
				submitting = true;
				return async ({ update }) => {
					submitting = false;
					await update();
				};
			}} class="enrol-form">
				<div class="form-group">
					<label for="enrol-code">Then enter the code the app shows</label>
					<!-- svelte-ignore a11y_autofocus -->
					<input
						id="enrol-code"
						name="code"
						type="text"
						inputmode="numeric"
						autocomplete="one-time-code"
						pattern={CODE_PATTERN}
						maxlength="7"
						placeholder="123456"
						aria-invalid={failure ? 'true' : undefined}
						aria-describedby={failure ? 'enrol-error' : undefined}
						autofocus
						required
					/>
				</div>
				<button type="submit" class="btn-primary submit-btn" disabled={submitting}>
					{submitting ? 'Checking…' : 'Continue'}
				</button>
			</form>
		{:else if data.stage === 'codes_shown'}
			<p class="manual">
				These are your recovery codes. Each works once if you lose your phone. They will not be shown again: save
				them somewhere safe now.
			</p>
			<ul class="codes">
				{#each data.codes as code (code)}
					<li><code>{code}</code></li>
				{/each}
			</ul>

			<!-- The answer is shown where it is: reloading the page's data would
			     send a browser that is now signed in away from the report. -->
			<form method="POST" action="?/confirm" use:enhance={() => {
				submitting = true;
				return async ({ update }) => {
					submitting = false;
					await update({ invalidateAll: false });
				};
			}} class="enrol-form">
				<button type="submit" class="btn-primary submit-btn" disabled={submitting}>
					{submitting ? 'Finishing…' : 'I have saved these codes'}
				</button>
			</form>
		{/if}
	</div>
</div>

<style>
	.enrol-page {
		min-height: 100vh;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: var(--space-xl);
	}

	.enrol-container {
		width: 100%;
		max-width: 460px;
		padding: var(--space-2xl);
		border-radius: var(--radius-xl);
	}

	.enrol-header {
		text-align: center;
		margin-bottom: var(--space-xl);
	}

	.enrol-icon {
		font-size: 2.5rem;
		display: block;
		margin-bottom: var(--space-md);
	}

	.enrol-header h1 {
		font-size: 1.5rem;
		margin-bottom: var(--space-xs);
	}

	.enrol-subtitle {
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

	.steps {
		margin: 0 0 var(--space-md);
		padding-left: var(--space-lg);
		font-size: 0.85rem;
	}

	.qr {
		display: block;
		margin: 0 auto var(--space-md);
		background: white;
		padding: var(--space-sm);
		border-radius: var(--radius-md);
	}

	.manual {
		font-size: 0.85rem;
		color: var(--text-secondary);
		margin-bottom: var(--space-sm);
	}

	.secret {
		text-align: center;
		margin-bottom: var(--space-xl);
	}

	.secret code,
	.codes code {
		font-size: 0.95rem;
		letter-spacing: 0.05em;
		user-select: all;
	}

	.codes {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--space-sm);
		list-style: none;
		padding: 0;
		margin: 0 0 var(--space-xl);
	}

	.enrol-form {
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
</style>
