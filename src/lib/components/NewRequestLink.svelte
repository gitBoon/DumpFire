<script lang="ts">
	/**
	 * What a request's page shows for a link that no longer works (card 2158):
	 * the reply page in place of the thread, and the confirm page under its
	 * refusal.
	 *
	 * A link stops working when its request's token is replaced: every request's
	 * once, on the deploy that carried migration 0055, and every request's again
	 * at each restore. The requester gives the address they made the request
	 * with, and the server mails the current link to the request's address
	 * (`POST /api/requests/[id]/link`): the one given, or for a request made
	 * signed in the account's email as it is now (card 2171), which is why the
	 * page says so. Its answer is one sentence, the same whether or not anything
	 * was sent, and that sentence is what is shown.
	 */
	import { failureMessage } from '$lib/api';

	let { requestId }: { requestId: number } = $props();

	/** What the page says before anything is asked. */
	const LINK_GONE =
		"This link no longer works. Enter the email address you made the request with (if you made it while signed in to DumpFire, your account's email address as it is now), and a new link will be sent to it.";

	let email = $state('');
	let asking = $state(false);
	/** The server's sentence, once it has answered. */
	let answered = $state('');
	let refused = $state('');

	async function askForLink() {
		if (!email.trim() || asking) return;
		asking = true;
		refused = '';
		try {
			const res = await fetch(`/api/requests/${requestId}/link`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email: email.trim() })
			});
			if (res.ok) {
				const answer = await res.json().catch(() => ({}));
				answered =
					typeof answer.message === 'string'
						? answer.message
						: 'If that is the address the request was made with, a new link has been sent to it.';
			} else {
				refused = await failureMessage(res, 'A new link could not be asked for. Try again later.');
			}
		} catch {
			refused = 'Could not reach the server. Check your connection and try again.';
		}
		asking = false;
	}
</script>

<div class="new-link">
	{#if answered}
		<p class="new-link-text">{answered}</p>
		<p class="new-link-hint">It can take a few minutes to arrive.</p>
	{:else}
		<p class="new-link-text">{LINK_GONE}</p>
		<form
			class="new-link-form"
			onsubmit={(e) => {
				e.preventDefault();
				askForLink();
			}}
		>
			<input
				type="email"
				class="new-link-input"
				bind:value={email}
				placeholder="you@example.com"
				autocomplete="email"
				aria-label="The email address you made the request with"
				required
			/>
			<button type="submit" class="new-link-button" disabled={asking || !email.trim()}>
				{asking ? 'Sending…' : 'Send me a new link'}
			</button>
		</form>
		{#if refused}
			<div class="new-link-error">{refused}</div>
		{/if}
	{/if}
	<!-- Shown in every state, before and after the answer, so it says nothing
	     of whether this request lapsed: the link route answers a lapsed
	     request as one that is not there (card 2243). -->
	<p class="new-link-lapsed">A request not confirmed within seven days is no longer kept; make it again at <a href="/request">/request</a>.</p>
</div>

<style>
	.new-link { text-align: center; }
	.new-link-text { color: var(--text-secondary); font-size: 0.9rem; line-height: 1.5; margin-bottom: var(--space-md); }
	.new-link-hint { color: var(--text-tertiary); font-size: 0.8rem; }
	.new-link-lapsed { margin-top: var(--space-md); color: var(--text-tertiary); font-size: 0.8rem; line-height: 1.5; }
	.new-link-lapsed a { color: var(--accent-indigo); }
	.new-link-form { display: flex; gap: var(--space-sm); justify-content: center; flex-wrap: wrap; }
	.new-link-input {
		flex: 1 1 220px; max-width: 320px; padding: 8px 12px;
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		border-radius: var(--radius-md); color: var(--text-primary);
		font-family: var(--font-family); font-size: 0.85rem;
	}
	.new-link-input:focus { outline: none; border-color: var(--accent-indigo); box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1); }
	.new-link-button {
		padding: 8px 18px; background: var(--accent-indigo); color: white; border: none;
		border-radius: var(--radius-md); font-weight: 600; font-size: 0.82rem;
		cursor: pointer; font-family: var(--font-family);
	}
	.new-link-button:hover:not(:disabled) { background: #5558e6; }
	.new-link-button:disabled { opacity: 0.5; cursor: not-allowed; }
	.new-link-error {
		margin-top: var(--space-sm);
		color: var(--accent-red, #ef4444);
		font-size: 0.8rem;
	}
</style>
