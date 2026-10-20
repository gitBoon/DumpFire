<!--
  DashboardHeader.svelte — The dashboard's header: the brand with its
  typewriter strapline, the navigation pills with the More menu, the theme
  picker and New Board (card 2281, slice C2: moved from src/routes/+page.svelte).

  The inbox count is the page's, which the request toasts keep current and
  this only shows. New Board opens the page's create window (`showCreate`,
  bound here, in the boards table and in the window itself).
-->
<script lang="ts">
	import { page } from '$app/stores';
	import { onMount, onDestroy } from 'svelte';
	import ThemePicker from '$lib/components/ThemePicker.svelte';

	let {
		inboxCount,
		showCreate = $bindable()
	}: {
		/** The page's: how many requests wait in the inbox, kept by the request toasts. */
		inboxCount: number;
		/** The page's: whether the create window is open. */
		showCreate: boolean;
	} = $props();

	let showMoreMenu = $state(false);

	let user = $derived($page.data.user);
	let isAdmin = $derived(user?.role === 'admin' || user?.role === 'superadmin');

	// Typewriter straplines
	const straplines = [
		'Blazingly fast local Kanban',
		'No cloud. No latency. Just speed.',
		'Ship faster, stress less.',
		'Your tasks, your rules.',
		'Drag. Drop. Done.',
		'Organise chaos, beautifully.',
		'Built for makers & doers.',
		'Zero distractions, maximum flow.',
		'Where ideas become actions.',
		'Move fast. Break nothing.'
	];
	let typedText = $state('');
	let typewriterTimer: ReturnType<typeof setTimeout> | null = null;

	function runTypewriter() {
		let lineIdx = 0;
		let charIdx = 0;
		let deleting = false;
		const TYPE_SPEED = 55;
		const DELETE_SPEED = 30;
		const PAUSE_AFTER_TYPE = 2500;
		const PAUSE_AFTER_DELETE = 400;

		function tick() {
			const currentLine = straplines[lineIdx];
			if (!deleting) {
				typedText = currentLine.slice(0, charIdx + 1);
				charIdx++;
				if (charIdx >= currentLine.length) {
					deleting = true;
					typewriterTimer = setTimeout(tick, PAUSE_AFTER_TYPE);
				} else {
					typewriterTimer = setTimeout(tick, TYPE_SPEED);
				}
			} else {
				charIdx--;
				typedText = currentLine.slice(0, charIdx);
				if (charIdx <= 0) {
					deleting = false;
					lineIdx = (lineIdx + 1) % straplines.length;
					typewriterTimer = setTimeout(tick, PAUSE_AFTER_DELETE);
				} else {
					typewriterTimer = setTimeout(tick, DELETE_SPEED);
				}
			}
		}
		tick();
	}
	onMount(() => {
		runTypewriter();
	});

	onDestroy(() => {
		if (typewriterTimer) clearTimeout(typewriterTimer);
	});
</script>

<svelte:window onclick={() => { showMoreMenu = false; }} />

<header class="dashboard-header">
	<!--
		The brand is a link home, like the logo on every other page. From the
		dashboard that is a reload rather than a navigation, which is the point:
		it is the obvious way to clear a drill-down and get back to the top.
		data-sveltekit-reload is what forces it: the client router treats a click
		on a link to the page you are already on as a no-op — loads do not re-run
		and component state survives — so nothing would visibly happen without it.
	-->
	<a href="/" class="brand" data-sveltekit-reload aria-label="DumpFire — back to the dashboard">
		<span class="brand-icon">🔥</span>
		<div>
			<h1>DumpFire</h1>
			<p class="brand-tagline"><span class="typewriter-text">{typedText}</span><span class="typewriter-cursor">|</span></p>
		</div>
	</a>
	<nav class="header-nav">
		<a href="/all" class="nav-pill">
			<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 4h12M2 8h12M2 12h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
			All Tasks
		</a>
		<a href="/todo" class="nav-pill" id="todo-link">
			<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
				<rect x="2" y="2.5" width="12" height="11" rx="2" stroke="currentColor" stroke-width="1.3"/>
				<path d="M4.8 6.2l1.2 1.2 2-2.2M9.6 6.4h2M4.8 10.2h6.8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
			</svg>
			All To Do
		</a>
		<a href="/inbox" class="nav-pill">
			<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
				<path d="M2 4l6 5 6-5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
				<rect x="1.5" y="3" width="13" height="10" rx="1.5" stroke="currentColor" stroke-width="1.2"/>
			</svg>
			Inbox
			{#if inboxCount > 0}
				<span class="inbox-count-badge">{inboxCount}</span>
			{/if}
		</a>
		<a href="/reports" class="nav-pill" id="reports-link">
			<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
				<rect x="2" y="3" width="3" height="10" rx="0.5" stroke="currentColor" stroke-width="1.2"/>
				<rect x="6.5" y="6" width="3" height="7" rx="0.5" stroke="currentColor" stroke-width="1.2"/>
				<rect x="11" y="1" width="3" height="12" rx="0.5" stroke="currentColor" stroke-width="1.2"/>
			</svg>
			Reports
		</a>
		<a href="/plan" class="nav-pill" id="plan-link">
			<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
				<circle cx="3.5" cy="8" r="1.8" stroke="currentColor" stroke-width="1.2"/>
				<circle cx="8" cy="4" r="1.8" stroke="currentColor" stroke-width="1.2"/>
				<circle cx="12.5" cy="8" r="1.8" stroke="currentColor" stroke-width="1.2"/>
				<path d="M5.2 7.1L6.4 4.9M9.6 4.9l1.2 2.2" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>
				<path d="M5.3 8.9l5.4 2.6" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-dasharray="1.5 1.5"/>
			</svg>
			Planning
		</a>
		<a href="/burndown" class="nav-pill" id="burndown-link">
			<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
				<path d="M2 2v12h12" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
				<path d="M4.5 4.5l3 3 2-1.5 3.5 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
			</svg>
			Burndown
		</a>
		<a href="/graph" class="nav-pill" id="graph-link">
			<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
				<circle cx="4" cy="4" r="2" stroke="currentColor" stroke-width="1.2"/>
				<circle cx="12" cy="4" r="2" stroke="currentColor" stroke-width="1.2"/>
				<circle cx="8" cy="12" r="2" stroke="currentColor" stroke-width="1.2"/>
				<path d="M5.5 5.5L7 10.5M10.5 5.5L9 10.5M6 4h4" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>
			</svg>
			Graph
		</a>
		<!-- More dropdown -->
		<div class="nav-more-wrapper">
			<button class="nav-pill nav-more-btn" onclick={(e) => { e.stopPropagation(); showMoreMenu = !showMoreMenu; }} id="nav-more-btn">
				<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="4" cy="8" r="1.2" fill="currentColor"/><circle cx="8" cy="8" r="1.2" fill="currentColor"/><circle cx="12" cy="8" r="1.2" fill="currentColor"/></svg>
				More
			</button>
			{#if showMoreMenu}
			<div class="nav-more-menu" onclick={(e) => e.stopPropagation()}>
				<a href="/teams" class="nav-more-item" onclick={() => showMoreMenu = false}>
					<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
						<path d="M5.5 8a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM1.5 14v-1a3.5 3.5 0 013.5-3.5h1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
						<path d="M10.5 8a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM14.5 14v-1a3.5 3.5 0 00-2.5-3.37" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
					</svg>
					Teams
				</a>
				<a href="/archived" class="nav-more-item" onclick={() => showMoreMenu = false}>
					<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
						<path d="M2 4h12v2H2zM3 6v7a1 1 0 001 1h8a1 1 0 001-1V6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
						<path d="M6.5 9h3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
					</svg>
					Archived
				</a>
				{#if isAdmin}
				<a href="/admin" class="nav-more-item" onclick={() => showMoreMenu = false}>
					<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
						<path d="M8 1l1.1 2.2 2.4.35-1.75 1.7.4 2.4L8 6.6l-2.15 1.05.4-2.4-1.75-1.7 2.4-.35L8 1z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
						<path d="M3.5 9.5v3a1 1 0 001 1h7a1 1 0 001-1v-3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
					</svg>
					Admin
				</a>
				<a href="/audit" class="nav-more-item" onclick={() => showMoreMenu = false}>
					<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
						<circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.2"/>
						<path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
						<path d="M5.5 7h3M7 5.5v3" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>
					</svg>
					Audit &amp; Logs
				</a>
				{/if}
				<a href="/request" class="nav-more-item" onclick={() => showMoreMenu = false}>
					<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
						<path d="M4 2h8a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
						<path d="M6 5h4M6 8h4M6 11h2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
					</svg>
					Request
				</a>
				<a href="/docs" class="nav-more-item" onclick={() => showMoreMenu = false}>
					<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
						<path d="M2.5 2h4l1.5 2H13.5a1 1 0 011 1v8a1 1 0 01-1 1h-11a1 1 0 01-1-1V3a1 1 0 011-1z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
						<path d="M6 8h4M6 10.5h2.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
					</svg>
					API Docs
				</a>
			</div>
			{/if}
		</div>
		<ThemePicker />
		<button class="btn-primary create-btn" onclick={() => (showCreate = true)} id="create-board-btn">
			<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
				<path d="M7 2v10M2 7h10" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
			</svg>
			New Board
		</button>
	</nav>
</header>

<style>
	/* ─── Header ─────────────────────────────────────────────────── */
	.dashboard-header {
		display: flex; align-items: center; justify-content: space-between;
		margin-bottom: var(--space-lg); padding-bottom: var(--space-md);
		border-bottom: 1px solid var(--glass-border);
	}
	.header-nav {
		display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
	}
	.nav-pill {
		display: inline-flex; align-items: center; gap: 6px;
		padding: 6px 14px; border-radius: var(--radius-full);
		font-size: 0.78rem; font-weight: 600; font-family: var(--font-family);
		color: var(--text-secondary); text-decoration: none;
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		cursor: pointer; transition: all var(--duration-fast) var(--ease-out);
		white-space: nowrap; position: relative;
	}
	.nav-pill:hover {
		color: var(--text-primary); border-color: var(--accent-indigo);
		background: rgba(99, 102, 241, 0.06); transform: translateY(-1px);
		box-shadow: 0 2px 8px rgba(99, 102, 241, 0.1);
	}
	.nav-pill svg { flex-shrink: 0; opacity: 0.7; }
	.nav-pill:hover svg { opacity: 1; }
	.nav-more-wrapper { position: relative; }
	.nav-more-menu {
		position: absolute;
		top: calc(100% + 6px);
		right: 0;
		min-width: 170px;
		background: var(--bg-surface);
		border: 1px solid var(--glass-border);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-lg);
		padding: 4px;
		z-index: 100;
		animation: navMenuSlideDown 0.15s ease-out;
	}
	@keyframes navMenuSlideDown {
		from { opacity: 0; transform: translateY(-6px); }
		to { opacity: 1; transform: translateY(0); }
	}
	.nav-more-item {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 12px;
		border-radius: var(--radius-sm);
		font-size: 0.78rem;
		font-weight: 500;
		color: var(--text-secondary);
		text-decoration: none;
		transition: all var(--duration-fast) var(--ease-out);
	}
	.nav-more-item:hover {
		color: var(--text-primary);
		background: var(--glass-hover);
	}
	.nav-more-item svg { flex-shrink: 0; opacity: 0.65; }
	.nav-more-item:hover svg { opacity: 1; }
	.create-btn { border-radius: var(--radius-full); padding: 6px 16px; font-size: 0.78rem; }
	.inbox-count-badge {
		display: inline-flex; align-items: center; justify-content: center;
		min-width: 18px; height: 18px; padding: 0 5px;
		border-radius: var(--radius-full);
		background: var(--accent-rose); color: white;
		font-size: 0.65rem; font-weight: 800; line-height: 1;
	}
	.brand {
		display: flex; align-items: center; gap: var(--space-lg); flex-shrink: 0;
		/* It is a link now, so undo the link defaults and keep the original look. */
		text-decoration: none; color: inherit;
		border-radius: var(--radius-lg);
		transition: opacity var(--duration-fast) var(--ease-out);
	}
	.brand:hover { opacity: 0.85; }
	.brand:hover .brand-icon { transform: scale(1.06) rotate(-4deg); }
	/* Keyboard users need to see where they are; the mouse has the hover state. */
	.brand:focus-visible {
		outline: 2px solid var(--accent-indigo);
		outline-offset: 4px;
	}
	.brand > div { position: relative; }
	.brand-icon {
		font-size: 2.5rem; filter: drop-shadow(0 0 12px rgba(245, 158, 11, 0.4));
		transition: transform var(--duration-fast) var(--ease-out);
	}
	.brand h1 {
		font-size: 1.75rem;
		background: linear-gradient(135deg, var(--text-primary), var(--accent-purple));
		-webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
	}
	.brand-tagline {
		color: var(--text-secondary); font-size: 0.85rem; font-weight: 400;
		position: absolute; left: 0; top: 100%; white-space: nowrap;
	}
	.typewriter-cursor {
		display: inline-block; margin-left: 1px;
		color: var(--accent-indigo); font-weight: 300;
		animation: blink-cursor 0.75s step-end infinite;
	}
	@keyframes blink-cursor { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
	@media (max-width: 768px) {
		.dashboard-header { flex-direction: column; gap: var(--space-md); align-items: flex-start; }
	}
</style>
