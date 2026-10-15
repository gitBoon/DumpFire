<script lang="ts">
	/**
	 * Confirm a request submitted without an account.
	 *
	 * Reached from the link in the confirmation email. Nothing happens until the
	 * button is pressed: mail scanners open the links in a message before its
	 * recipient does, and a page that confirmed on load would let a request made
	 * with somebody else's address confirm itself.
	 */
	import { page } from '$app/stores';

	let requestId = $derived(Number($page.params.id));
	let token = $derived($page.url.searchParams.get('token') || '');

	type Outcome = { title: string; replyUrl: string; alreadyConfirmed: boolean };

	let confirming = $state(false);
	let outcome = $state<Outcome | null>(null);
	let errorMsg = $state('');

	async function confirm() {
		confirming = true;
		errorMsg = '';
		try {
			const res = await fetch(`/api/requests/${requestId}/confirm`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ token })
			});
			if (res.ok) {
				outcome = await res.json();
			} else {
				const failure = await res.json().catch(() => ({}));
				errorMsg = failure.message || 'This confirmation link is not valid.';
			}
		} catch {
			errorMsg = 'Could not reach the server. Check your connection and try again.';
		}
		confirming = false;
	}
</script>

<svelte:head>
	<title>Confirm Your Request — DumpFire</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="confirm-page">
	<div class="confirm-container">
		{#if outcome}
			<div class="confirm-icon">✅</div>
			<h1>{outcome.alreadyConfirmed ? 'Already Confirmed' : 'Request Confirmed'}</h1>
			<p>
				<strong>{outcome.title}</strong> has been passed to the team. You will get an
				email when they reply.
			</p>
			<a href={outcome.replyUrl} class="btn-primary">View the conversation</a>
		{:else if !token}
			<div class="confirm-icon">❌</div>
			<h1>Link Incomplete</h1>
			<p>This link is missing its confirmation code. Open the link from the email again.</p>
		{:else}
			<div class="confirm-icon">📧</div>
			<h1>Confirm Your Request</h1>
			<p>
				Press the button to confirm that you submitted this request. It is passed to the
				team once you do. If you did not submit it, close this page and nothing further
				will happen.
			</p>
			{#if errorMsg}
				<div class="error-msg">{errorMsg}</div>
			{/if}
			<button class="btn-primary" onclick={confirm} disabled={confirming}>
				{confirming ? 'Confirming…' : 'Confirm my request'}
			</button>
		{/if}
	</div>
</div>

<style>
	.confirm-page {
		min-height: 100vh;
		display: flex; align-items: center; justify-content: center;
		padding: var(--space-xl);
		background: var(--bg-primary);
	}
	.confirm-container {
		width: 100%; max-width: 520px;
		background: var(--bg-card);
		border: 1px solid var(--glass-border);
		border-radius: var(--radius-lg);
		padding: var(--space-2xl);
		box-shadow: var(--shadow-lg);
		text-align: center;
	}
	.confirm-icon { font-size: 3rem; margin-bottom: var(--space-md); }
	h1 { font-size: 1.4rem; font-weight: 700; color: var(--text-primary); margin-bottom: var(--space-sm); }
	p { color: var(--text-secondary); margin-bottom: var(--space-lg); font-size: 0.9rem; line-height: 1.5; }
	.btn-primary {
		display: inline-block;
		padding: 10px 24px; background: var(--accent-indigo); color: white;
		border: none; border-radius: var(--radius-md); font-weight: 600;
		font-size: 0.85rem; cursor: pointer; font-family: var(--font-family);
		text-decoration: none;
		transition: all var(--duration-fast) var(--ease-out);
	}
	.btn-primary:hover:not(:disabled) { background: #5558e6; }
	.btn-primary:disabled { opacity: 0.6; cursor: default; }
	.error-msg {
		color: var(--accent-red, #ef4444);
		font-size: 0.85rem;
		margin-bottom: var(--space-md);
	}
</style>
