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

<!-- Animated background orbs -->
<div class="bg-orbs" aria-hidden="true">
	<div class="orb orb-1"></div>
	<div class="orb orb-2"></div>
	<div class="orb orb-3"></div>
</div>

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

	/* Floating ambient orbs */
	.bg-orbs {
		position: fixed;
		inset: 0;
		z-index: 0;
		overflow: hidden;
		pointer-events: none;
	}

	.orb {
		position: absolute;
		border-radius: 50%;
		will-change: transform;
	}

	/* Purple orb — top left */
	.orb-1 {
		width: 50vw; height: 50vw;
		top: -15%; left: -15%;
		background: radial-gradient(circle, rgba(124, 58, 237, 0.15) 0%, rgba(99, 102, 241, 0.06) 50%, transparent 70%);
		animation: drift1 60s ease-in-out infinite;
	}

	/* Cyan orb — bottom right */
	.orb-2 {
		width: 45vw; height: 45vw;
		bottom: -15%; right: -15%;
		background: radial-gradient(circle, rgba(6, 182, 212, 0.12) 0%, rgba(52, 211, 153, 0.05) 50%, transparent 70%);
		animation: drift2 75s ease-in-out infinite;
	}

	/* Indigo orb — center */
	.orb-3 {
		width: 35vw; height: 35vw;
		top: 35%; left: 50%;
		background: radial-gradient(circle, rgba(99, 102, 241, 0.10) 0%, rgba(124, 58, 237, 0.04) 50%, transparent 70%);
		animation: drift3 90s ease-in-out infinite;
	}

	@keyframes drift1 {
		0%, 100% { transform: translate(0, 0); }
		50% { transform: translate(8vw, 12vh); }
	}

	@keyframes drift2 {
		0%, 100% { transform: translate(0, 0); }
		50% { transform: translate(-8vw, -10vh); }
	}

	@keyframes drift3 {
		0%, 100% { transform: translate(-50%, 0); }
		50% { transform: translate(-45%, -8vh); }
	}

	/* Light theme — softer, pastel tints */
	:global(html[data-theme="light"]) .orb-1 {
		background: radial-gradient(circle, rgba(124, 58, 237, 0.08) 0%, rgba(99, 102, 241, 0.03) 50%, transparent 70%);
	}
	:global(html[data-theme="light"]) .orb-2 {
		background: radial-gradient(circle, rgba(6, 182, 212, 0.07) 0%, rgba(52, 211, 153, 0.03) 50%, transparent 70%);
	}
	:global(html[data-theme="light"]) .orb-3 {
		background: radial-gradient(circle, rgba(99, 102, 241, 0.05) 0%, rgba(124, 58, 237, 0.02) 50%, transparent 70%);
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
