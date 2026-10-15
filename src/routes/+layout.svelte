<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { theme } from '$lib/stores/theme';
	import { page } from '$app/stores';
	import { beforeNavigate } from '$app/navigation';
	import { updated } from '$app/state';

	let { children } = $props();

	// A new version deployed while this page is open (card 2167). SvelteKit
	// asks for one once a minute (`version.pollInterval` in svelte.config.js),
	// and the bar below says so once it has found one. Nothing reloads by
	// itself, since a card window or a form may hold what is not yet saved;
	// but a move to another page is then a full page load, which brings the
	// new version: SvelteKit's own documented pattern.
	beforeNavigate(({ willUnload, to }) => {
		if (updated.current && !willUnload && to?.url) {
			location.href = to.url.href;
		}
	});

	// The bar's height, while it shows, as `--update-bar-space` on the page's
	// root: app.css keeps every window (`.modal-overlay`) above it, and the
	// toast rises by it, so that it covers neither (Q-F's review). It is at
	// the foot of the screen, where at the top it covered a window's title
	// and its ✕ on a phone.
	let barHeight = $state(0);
	$effect(() => {
		document.documentElement.style.setProperty('--update-bar-space', updated.current ? `${barHeight}px` : '0px');
	});

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

	<!--
		Global user badge (shown when logged in, outside login/setup pages).
		Inside .app-layout, with the pages' windows: outside it, it was drawn
		above every window and its dimmed backdrop.
	-->
	{#if user && !$page.url.pathname.startsWith('/login') && !$page.url.pathname.startsWith('/setup')}
		<div class="user-badge glass">
			<a href="/account" class="user-badge-link" title="My Account">
				<span class="user-badge-emoji">{user.emoji}</span>
				<div class="user-badge-info">
					<span class="user-badge-name">{user.username}</span>
					<span class="user-badge-role">{user.role}</span>
				</div>
			</a>
			<!-- Logout must be a POST: a GET link gets preloaded on hover/touch and would kill the session -->
			<form method="POST" action="/logout" class="user-badge-logout-form">
				<button type="submit" class="user-badge-logout" title="Sign out" aria-label="Sign out">
					<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
						<path d="M5 1H3a1 1 0 00-1 1v10a1 1 0 001 1h2M9 10l3-3m0 0L9 4m3 3H5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
					</svg>
				</button>
			</form>
		</div>
	{/if}
</div>

<!-- Outside .app-layout, whose z-index holds every page's windows beneath this. -->
{#if updated.current}
	<div class="update-bar" role="status" bind:offsetHeight={barHeight}>
		<span>DumpFire has been updated. Save anything you are editing, then reload to use the new version.</span>
		<button type="button" class="update-bar-reload" onclick={() => location.reload()}>Reload</button>
	</div>
{/if}

<style>
	.app-layout {
		min-height: 100vh;
		position: relative;
		z-index: 1;
	}

	/*
	 * A new version is out: across the foot of the window, above every window
	 * and the toast, until the page is reloaded. It cannot be closed. While it
	 * shows, the windows and the toast keep clear of it (`--update-bar-space`).
	 */
	.update-bar {
		position: fixed;
		bottom: 0;
		left: 0;
		right: 0;
		z-index: 10001;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-wrap: wrap;
		gap: var(--space-sm) var(--space-md);
		padding: var(--space-sm) var(--space-lg) calc(var(--space-sm) + env(safe-area-inset-bottom, 0px));
		background: var(--accent-indigo);
		color: white;
		font-size: 0.82rem;
		font-weight: 500;
		text-align: center;
		box-shadow: 0 -2px 12px rgba(0, 0, 0, 0.25);
	}

	.update-bar-reload {
		padding: 4px 14px;
		border: none;
		border-radius: var(--radius-sm);
		background: white;
		color: var(--accent-indigo);
		font: inherit;
		font-weight: 600;
		cursor: pointer;
	}

	.update-bar-reload:hover {
		opacity: 0.9;
	}

	/* User badge — fixed bottom-left, beneath the pages' windows (z-index 1000 and up) */
	.user-badge {
		position: fixed;
		bottom: calc(var(--space-lg) + var(--update-bar-space, 0px));
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

	.user-badge-logout-form {
		display: contents;
	}

	.user-badge-logout {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		padding: 0;
		background: none;
		border: none;
		cursor: pointer;
		font: inherit;
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
