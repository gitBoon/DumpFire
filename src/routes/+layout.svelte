<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { theme } from '$lib/stores/theme';

	let { children } = $props();

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
</style>
