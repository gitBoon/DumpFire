<script lang="ts">
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>Set Up Two-Step Sign-In — DumpFire</title>
</svelte:head>

<div class="link-page">
	<div class="link-container glass">
		<div class="link-header">
			<span class="link-icon">🔐</span>
			<h1>Set up two-step sign-in</h1>
		</div>

		{#if data.state === 'good'}
			<p class="link-words">
				This link sets up two-step sign-in for <strong>{data.username}</strong>. Sign in with your password to continue.
			</p>
			<a class="btn-primary submit-btn" href="/login">Sign in</a>
		{:else}
			<p class="link-words" role="status">{data.words}</p>
		{/if}
	</div>
</div>

<style>
	.link-page {
		min-height: 100vh;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: var(--space-xl);
	}

	.link-container {
		width: 100%;
		max-width: 460px;
		padding: var(--space-2xl);
		border-radius: var(--radius-xl);
	}

	.link-header {
		text-align: center;
		margin-bottom: var(--space-xl);
	}

	.link-icon {
		font-size: 2.5rem;
		display: block;
		margin-bottom: var(--space-md);
	}

	.link-header h1 {
		font-size: 1.5rem;
		margin-bottom: var(--space-xs);
	}

	.link-words {
		font-size: 0.9rem;
		line-height: 1.6;
		margin-bottom: var(--space-xl);
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
