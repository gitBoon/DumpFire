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
	import { parseStamp } from '$lib/timestamps';
	import { failureMessage } from '$lib/api';

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
	// The browser has given up on the stream for good, and will not reconnect.
	let disconnected = $state(false);
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
		// The last entry shown. On reconnecting, the stream sends its last 100
		// entries again before the new ones, and those already shown are
		// skipped: each has an id at or below this one's. The ids count from 1
		// again when the server restarts, so an entry later than this one is
		// shown whatever its id.
		let last: { id: number; timestamp: string } | null = null;
		es.onopen = () => (connected = true);
		es.onerror = () => {
			connected = false;
			// The browser tries again after a dropped connection, and gives up
			// for good on an answer that is not a stream: a 401 once the
			// session has ended, a 403 once the account is no longer an
			// administrator. Then it is CLOSED, and nothing will reopen it.
			disconnected = es.readyState === EventSource.CLOSED;
		};
		es.onmessage = (e) => {
			try {
				const entry: LogEntry = JSON.parse(e.data);
				if (last && entry.id <= last.id && entry.timestamp <= last.timestamp) return;
				last = { id: entry.id, timestamp: entry.timestamp };
				entries = [...entries.slice(-999), entry];
			} catch { /* malformed frame — skip */ }
		};
		return () => es.close();
	});

	// A log entry's time is in the stored form, `YYYY-MM-DD HH:MM:SS` in UTC, the
	// row's and the live feed's alike (card 2095): read as UTC, and to the
	// second, which is all it holds.
	function fmtTime(ts: string): string {
		const d = parseStamp(ts);
		if (!d) return ts;
		return d.toLocaleTimeString('en-GB', { hour12: false });
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
	/** Why the last read of the log failed, in the server's words, under the filters (card 2262). */
	let auditError = $state('');
	/** How many reads of the log have been asked for: only the newest one's answer is shown. */
	let auditAsked = 0;
	let auditLoaded = false;
	const AUDIT_PAGE = 100;

	let fBoardId = $state('');
	let fUserId = $state('');
	let fAction = $state('');
	// Where the action was done: '' for both, 'ui' for the web application, 'api' for the API.
	// The Action filter finds an action however it was done (card 2127).
	let fSource = $state('');
	let fFrom = $state('');
	let fTo = $state('');

	async function loadAudit(reset: boolean) {
		// An answer to a read asked for before a newer one, refused or not, is
		// not shown: it would replace or clear the newer Apply's rows (the review).
		const asked = ++auditAsked;
		auditLoading = true;
		try {
			const params = new URLSearchParams();
			if (fBoardId) params.set('boardId', fBoardId);
			if (fUserId) params.set('userId', fUserId);
			if (fAction.trim()) params.set('action', fAction.trim());
			if (fSource) params.set('source', fSource);
			if (fFrom) params.set('from', fFrom);
			// The date as chosen: the server takes a bare date as `to` for the
			// whole of that day, to its last second in UTC (card 2095).
			if (fTo) params.set('to', fTo);
			params.set('limit', String(AUDIT_PAGE));
			// Load more asks for the entries older than the last row shown (card
			// 2387). It asked from `offset` = the rows shown, so each entry written
			// since the first page pushed the next one down a place, and it began
			// with a row already shown.
			const last = reset ? undefined : auditRows.at(-1);
			if (last) params.set('before', `${last.createdAt},${last.id}`);

			const res = await fetch(`/api/audit?${params}`);
			// A refusal (a `from` after its `to`, card 2262) is said in the
			// server's words. Every failure was swallowed, and a refused Apply
			// left the rows of the search before on screen, answering a question
			// that was no longer asked; a refused Load more keeps what was read.
			if (!res.ok) {
				const failure = await failureMessage(res, 'The audit log could not be read.');
				if (asked !== auditAsked) return;
				auditError = failure;
				if (reset) clearAudit();
				return;
			}
			const body = await res.json();
			if (asked !== auditAsked) return;
			auditError = '';
			auditRows = reset ? body.data : [...auditRows, ...body.data];
			// Offered only while the answer says more follows (card 2383): a page
			// of exactly 100 with nothing after it offered a Load more that read
			// nothing. An answer with no `pagination` offers none.
			auditExhausted = body.pagination?.hasMore !== true;
		} catch {
			if (asked !== auditAsked) return;
			auditError = 'No answer from the server. The audit log was not read.';
			if (reset) clearAudit();
		} finally {
			if (asked === auditAsked) auditLoading = false;
		}
	}

	/** No rows, and no Load more, under a failed Apply. */
	function clearAudit() {
		auditRows = [];
		auditExhausted = true;
	}

	function openAuditTab() {
		activeTab = 'audit';
		if (!auditLoaded) {
			auditLoaded = true;
			loadAudit(true);
		}
	}

	function fmtDateTime(ts: string): string {
		const d = parseStamp(ts);
		if (!d) return ts;
		return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
	}

	// ─── Expandable lines ────────────────────────────────────────────────
	let expandedLogs = $state<Set<string>>(new Set());
	let expandedAudit = $state<Set<number>>(new Set());

	function logKey(e: LogEntry): string {
		return `${e.id}|${e.timestamp}`;
	}

	function toggleLog(e: LogEntry) {
		const key = logKey(e);
		const next = new Set(expandedLogs);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		expandedLogs = next;
	}

	function toggleAudit(id: number) {
		const next = new Set(expandedAudit);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		expandedAudit = next;
	}

	function prettyMeta(meta: string | null): string {
		if (!meta) return '';
		try {
			return JSON.stringify(JSON.parse(meta), null, 2);
		} catch {
			return meta;
		}
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
					{connected ? '● live' : disconnected ? '○ disconnected: reload the page' : '○ reconnecting…'}
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
						{@const expanded = expandedLogs.has(logKey(entry))}
						<!-- svelte-ignore a11y_click_events_have_key_events -->
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div class="log-row" class:expanded onclick={() => toggleLog(entry)}>
							<div class="log-line level-{entry.level.toLowerCase()}">
								<span class="log-caret">{expanded ? '▾' : '▸'}</span>
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
									<span class="log-meta">{fmtMeta(entry.meta)}</span>
								{/if}
							</div>
							{#if expanded}
								<!-- svelte-ignore a11y_click_events_have_key_events -->
								<!-- svelte-ignore a11y_no_static_element_interactions -->
								<div class="log-detail" onclick={(e) => e.stopPropagation()}>
									<div class="ld-row"><span class="ld-key">time</span><span class="ld-val">{entry.timestamp}</span></div>
									<div class="ld-row"><span class="ld-key">level</span><span class="ld-val">{entry.level} [{entry.context}]</span></div>
									<div class="ld-row"><span class="ld-key">message</span><span class="ld-val">{entry.message}</span></div>
									{#if entry.userId !== null}
										<div class="ld-row"><span class="ld-key">user</span><span class="ld-val">{userLabel(entry.userId)} (id {entry.userId})</span></div>
									{/if}
									{#if entry.ip}
										<div class="ld-row"><span class="ld-key">ip</span><span class="ld-val">{entry.ip}</span></div>
									{/if}
									{#if entry.meta}
										<pre class="ld-meta">{prettyMeta(entry.meta)}</pre>
									{/if}
								</div>
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
					<input type="text" placeholder="e.g. card_moved, card_* or api:*" bind:value={fAction} />
				</label>
				<label class="ct-field">
					<span>Source</span>
					<select bind:value={fSource}>
						<option value="">All</option>
						<option value="ui">Web application</option>
						<option value="api">API</option>
					</select>
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

			{#if auditError}
				<p class="audit-error" role="alert">{auditError}</p>
			{/if}
			{#if auditLoading && auditRows.length === 0}
				<div class="console-empty">Loading audit log…</div>
			{:else if auditRows.length === 0}
				{#if !auditError}
					<div class="console-empty">No audit entries match these filters.</div>
				{/if}
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
								<!-- svelte-ignore a11y_click_events_have_key_events -->
								<!-- svelte-ignore a11y_no_static_element_interactions -->
								<tr class="at-row" class:expanded={expandedAudit.has(row.id)} onclick={() => toggleAudit(row.id)}>
									<td class="at-when">{fmtDateTime(row.createdAt)}</td>
									<td class="at-user">{row.userEmoji} {row.userName || '—'}</td>
									<td class="at-board">{row.boardName}</td>
									<td><span class="at-action" class:api={row.action.startsWith('api:')}>{row.action}</span></td>
									<td class="at-detail">{row.detail}</td>
								</tr>
								{#if expandedAudit.has(row.id)}
									<tr class="at-expand-row">
										<td colspan="5">
											<div class="at-full-detail">
												{#if row.cardId}<span class="at-full-ref">card #{row.cardId}</span>{/if}
												<span class="at-full-text">{row.detail || '(no detail recorded)'}</span>
											</div>
										</td>
									</tr>
								{/if}
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
	/* Full-viewport flex column: header and tabs take their natural height,
	   the active panel fills everything else and scrolls internally. Its foot
	   stops above the user badge (card 2239), or the Live Console's footer is
	   under it. */
	.audit-page {
		padding: var(--space-md) var(--space-lg) var(--user-badge-space);
		display: flex;
		flex-direction: column;
		gap: var(--space-md);
		height: 100vh;
		overflow: hidden;
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
		min-height: 0;
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
		flex: 1;
		min-height: 0;
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

	.log-row { cursor: pointer; border-radius: 3px; }
	.log-row:hover .log-line, .log-row.expanded .log-line { background: var(--ctp-surface0); }

	.log-line {
		display: flex; gap: 8px; align-items: baseline; flex-wrap: nowrap;
		overflow: hidden;
		padding: 1px 4px; border-radius: 3px;
	}
	.log-caret { color: var(--ctp-overlay0); flex-shrink: 0; width: 1ch; }
	.log-time { color: var(--ctp-overlay0); flex-shrink: 0; }
	.log-level { font-weight: 800; flex-shrink: 0; min-width: 3.4em; }
	.log-context { color: var(--ctp-mauve); flex-shrink: 0; }
	.log-message {
		color: var(--ctp-text);
		overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
		flex-shrink: 1; min-width: 8ch;
	}
	.log-meta {
		color: var(--ctp-overlay1);
		overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
		max-width: 40ch;
	}

	/* Expanded entry detail */
	.log-detail {
		margin: 2px 4px 6px 20px;
		padding: 8px 10px;
		background: var(--ctp-mantle);
		border: 1px solid var(--ctp-surface0);
		border-radius: 4px;
		display: flex; flex-direction: column; gap: 4px;
		cursor: default;
	}
	.ld-row { display: flex; gap: 10px; align-items: baseline; }
	.ld-key {
		color: var(--ctp-overlay0); flex-shrink: 0; min-width: 7ch;
		font-size: 0.62rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;
	}
	.ld-val { color: var(--ctp-text); white-space: pre-wrap; word-break: break-word; }
	.ld-meta {
		margin: 2px 0 0;
		padding: 6px 8px;
		background: var(--ctp-base);
		border-radius: 4px;
		color: var(--ctp-subtext0);
		font-size: 0.68rem;
		white-space: pre-wrap; word-break: break-word;
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

	.audit-table-wrap { overflow: auto; flex: 1; min-height: 0; }
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
	.at-row { cursor: pointer; }
	.at-row:hover td, .at-row.expanded td { background: rgba(128, 128, 128, 0.06); }
	.at-expand-row td { padding: 0 10px 10px; }
	.at-full-detail {
		background: rgba(128, 128, 128, 0.08);
		border-radius: var(--radius-sm);
		padding: var(--space-sm) var(--space-md);
		display: flex; flex-direction: column; gap: 4px;
	}
	.at-full-ref {
		font-size: 0.65rem; font-weight: 700; color: var(--accent-indigo);
	}
	.at-full-text {
		color: var(--text-primary); font-size: 0.75rem;
		white-space: pre-wrap; word-break: break-word;
	}
	.audit-more { display: flex; justify-content: center; padding: var(--space-sm); }
	.audit-error {
		margin: var(--space-sm) var(--space-md) 0; padding: 7px 10px;
		background: rgba(239, 68, 68, 0.08); border: 1px solid rgba(239, 68, 68, 0.2);
		border-radius: var(--radius-md); color: var(--accent-rose); font-size: 0.8rem;
	}
</style>
