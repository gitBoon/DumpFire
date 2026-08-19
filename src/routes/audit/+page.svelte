<script lang="ts">
	/**
	 * Audit & Logging Page — Admin-only observability hub.
	 *
	 * Two views:
	 *  - Live Console: real-time system log feed over SSE with level/context
	 *    filters, pause and smart auto-scroll.
	 *  - Audit Log: filterable history of board/card actions (activity_log).
	 */
	import type { PageData } from './$types';
	import { onMount } from 'svelte';
	import ThemePicker from '$lib/components/ThemePicker.svelte';

	let { data }: { data: PageData } = $props();

	type LogEntry = {
		id: number;
		timestamp: string;
		level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL';
		context: string;
		message: string;
		meta: string | null;
		userId: number | null;
		ip: string | null;
	};

	type AuditRow = {
		id: number;
		boardId: number;
		boardName: string;
		cardId: number | null;
		userId: number | null;
		action: string;
		detail: string;
		userName: string;
		userEmoji: string;
		createdAt: string;
	};

	const LEVEL_RANK: Record<string, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3, CRITICAL: 4 };

	let activeTab = $state<'console' | 'audit'>('console');

	const userById = new Map(data.allUsers.map(u => [u.id, u]));

	// ─── Live Console state ──────────────────────────────────────────────
	let entries = $state<LogEntry[]>([]);
	let paused = $state(false);
	let minLevel = $state('DEBUG');
	let contextFilter = $state('');
	let connected = $state(false);
	let consoleEl: HTMLDivElement | undefined = $state();
	let stickToBottom = true;

	const seenContexts = $derived([...new Set(entries.map(e => e.context))].sort());
	const visibleEntries = $derived(entries.filter(e =>
		LEVEL_RANK[e.level] >= LEVEL_RANK[minLevel] &&
		(!contextFilter || e.context === contextFilter)
	));

	function onConsoleScroll() {
		if (!consoleEl) return;
		stickToBottom = consoleEl.scrollHeight - consoleEl.scrollTop - consoleEl.clientHeight < 40;
	}

	function scrollToBottom() {
		if (consoleEl) consoleEl.scrollTop = consoleEl.scrollHeight;
	}

	$effect(() => {
		// Re-run whenever the visible list grows; keep the feed pinned to the tail
		void visibleEntries.length;
		if (!paused && stickToBottom) {
			requestAnimationFrame(scrollToBottom);
		}
	});

	onMount(() => {
		const es = new EventSource('/api/logs/stream');
		es.onopen = () => (connected = true);
		es.onerror = () => (connected = false);
		es.onmessage = (e) => {
			try {
				const entry: LogEntry = JSON.parse(e.data);
				entries = [...entries.slice(-999), entry];
			} catch { /* malformed frame — skip */ }
		};
		return () => es.close();
	});

	function fmtTime(ts: string): string {
		const d = new Date(ts);
		return d.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
	}

	function fmtMeta(meta: string | null): string {
		if (!meta) return '';
		try {
			const obj = JSON.parse(meta);
			return Object.entries(obj).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ');
		} catch {
			return meta;
		}
	}

	function userLabel(userId: number | null): string {
		if (userId === null) return '';
		const u = userById.get(userId);
		return u ? `${u.emoji ?? '👤'} ${u.username}` : `user#${userId}`;
	}

	// ─── Audit Log state ─────────────────────────────────────────────────
	let auditRows = $state<AuditRow[]>([]);
	let auditLoading = $state(false);
	let auditExhausted = $state(false);
	let auditLoaded = false;
	const AUDIT_PAGE = 100;

	let fBoardId = $state('');
	let fUserId = $state('');
	let fAction = $state('');
	let fFrom = $state('');
	let fTo = $state('');

	async function loadAudit(reset: boolean) {
		auditLoading = true;
		try {
			const params = new URLSearchParams();
			if (fBoardId) params.set('boardId', fBoardId);
			if (fUserId) params.set('userId', fUserId);
			if (fAction.trim()) params.set('action', fAction.trim());
			if (fFrom) params.set('from', fFrom);
			if (fTo) params.set('to', fTo + 'T23:59:59');
			params.set('limit', String(AUDIT_PAGE));
			params.set('offset', String(reset ? 0 : auditRows.length));

			const res = await fetch(`/api/audit?${params}`);
			if (res.ok) {
				const body = await res.json();
				auditRows = reset ? body.data : [...auditRows, ...body.data];
				auditExhausted = body.data.length < AUDIT_PAGE;
			}
		} catch { /* silent */ }
		auditLoading = false;
	}

	function openAuditTab() {
		activeTab = 'audit';
		if (!auditLoaded) {
			auditLoaded = true;
			loadAudit(true);
		}
	}

	function fmtDateTime(ts: string): string {
		const d = new Date(ts.endsWith('Z') || ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z');
		return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
	}
</script>

<svelte:head>
	<title>Audit & Logging — DumpFire</title>
</svelte:head>

<div class="audit-page">
	<header class="audit-header glass">
		<div class="audit-header-inner">
			<a href="/" class="header-logo" title="Back to DumpFire">
				<span class="logo-fire">🔥</span>
				<span class="logo-text">DumpFire</span>
			</a>
			<h1 class="header-title">🔍 Audit & Logging</h1>
			<div class="audit-header-right">
				<ThemePicker />
			</div>
		</div>
	</header>

	<div class="audit-tabs">
		<button class="audit-tab" class:active={activeTab === 'console'} onclick={() => (activeTab = 'console')}>
			<span class="live-dot" class:on={connected}></span>
			Live Console
		</button>
		<button class="audit-tab" class:active={activeTab === 'audit'} onclick={openAuditTab}>
			Audit Log
		</button>
	</div>

	{#if activeTab === 'console'}
		<div class="console-panel glass">
			<div class="console-toolbar">
				<label class="ct-field">
					<span>Min level</span>
					<select bind:value={minLevel}>
						{#each Object.keys(LEVEL_RANK) as lvl}
							<option value={lvl}>{lvl}</option>
						{/each}
					</select>
				</label>
				<label class="ct-field">
					<span>Context</span>
					<select bind:value={contextFilter}>
						<option value="">All</option>
						{#each seenContexts as ctx}
							<option value={ctx}>{ctx}</option>
						{/each}
					</select>
				</label>
				<div class="ct-spacer"></div>
				<span class="ct-status" class:live={connected}>
					{connected ? '● live' : '○ reconnecting…'}
				</span>
				<button class="ct-btn" class:warn={paused} onclick={() => { paused = !paused; if (!paused) { stickToBottom = true; scrollToBottom(); } }}>
					{paused ? '▶ Resume' : '⏸ Pause'}
				</button>
				<button class="ct-btn" onclick={() => (entries = [])}>Clear</button>
			</div>

			<div class="console-feed" bind:this={consoleEl} onscroll={onConsoleScroll}>
				{#if visibleEntries.length === 0}
					<div class="console-empty">Waiting for log entries…</div>
				{:else}
					{#each visibleEntries as entry (entry.id + entry.timestamp)}
						<div class="log-line level-{entry.level.toLowerCase()}">
							<span class="log-time">{fmtTime(entry.timestamp)}</span>
							<span class="log-level">{entry.level}</span>
							<span class="log-context">[{entry.context}]</span>
							<span class="log-message">{entry.message}</span>
							{#if entry.userId !== null}
								<span class="log-chip" title="User">{userLabel(entry.userId)}</span>
							{/if}
							{#if entry.ip}
								<span class="log-chip" title="IP address">{entry.ip}</span>
							{/if}
							{#if entry.meta}
								<span class="log-meta" title={entry.meta}>{fmtMeta(entry.meta)}</span>
							{/if}
						</div>
					{/each}
				{/if}
			</div>
			<div class="console-footer">
				{visibleEntries.length} of {entries.length} entries shown · history in <code>system_logs</code> via /api/logs
			</div>
		</div>
	{:else}
		<div class="audit-panel glass">
			<div class="console-toolbar">
				<label class="ct-field">
					<span>Board</span>
					<select bind:value={fBoardId}>
						<option value="">All</option>
						{#each data.allBoards as b}
							<option value={String(b.id)}>{b.emoji} {b.name}</option>
						{/each}
					</select>
				</label>
				<label class="ct-field">
					<span>User</span>
					<select bind:value={fUserId}>
						<option value="">All</option>
						{#each data.allUsers as u}
							<option value={String(u.id)}>{u.emoji} {u.username}</option>
						{/each}
					</select>
				</label>
				<label class="ct-field">
					<span>Action</span>
					<input type="text" placeholder="e.g. card_moved or api:*" bind:value={fAction} />
				</label>
				<label class="ct-field">
					<span>From</span>
					<input type="date" bind:value={fFrom} />
				</label>
				<label class="ct-field">
					<span>To</span>
					<input type="date" bind:value={fTo} />
				</label>
				<button class="ct-btn primary" onclick={() => loadAudit(true)}>Apply</button>
			</div>

			{#if auditLoading && auditRows.length === 0}
				<div class="console-empty">Loading audit log…</div>
			{:else if auditRows.length === 0}
				<div class="console-empty">No audit entries match these filters.</div>
			{:else}
				<div class="audit-table-wrap">
					<table class="audit-table">
						<thead>
							<tr>
								<th>When</th>
								<th>User</th>
								<th>Board</th>
								<th>Action</th>
								<th>Detail</th>
							</tr>
						</thead>
						<tbody>
							{#each auditRows as row (row.id)}
								<tr>
									<td class="at-when">{fmtDateTime(row.createdAt)}</td>
									<td class="at-user">{row.userEmoji} {row.userName || '—'}</td>
									<td class="at-board">{row.boardName}</td>
									<td><span class="at-action" class:api={row.action.startsWith('api:')}>{row.action}</span></td>
									<td class="at-detail" title={row.detail}>{row.detail}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				{#if !auditExhausted}
					<div class="audit-more">
						<button class="ct-btn" disabled={auditLoading} onclick={() => loadAudit(false)}>
							{auditLoading ? 'Loading…' : 'Load more'}
						</button>
					</div>
				{/if}
			{/if}
		</div>
	{/if}
</div>

<style>
	.audit-page {
		max-width: 1200px;
		margin: 0 auto;
		padding: var(--space-lg);
		display: flex;
		flex-direction: column;
		gap: var(--space-md);
		min-height: 100vh;
	}

	.audit-header {
		border-radius: var(--radius-lg);
		padding: var(--space-md) var(--space-lg);
	}
	.audit-header-inner { display: flex; align-items: center; gap: var(--space-lg); }
	.header-logo {
		display: flex; align-items: center; gap: var(--space-xs);
		text-decoration: none; color: var(--text-primary); font-weight: 800;
	}
	.logo-fire { font-size: 1.3rem; }
	.header-title { margin: 0; font-size: 1.05rem; flex: 1; }
	.audit-header-right { display: flex; align-items: center; gap: var(--space-sm); }

	.audit-tabs { display: flex; gap: var(--space-xs); }
	.audit-tab {
		display: flex; align-items: center; gap: 8px;
		background: none; border: 1px solid var(--glass-border);
		border-radius: var(--radius-full);
		color: var(--text-secondary); font-size: 0.8rem; font-weight: 700;
		padding: 6px 16px; cursor: pointer; transition: all 0.15s ease;
	}
	.audit-tab:hover { color: var(--text-primary); }
	.audit-tab.active { background: var(--accent-indigo); border-color: var(--accent-indigo); color: #fff; }

	.live-dot {
		width: 8px; height: 8px; border-radius: 50%;
		background: var(--text-tertiary);
	}
	.live-dot.on { background: var(--accent-emerald); box-shadow: 0 0 6px var(--accent-emerald); }

	.console-panel, .audit-panel {
		border-radius: var(--radius-lg);
		padding: var(--space-md);
		display: flex; flex-direction: column; gap: var(--space-sm);
		flex: 1;
	}

	.console-toolbar {
		display: flex; align-items: flex-end; gap: var(--space-sm); flex-wrap: wrap;
	}
	.ct-field { display: flex; flex-direction: column; gap: 2px; }
	.ct-field span {
		font-size: 0.6rem; font-weight: 700; text-transform: uppercase;
		letter-spacing: 0.05em; color: var(--text-tertiary);
	}
	.ct-field select, .ct-field input {
		background: var(--bg-surface); color: var(--text-primary);
		border: 1px solid var(--glass-border); border-radius: var(--radius-sm);
		font-size: 0.75rem; padding: 5px 8px;
	}
	.ct-spacer { flex: 1; }
	.ct-status { font-size: 0.7rem; font-weight: 700; color: var(--text-tertiary); }
	.ct-status.live { color: var(--accent-emerald); }
	.ct-btn {
		background: var(--bg-surface); color: var(--text-secondary);
		border: 1px solid var(--glass-border); border-radius: var(--radius-sm);
		font-size: 0.72rem; font-weight: 700; padding: 6px 12px;
		cursor: pointer; transition: all 0.15s ease;
	}
	.ct-btn:hover { color: var(--text-primary); border-color: var(--accent-indigo); }
	.ct-btn.warn { border-color: var(--accent-amber); color: var(--accent-amber); }
	.ct-btn.primary { background: var(--accent-indigo); border-color: var(--accent-indigo); color: #fff; }
	.ct-btn:disabled { opacity: 0.5; cursor: default; }

	/* The console keeps a fixed Catppuccin Mocha palette regardless of app
	   theme — a dark terminal with guaranteed contrast, light mode included. */
	.console-feed {
		--ctp-base: #1e1e2e;
		--ctp-mantle: #181825;
		--ctp-surface0: #313244;
		--ctp-surface1: #45475a;
		--ctp-overlay0: #6c7086;
		--ctp-overlay1: #7f849c;
		--ctp-subtext0: #a6adc8;
		--ctp-text: #cdd6f4;
		--ctp-mauve: #cba6f7;
		--ctp-blue: #89b4fa;
		--ctp-yellow: #f9e2af;
		--ctp-red: #f38ba8;
		--ctp-maroon: #eba0ac;

		font-family: 'Cascadia Code', 'Fira Code', ui-monospace, monospace;
		font-size: 0.72rem;
		line-height: 1.55;
		background: var(--ctp-base);
		border: 1px solid var(--ctp-surface0);
		border-radius: var(--radius-md);
		padding: var(--space-sm);
		height: 60vh;
		overflow-y: auto;
		overflow-x: hidden;
	}
	.console-feed::-webkit-scrollbar { width: 10px; }
	.console-feed::-webkit-scrollbar-track { background: var(--ctp-mantle); border-radius: 5px; }
	.console-feed::-webkit-scrollbar-thumb { background: var(--ctp-surface1); border-radius: 5px; }
	.console-feed::-webkit-scrollbar-thumb:hover { background: var(--ctp-overlay0); }

	.console-empty {
		color: var(--text-tertiary); text-align: center;
		padding: var(--space-2xl); font-size: 0.8rem;
	}
	.console-feed .console-empty { color: var(--ctp-overlay1); }

	.log-line {
		display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap;
		padding: 1px 4px; border-radius: 3px;
	}
	.log-line:hover { background: var(--ctp-surface0); }
	.log-time { color: var(--ctp-overlay0); flex-shrink: 0; }
	.log-level { font-weight: 800; flex-shrink: 0; min-width: 3.4em; }
	.log-context { color: var(--ctp-mauve); flex-shrink: 0; }
	.log-message { color: var(--ctp-text); }
	.log-meta {
		color: var(--ctp-overlay1);
		overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
		max-width: 40ch;
	}
	.log-chip {
		background: var(--ctp-surface0);
		border-radius: var(--radius-full);
		padding: 0 8px; font-size: 0.65rem;
		color: var(--ctp-subtext0); flex-shrink: 0;
	}

	.level-debug .log-level { color: var(--ctp-overlay1); }
	.level-info .log-level { color: var(--ctp-blue); }
	.level-warn .log-level { color: var(--ctp-yellow); }
	.level-error .log-level { color: var(--ctp-red); }
	.level-critical .log-level { color: var(--ctp-red); text-decoration: underline; }
	.level-error .log-message { color: var(--ctp-red); }
	.level-critical .log-message { color: var(--ctp-maroon); }

	.console-footer {
		font-size: 0.65rem; color: var(--text-tertiary);
	}
	.console-footer code {
		font-size: 0.65rem; background: rgba(128, 128, 128, 0.12);
		padding: 0 4px; border-radius: 3px;
	}

	.audit-table-wrap { overflow-x: auto; }
	.audit-table {
		width: 100%; border-collapse: collapse; font-size: 0.75rem;
	}
	.audit-table th {
		text-align: left; padding: 6px 10px;
		font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.05em;
		color: var(--text-tertiary); border-bottom: 1px solid var(--glass-border);
	}
	.audit-table td {
		padding: 6px 10px; border-bottom: 1px solid var(--glass-border);
		color: var(--text-secondary); vertical-align: top;
	}
	.at-when { white-space: nowrap; color: var(--text-tertiary); }
	.at-user, .at-board { white-space: nowrap; }
	.at-action {
		background: rgba(99, 102, 241, 0.12); color: var(--accent-indigo);
		border-radius: var(--radius-full); padding: 1px 8px;
		font-size: 0.68rem; font-weight: 700; white-space: nowrap;
	}
	.at-action.api { background: rgba(6, 182, 212, 0.12); color: var(--accent-cyan); }
	.at-detail {
		max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
	}
	.audit-more { display: flex; justify-content: center; padding: var(--space-sm); }
</style>
