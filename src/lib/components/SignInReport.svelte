<!--
  SignInReport.svelte — what is reported once a sign-in has passed its second
  step (card 2769, decision 16): wrong codes entered for the account since its
  last sign-in, the security banner's reason, and the account's live API keys
  and webhooks, which are how someone who held the password would stay in.
  Then Continue.

  Shown by the code page after a right code, and by the set-up page after a
  confirm (ruled 2026-11-13: a reset of two-step sign-in keeps the count and
  the banner). The report is the server's `SignInReport`, as the form's
  answer carries it.
-->
<script lang="ts">
	let {
		report
	}: {
		report: {
			wrongCodes: number;
			lastSignInAt: string | null;
			lastSignInFrom: string | null;
			banner: { words: string; at: string | null } | null;
			apiKeys: { name: string; createdAt: string; lastUsedAt: string | null }[];
			webhooks: { board: string; host: string; createdAt: string }[];
		};
	} = $props();
</script>

<div class="report">
	{#if report.wrongCodes > 0}
		<p>
			Since your last sign-in{#if report.lastSignInAt} on {report.lastSignInAt} UTC{/if}{#if report.lastSignInFrom} from {report.lastSignInFrom}{/if},
			{report.wrongCodes} wrong code{report.wrongCodes === 1 ? ' was' : 's were'} entered for your account.
		</p>
	{/if}
	{#if report.banner}
		<p>{report.banner.words}{#if report.banner.at} ({report.banner.at} UTC){/if}</p>
	{/if}
	<p><strong>If that was not you, change your password now.</strong></p>

	<h2>Your API keys</h2>
	{#if report.apiKeys.length === 0}
		<p class="none">None.</p>
	{:else}
		<ul>
			{#each report.apiKeys as key, i (i)}
				<li>{key.name}: made {key.createdAt} UTC, {key.lastUsedAt ? `last used ${key.lastUsedAt} UTC` : 'never used'}</li>
			{/each}
		</ul>
	{/if}

	<h2>Your webhooks</h2>
	{#if report.webhooks.length === 0}
		<p class="none">None.</p>
	{:else}
		<ul>
			{#each report.webhooks as hook, i (i)}
				<li>{hook.board}, to {hook.host}: made {hook.createdAt} UTC</li>
			{/each}
		</ul>
	{/if}

	<!-- A full load, so that the root layout reads the new session: a client-side
	     navigation would keep its user as it was, signed out (the review's CR2). -->
	<a class="btn-primary submit-btn" href="/" data-sveltekit-reload>Continue</a>
</div>

<style>
	.report {
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
		font-size: 0.85rem;
	}

	.report h2 {
		font-size: 0.8rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-secondary);
		margin-top: var(--space-md);
	}

	.report ul {
		margin: 0;
		padding-left: var(--space-lg);
	}

	.none {
		color: var(--text-secondary);
	}

	.submit-btn {
		width: 100%;
		padding: var(--space-md) !important;
		font-size: 0.95rem !important;
		display: flex;
		align-items: center;
		justify-content: center;
		text-decoration: none;
	}
</style>
