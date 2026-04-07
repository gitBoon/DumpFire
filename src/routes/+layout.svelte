<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { theme } from '$lib/stores/theme';
	import { page } from '$app/stores';

	let { children } = $props();

	let currentTheme = $state('light');
	theme.subscribe((v) => (currentTheme = v));

	// Get user from page data (set by +layout.server.ts)
	let user = $derived($page.data.user);

	onMount(() => {
		// Initialize theme from localStorage on mount
		const saved = localStorage.getItem('dumpfire-theme');
		if (saved === 'light' || saved === 'dark') {
			theme.set(saved);
		}
	});
</script>

<svelte:head>
	<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🔥</text></svg>" />
	<script>
		// Prevent flash of wrong theme
		(function() {
			const t = localStorage.getItem('dumpfire-theme');
			if (t) document.documentElement.setAttribute('data-theme', t);
		})();
	</script>
</svelte:head>

<div class="app-layout">
	{@render children()}
</div>

<!-- Global user badge (shown when logged in, outside login/setup pages) -->
{#if user && !$page.url.pathname.startsWith('/login') && !$page.url.pathname.startsWith('/setup')}
	<div class="user-badge glass">
		<a href="/account" class="user-badge-link" title="My Account">
			<span class="user-badge-emoji">{user.emoji}</span>
			<div class="user-badge-info">
				<span class="user-badge-name">{user.username}</span>
				<span class="user-badge-role">{user.role}</span>
			</div>
		</a>
		<a href="/logout" class="user-badge-logout" title="Sign out">
			<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
				<path d="M5 1H3a1 1 0 00-1 1v10a1 1 0 001 1h2M9 10l3-3m0 0L9 4m3 3H5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
			</svg>
		</a>
	</div>
{/if}

<style>
	.app-layout {
		min-height: 100vh;
		position: relative;
		z-index: 1;
	}

	/* User badge — fixed bottom-left */
	.user-badge {
		position: fixed;
		bottom: var(--space-lg);
		left: var(--space-lg);
		z-index: 100;
		display: flex;
		align-items: center;
		gap: var(--space-sm);
		padding: var(--space-sm) var(--space-md);
		border-radius: var(--radius-full);
		font-size: 0.8rem;
		animation: fadeInUp 0.4s ease-out;
	}

	.user-badge-link {
		display: flex; align-items: center; gap: var(--space-sm);
		text-decoration: none; color: inherit;
		transition: opacity 0.15s;
	}
	.user-badge-link:hover { opacity: 0.8; }

	.user-badge-emoji {
		font-size: 1.2rem;
		flex-shrink: 0;
	}

	.user-badge-info {
		display: flex;
		flex-direction: column;
		line-height: 1.2;
	}

	.user-badge-name {
		font-weight: 600;
		color: var(--text-primary);
		font-size: 0.78rem;
	}

	.user-badge-role {
		font-size: 0.65rem;
		color: var(--text-tertiary);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		font-weight: 600;
	}

	.user-badge-logout {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border-radius: var(--radius-sm);
		color: var(--text-tertiary);
		transition: all 0.15s ease;
		margin-left: var(--space-xs);
	}

	.user-badge-logout:hover {
		background: rgba(244, 63, 94, 0.15);
		color: var(--accent-rose);
	}


	@keyframes fadeInUp {
		from { opacity: 0; transform: translateY(10px); }
		to { opacity: 1; transform: translateY(0); }
	}
</style>
