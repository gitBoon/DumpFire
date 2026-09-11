<script lang="ts">
	/**
	 * Milestone planning view — the separate view this feature is for.
	 *
	 * Deliberately its own full-screen route rather than a tab on the board. The
	 * Kanban board stays the place where work is tracked; this is the place where
	 * the order of the work is read. It renders five blocks, in the order they
	 * answer a real question:
	 *
	 *   1. Progress        — how far along is this goal
	 *   2. Critical path   — the one chain that cannot slip
	 *   3. Next actionable — what can I start today
	 *   4. Blocked         — what is waiting, and on what
	 *   5. Dependency graph — the whole shape, laid out left to right
	 *
	 * Nothing here is computed in the browser. The server hands over a summary
	 * from $lib/server/planning and this file draws it, so the page and the API
	 * can never disagree about what the critical path is.
	 */
	import { invalidateAll } from '$app/navigation';

	let { data } = $props();

	type Node = {
		id: number;
		title: string;
		priority: string;
		columnTitle: string;
		boardId: number;
		boardName: string;
		isComplete: boolean;
		external?: boolean;
		layer: number;
		blockedByIds: number[];
		blocksIds: number[];
		openBlockerIds: number[];
		downstreamCount: number;
		onCriticalPath: boolean;
	};

	const summary = $derived(data.summary);
	const milestone = $derived(summary.milestone);
	const nodes = $derived(summary.graph.nodes as Node[]);
	const nodeById = $derived(new Map(nodes.map((n) => [n.id, n])));
	const criticalSet = $derived(new Set(summary.criticalPath));

	let editingName = $state(false);
	let nameDraft = $state('');
	let busy = $state(false);
	let actionError = $state('');

	// ─── Card picker: attach existing cards to this goal ─────────────────────

	let picking = $state(false);
	let pickQuery = $state('');
	let pickResults = $state<{ id: number; title: string; boardName: string; boardEmoji: string; columnName: string; milestoneId: number | null }[]>([]);
	let pickSearching = $state(false);
	let pickTimer: ReturnType<typeof setTimeout> | null = null;

	function onPickInput() {
		if (pickTimer) clearTimeout(pickTimer);
		const q = pickQuery.trim();
		if (!q) {
			pickResults = [];
			return;
		}
		pickSearching = true;
		pickTimer = setTimeout(async () => {
			try {
				const res = await fetch(`/api/cards/search?q=${encodeURIComponent(q)}`);
				pickResults = res.ok ? await res.json() : [];
			} finally {
				pickSearching = false;
			}
		}, 250);
	}

	async function attachCard(cardId: number) {
		await mutate({ cardId, attach: true });
		pickQuery = '';
		pickResults = [];
	}

	async function detachCard(cardId: number) {
		await mutate({ cardId, attach: false });
	}

	async function saveName() {
		const name = nameDraft.trim();
		if (!name || name === milestone.name) {
			editingName = false;
			return;
		}
		await mutate({ name });
		editingName = false;
	}

	async function toggleStatus() {
		await mutate({ status: milestone.status === 'open' ? 'closed' : 'open' });
	}

	async function setTargetDate(value: string) {
		await mutate({ targetDate: value || null });
	}

	/** One PATCH path for every edit on this page, so error handling is uniform. */
	async function mutate(body: Record<string, unknown>) {
		busy = true;
		actionError = '';
		try {
			const res = await fetch(`/api/milestones/${milestone.id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				actionError = err.message || 'That change could not be saved';
				return;
			}
			await invalidateAll();
		} finally {
			busy = false;
		}
	}

	function cardHref(n: { id: number; boardId: number }): string {
		return `/board/${n.boardId}?card=${n.id}`;
	}

	function formatDate(d: string | null): string {
		if (!d) return '';
		return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
	}

	// ─── Graph geometry ──────────────────────────────────────────────────────
	//
	// Laid out by hand as inline SVG rather than with a force layout: the whole
	// point of the graph is that reading left to right is reading the order the
	// work happens in, and a force layout would scramble exactly that. Nodes keep
	// a fixed size and the container scrolls, because shrinking nodes to fit 30
	// cards on screen produces something nobody can read.

	const NODE_W = 190;
	const NODE_H = 58;
	const GAP_X = 74;
	const GAP_Y = 16;
	const PAD = 24;

	/** Layers with their nodes resolved, skipping any that ended up empty. */
	const layers = $derived(
		(summary.graph.layers as number[][])
			.map((ids) => ids.map((id) => nodeById.get(id)).filter((n): n is Node => !!n))
			.filter((l) => l.length > 0)
	);

	const positions = $derived.by(() => {
		const pos = new Map<number, { x: number; y: number }>();
		layers.forEach((layer, li) => {
			layer.forEach((n, ni) => {
				pos.set(n.id, {
					x: PAD + li * (NODE_W + GAP_X),
					y: PAD + ni * (NODE_H + GAP_Y)
				});
			});
		});
		return pos;
	});

	const graphWidth = $derived(
		layers.length === 0 ? 0 : PAD * 2 + layers.length * NODE_W + (layers.length - 1) * GAP_X
	);
	const graphHeight = $derived(
		layers.length === 0
			? 0
			: PAD * 2 + Math.max(...layers.map((l) => l.length)) * (NODE_H + GAP_Y) - GAP_Y
	);

	/**
	 * Edge path: a horizontal cubic from the right edge of the blocker to the
	 * left edge of the blocked card. Control points sit halfway across the gap so
	 * the curve leaves and arrives horizontally and never doubles back.
	 */
	function edgePath(fromId: number, toId: number): string {
		const a = positions.get(fromId);
		const b = positions.get(toId);
		if (!a || !b) return '';
		const x1 = a.x + NODE_W;
		const y1 = a.y + NODE_H / 2;
		const x2 = b.x;
		const y2 = b.y + NODE_H / 2;
		const mid = x1 + (x2 - x1) / 2;
		return `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
	}

	function isCriticalEdge(fromId: number, toId: number): boolean {
		const path = summary.criticalPath as number[];
		const i = path.indexOf(fromId);
		return i !== -1 && path[i + 1] === toId;
	}

	/** Trim a title to something that fits a node box on one or two lines. */
	function clip(text: string, max: number): string {
		return text.length <= max ? text : text.slice(0, max - 1).trimEnd() + '…';
	}

	const unorderedNodes = $derived(
		(summary.graph.unordered as number[]).map((id) => nodeById.get(id)).filter((n): n is Node => !!n)
	);
</script>

<svelte:head>
	<title>{milestone.name} — Planning — DumpFire</title>
</svelte:head>

<div class="plan-page">
	<header class="plan-header">
		<div class="plan-header-left">
			<a href="/plan" class="back-btn" title="All milestones" aria-label="All milestones">
				<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
					<path d="M10 3L5 8l5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
				</svg>
			</a>
			<span class="plan-title-icon">🎯</span>
			{#if editingName}
				<!-- svelte-ignore a11y_autofocus -->
				<input
					class="name-input"
					bind:value={nameDraft}
					onblur={saveName}
					onkeydown={(e) => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') editingName = false; }}
					autofocus
				/>
			{:else}
				<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
				<h1 ondblclick={() => { nameDraft = milestone.name; editingName = true; }} title="Double-click to rename">
					{milestone.name}
				</h1>
			{/if}
			{#if milestone.status !== 'open'}<span class="status-chip closed">Closed</span>{/if}
		</div>
		<div class="plan-header-right">
			<input
				class="target-date"
				type="date"
				value={milestone.targetDate ?? ''}
				title="Target date"
				onchange={(e) => setTargetDate((e.target as HTMLInputElement).value)}
			/>
			<button class="btn-ghost" onclick={toggleStatus} disabled={busy}>
				{milestone.status === 'open' ? 'Close milestone' : 'Reopen'}
			</button>
			<button class="btn-primary" onclick={() => (picking = !picking)}>+ Add cards</button>
		</div>
	</header>

	<div class="plan-body">
		{#if actionError}
			<div class="action-error">{actionError}</div>
		{/if}

		{#if picking}
			<section class="panel picker-panel">
				<div class="picker-row">
					<input
						class="picker-input"
						type="text"
						placeholder="Search by #id or title, across every board you can see…"
						bind:value={pickQuery}
						oninput={onPickInput}
					/>
					<button class="btn-ghost" onclick={() => { picking = false; pickQuery = ''; pickResults = []; }}>Done</button>
				</div>
				{#if pickSearching}
					<p class="muted">Searching…</p>
				{:else if pickQuery.trim() && pickResults.length === 0}
					<p class="muted">No cards match “{pickQuery.trim()}”.</p>
				{:else if pickResults.length > 0}
					<div class="picker-results">
						{#each pickResults as r}
							<button
								class="picker-result"
								disabled={r.milestoneId === milestone.id || busy}
								onclick={() => attachCard(r.id)}
							>
								<span class="card-id">#{r.id}</span>
								<span class="card-title">{r.title}</span>
								<span class="card-where">{r.boardEmoji} {r.boardName} / {r.columnName}</span>
								{#if r.milestoneId === milestone.id}
									<span class="already">already in</span>
								{:else if r.milestoneId}
									<span class="already">moves from another goal</span>
								{/if}
							</button>
						{/each}
					</div>
				{/if}
			</section>
		{/if}

		<!-- ── 1. Progress ─────────────────────────────────────────────────── -->
		<section class="panel">
			<div class="panel-head">
				<h2>Progress</h2>
				{#if milestone.targetDate}
					<span class="panel-note">Target {formatDate(milestone.targetDate)}</span>
				{/if}
			</div>

			<div class="progress-row">
				<div class="progress-track">
					<div class="progress-fill" style="width: {summary.progress.percent}%"></div>
				</div>
				<span class="progress-big">{summary.progress.percent}%</span>
			</div>

			<div class="stat-row">
				<div class="stat">
					<span class="stat-value">{summary.progress.done}/{summary.progress.total}</span>
					<span class="stat-label">cards complete</span>
				</div>
				<div class="stat">
					<span class="stat-value">{summary.nextActionable.length}</span>
					<span class="stat-label">startable now</span>
				</div>
				<div class="stat">
					<span class="stat-value">{summary.blocked.length}</span>
					<span class="stat-label">blocked</span>
				</div>
				<div class="stat">
					<span class="stat-value">{summary.progress.openSubtasks}</span>
					<span class="stat-label">open subtasks</span>
				</div>
			</div>

			<div class="chip-row">
				{#each summary.progress.byColumn as c}
					<span class="chip">{c.columnTitle} · {c.count}</span>
				{/each}
				{#each summary.progress.boards as b}
					<a class="chip board-chip" href="/board/{b.id}">{b.name} · {b.cardCount}</a>
				{/each}
			</div>
		</section>

		<!-- ── 2. Critical path ────────────────────────────────────────────── -->
		<section class="panel">
			<div class="panel-head">
				<h2>Critical path</h2>
				<span class="panel-note">The longest chain of work still to do — if any of these slips, the goal slips</span>
			</div>

			{#if summary.criticalPath.length === 0}
				<p class="muted">
					No chain yet. Record which card blocks which — in a card's Dependencies
					section — and the chain that cannot slip will show up here.
				</p>
			{:else}
				<ol class="chain">
					{#each summary.criticalPath as id, i}
						{@const n = nodeById.get(id)}
						{#if n}
							<li class="chain-step">
								<span class="chain-index">{i + 1}</span>
								<a class="chain-card" href={cardHref(n)}>
									<span class="card-id">#{n.id}</span>
									<span class="card-title">{n.title}</span>
									<span class="card-where">
										{#if n.external}<span class="ext-tag">outside this goal</span>{/if}
										{n.boardName} / {n.columnTitle}
									</span>
								</a>
							</li>
						{/if}
					{/each}
				</ol>
			{/if}
		</section>

		<!-- ── 3. Next actionable ──────────────────────────────────────────── -->
		<section class="panel">
			<div class="panel-head">
				<h2>Next actionable</h2>
				<span class="panel-note">Nothing is blocking these — most-unblocking first</span>
			</div>

			{#if summary.nextActionable.length === 0}
				<p class="muted">
					{#if summary.progress.total === 0}
						No cards in this milestone yet.
					{:else if summary.progress.done === summary.progress.total}
						Everything here is done.
					{:else}
						Every remaining card is waiting on something. See Blocked below.
					{/if}
				</p>
			{:else}
				<div class="card-list">
					{#each summary.nextActionable as n}
						<a class="list-card" class:on-critical={criticalSet.has(n.id)} href={cardHref(n)}>
							<span class="prio-dot prio-{n.priority}" title="Priority: {n.priority}"></span>
							<span class="card-id">#{n.id}</span>
							<span class="card-title">{n.title}</span>
							{#if n.downstreamCount > 0}
								<span class="unblock-chip" title="Finishing this frees up {n.downstreamCount} card{n.downstreamCount === 1 ? '' : 's'} downstream">
									unblocks {n.downstreamCount}
								</span>
							{/if}
							{#if criticalSet.has(n.id)}<span class="crit-chip">critical path</span>{/if}
							<span class="card-where">{n.boardName} / {n.columnTitle}</span>
							<button
								class="detach"
								title="Remove from this milestone"
								onclick={(e) => { e.preventDefault(); detachCard(n.id); }}
							>✕</button>
						</a>
					{/each}
				</div>
			{/if}
		</section>

		<!-- ── 4. Blocked ──────────────────────────────────────────────────── -->
		<section class="panel">
			<div class="panel-head">
				<h2>Blocked</h2>
				<span class="panel-note">Waiting on work that is not finished</span>
			</div>

			{#if summary.blocked.length === 0}
				<p class="muted">Nothing is blocked.</p>
			{:else}
				<div class="card-list">
					{#each summary.blocked as b}
						<div class="blocked-group">
							<a class="list-card" class:on-critical={criticalSet.has(b.card.id)} href={cardHref(b.card)}>
								<span class="prio-dot prio-{b.card.priority}" title="Priority: {b.card.priority}"></span>
								<span class="card-id">#{b.card.id}</span>
								<span class="card-title">{b.card.title}</span>
								{#if criticalSet.has(b.card.id)}<span class="crit-chip">critical path</span>{/if}
								<span class="card-where">{b.card.boardName} / {b.card.columnTitle}</span>
							</a>
							<div class="blocker-list">
								{#each b.blockers as blocker}
									<a class="blocker" href={cardHref(blocker)}>
										waiting on
										<span class="card-id">#{blocker.id}</span>
										<span class="blocker-title">{blocker.title}</span>
										<span class="card-where">{blocker.boardName} / {blocker.columnTitle}</span>
									</a>
								{/each}
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</section>

		<!-- ── 5. Dependency graph ─────────────────────────────────────────── -->
		<section class="panel">
			<div class="panel-head">
				<h2>Dependency graph</h2>
				<span class="panel-note">Left to right is the order the work has to happen in</span>
			</div>

			{#if layers.length === 0}
				<p class="muted">No cards to draw yet.</p>
			{:else}
				<div class="graph-legend">
					<span class="legend-item"><span class="legend-swatch critical"></span>Critical path</span>
					<span class="legend-item"><span class="legend-swatch complete"></span>Complete</span>
					<span class="legend-item"><span class="legend-swatch blocked"></span>Blocked</span>
					<span class="legend-item"><span class="legend-swatch ready"></span>Startable</span>
					<span class="legend-item"><span class="legend-swatch external"></span>Outside this goal</span>
				</div>

				<!-- Scrolls in its own container: nodes keep a readable size and the
				     page body never scrolls sideways. -->
				<div class="graph-scroll">
					<svg width={graphWidth} height={graphHeight} role="img" aria-label="Dependency graph for {milestone.name}">
						<defs>
							<marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
								<path d="M0 0 L8 4 L0 8 z" fill="var(--text-tertiary)" />
							</marker>
							<marker id="arrow-crit" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
								<path d="M0 0 L8 4 L0 8 z" fill="#f43f5e" />
							</marker>
						</defs>

						{#each summary.graph.edges as e}
							{@const crit = isCriticalEdge(e.from, e.to)}
							<path
								d={edgePath(e.from, e.to)}
								fill="none"
								stroke={crit ? '#f43f5e' : 'var(--text-tertiary)'}
								stroke-width={crit ? 2.2 : 1.2}
								stroke-opacity={crit ? 0.9 : 0.35}
								marker-end={crit ? 'url(#arrow-crit)' : 'url(#arrow)'}
							/>
						{/each}

						{#each nodes as n}
							{@const p = positions.get(n.id)}
							{#if p}
								{@const state = n.isComplete
									? 'complete'
									: n.external
										? 'external'
										: n.openBlockerIds.length > 0
											? 'blocked'
											: 'ready'}
								<a href={cardHref(n)} class="node-link">
									<g class="node node-{state}" class:node-critical={n.onCriticalPath}>
										<rect x={p.x} y={p.y} width={NODE_W} height={NODE_H} rx="8" />
										<text class="node-id" x={p.x + 11} y={p.y + 19}>#{n.id}</text>
										<text class="node-col" x={p.x + NODE_W - 11} y={p.y + 19} text-anchor="end">
											{n.columnTitle}
										</text>
										<text class="node-title" x={p.x + 11} y={p.y + 37}>{clip(n.title, 26)}</text>
										<text class="node-sub" x={p.x + 11} y={p.y + 50}>
											{#if n.external}
												{clip(n.boardName, 20)} · outside goal
											{:else if n.downstreamCount > 0}
												unblocks {n.downstreamCount}
											{:else if n.isComplete}
												done
											{:else}
												{n.priority}
											{/if}
										</text>
									</g>
								</a>
							{/if}
						{/each}
					</svg>
				</div>

				{#if unorderedNodes.length > 0}
					<!-- Cards nobody has sequenced must still be visible, or the plan
					     quietly under-reports what is in the goal. -->
					<div class="unordered">
						<h3>Parallel / unordered</h3>
						<p class="muted">
							In this milestone but with no dependencies recorded either way — they
							can happen at any time, or nobody has sequenced them yet.
						</p>
						<div class="card-list">
							{#each unorderedNodes as n}
								<a class="list-card" href={cardHref(n)}>
									<span class="prio-dot prio-{n.priority}" title="Priority: {n.priority}"></span>
									<span class="card-id">#{n.id}</span>
									<span class="card-title">{n.title}</span>
									<span class="card-where">{n.boardName} / {n.columnTitle}</span>
								</a>
							{/each}
						</div>
					</div>
				{/if}
			{/if}
		</section>
	</div>
</div>

<style>
	.plan-page { display: flex; flex-direction: column; min-height: 100vh; background: var(--bg-deep); }

	/* ─── Header ───────────────────────────────────────────────────────── */

	.plan-header {
		display: flex; align-items: center; justify-content: space-between;
		gap: var(--space-md); padding: var(--space-md) var(--space-xl);
		background: var(--bg-surface); border-bottom: 1px solid var(--glass-border);
		position: sticky; top: 0; z-index: 10;
	}
	.plan-header-left { display: flex; align-items: center; gap: var(--space-md); min-width: 0; flex: 1; }
	.plan-header-right { display: flex; align-items: center; gap: var(--space-sm); flex-shrink: 0; }

	.back-btn {
		display: flex; align-items: center; justify-content: center;
		width: 32px; height: 32px; border-radius: var(--radius-sm);
		color: var(--text-secondary); transition: all 0.15s; flex-shrink: 0;
	}
	.back-btn:hover { background: var(--glass-hover); color: var(--text-primary); }

	.plan-title-icon { font-size: 1.3rem; flex-shrink: 0; }

	.plan-header h1 {
		font-size: 1.1rem; font-weight: 700; color: var(--text-primary);
		letter-spacing: -0.02em; min-width: 0;
		overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: text;
	}

	.name-input {
		flex: 1; min-width: 0; padding: 5px 10px;
		background: var(--bg-elevated); border: 1px solid var(--accent-indigo);
		border-radius: var(--radius-sm); color: var(--text-primary);
		font-family: var(--font-family); font-size: 1.05rem; font-weight: 700;
	}
	.name-input:focus { outline: none; }

	.status-chip {
		flex-shrink: 0; padding: 1px 8px; border-radius: var(--radius-full);
		font-size: 0.62rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
	}
	.status-chip.closed {
		background: rgba(136, 136, 170, 0.12); color: var(--text-tertiary);
		border: 1px solid rgba(136, 136, 170, 0.25);
	}

	.target-date {
		padding: 6px 10px; background: var(--bg-elevated);
		border: 1px solid var(--glass-border); border-radius: var(--radius-sm);
		color: var(--text-primary); font-family: var(--font-family); font-size: 0.78rem;
	}
	.target-date:focus { outline: none; border-color: var(--accent-indigo); }

	/* ─── Body & panels ────────────────────────────────────────────────── */

	.plan-body {
		padding: var(--space-xl); max-width: 1100px; width: 100%; margin: 0 auto;
		display: flex; flex-direction: column; gap: var(--space-lg);
	}

	.action-error {
		padding: 10px 14px; font-size: 0.8rem; border-radius: var(--radius-sm);
		background: rgba(244, 63, 94, 0.1); color: var(--accent-rose);
		border: 1px solid rgba(244, 63, 94, 0.25);
	}

	.panel {
		background: var(--bg-card); border: 1px solid var(--glass-border);
		border-radius: var(--radius-md); padding: var(--space-lg);
	}

	.panel-head {
		display: flex; align-items: baseline; gap: var(--space-md);
		flex-wrap: wrap; margin-bottom: var(--space-md);
	}
	.panel-head h2 {
		margin: 0; font-size: 0.9rem; font-weight: 700; color: var(--text-primary);
		text-transform: uppercase; letter-spacing: 0.05em;
	}
	.panel-note { font-size: 0.74rem; color: var(--text-tertiary); line-height: 1.4; }

	.muted { margin: 0; font-size: 0.8rem; line-height: 1.55; color: var(--text-secondary); }

	/* ─── Picker ───────────────────────────────────────────────────────── */

	.picker-panel { border-color: rgba(99, 102, 241, 0.35); }
	.picker-row { display: flex; gap: var(--space-sm); margin-bottom: var(--space-sm); }
	.picker-input {
		flex: 1; min-width: 0; padding: 8px 12px;
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		border-radius: var(--radius-sm); color: var(--text-primary);
		font-family: var(--font-family); font-size: 0.85rem;
	}
	.picker-input:focus { outline: none; border-color: var(--accent-indigo); }

	.picker-results {
		display: flex; flex-direction: column; gap: 2px;
		max-height: 300px; overflow-y: auto;
		border: 1px solid var(--glass-border); border-radius: var(--radius-sm); padding: 3px;
	}
	.picker-result {
		display: flex; align-items: baseline; gap: 8px; width: 100%; text-align: left;
		padding: 6px 10px; background: none; border: none; cursor: pointer; font: inherit;
		border-radius: var(--radius-sm); transition: background var(--duration-fast) var(--ease-out);
	}
	.picker-result:hover:not(:disabled) { background: var(--bg-elevated); }
	.picker-result:disabled { opacity: 0.5; cursor: default; }
	.already { font-size: 0.66rem; color: var(--text-tertiary); font-style: italic; }

	/* ─── Progress ─────────────────────────────────────────────────────── */

	.progress-row { display: flex; align-items: center; gap: var(--space-md); margin-bottom: var(--space-md); }
	.progress-track {
		flex: 1; height: 10px; border-radius: var(--radius-full);
		background: rgba(136, 136, 170, 0.15); overflow: hidden;
	}
	.progress-fill {
		height: 100%; border-radius: var(--radius-full); background: var(--accent-emerald);
		transition: width var(--duration-normal) var(--ease-out);
	}
	.progress-big {
		font-size: 1.1rem; font-weight: 700; color: var(--text-primary);
		font-variant-numeric: tabular-nums; flex-shrink: 0;
	}

	.stat-row { display: flex; flex-wrap: wrap; gap: var(--space-xl); margin-bottom: var(--space-md); }
	.stat { display: flex; flex-direction: column; gap: 2px; }
	.stat-value {
		font-size: 1.25rem; font-weight: 700; color: var(--text-primary);
		font-variant-numeric: tabular-nums; line-height: 1.1;
	}
	.stat-label {
		font-size: 0.68rem; color: var(--text-tertiary);
		text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600;
	}

	.chip-row { display: flex; flex-wrap: wrap; gap: 5px; }
	.chip {
		padding: 2px 9px; border-radius: var(--radius-full);
		font-size: 0.68rem; font-weight: 600; text-decoration: none;
		background: rgba(136, 136, 170, 0.1); color: var(--text-secondary);
		border: 1px solid rgba(136, 136, 170, 0.2);
	}
	.board-chip {
		background: rgba(99, 102, 241, 0.1); color: #818cf8;
		border-color: rgba(99, 102, 241, 0.22);
		transition: all var(--duration-fast) var(--ease-out);
	}
	.board-chip:hover { background: rgba(99, 102, 241, 0.2); border-color: rgba(99, 102, 241, 0.45); }

	/* ─── Chain (critical path) ────────────────────────────────────────── */

	.chain { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
	.chain-step { display: flex; align-items: stretch; gap: var(--space-sm); position: relative; }
	/* The connector makes the chain read as one run rather than four rows. */
	.chain-step:not(:last-child)::after {
		content: ''; position: absolute; left: 11px; top: 26px; bottom: -6px;
		width: 2px; background: rgba(244, 63, 94, 0.35);
	}
	.chain-index {
		flex-shrink: 0; width: 24px; height: 24px; border-radius: 50%;
		display: flex; align-items: center; justify-content: center;
		font-size: 0.68rem; font-weight: 700; z-index: 1;
		background: rgba(244, 63, 94, 0.14); color: var(--accent-rose);
		border: 1px solid rgba(244, 63, 94, 0.3);
	}
	.chain-card {
		flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 8px;
		padding: 4px 10px; border-radius: var(--radius-sm); text-decoration: none;
		transition: background var(--duration-fast) var(--ease-out);
	}
	.chain-card:hover { background: var(--bg-elevated); }

	/* ─── Card lists ───────────────────────────────────────────────────── */

	.card-list { display: flex; flex-direction: column; gap: 4px; }

	.list-card {
		display: flex; align-items: baseline; gap: 8px;
		padding: 7px 10px; text-decoration: none;
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		border-radius: var(--radius-sm);
		transition: all var(--duration-fast) var(--ease-out);
	}
	.list-card:hover { border-color: var(--accent-indigo); }
	.list-card.on-critical { border-left: 3px solid var(--accent-rose); }

	.prio-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; align-self: center; }
	.prio-critical { background: #f43f5e; }
	.prio-high { background: #f59e0b; }
	.prio-medium { background: #6366f1; }
	.prio-low { background: #64748b; }

	.card-id {
		font-size: 0.7rem; font-weight: 700; color: var(--text-tertiary);
		font-variant-numeric: tabular-nums; flex-shrink: 0;
	}
	.card-title {
		font-size: 0.82rem; color: var(--text-primary); min-width: 0;
		overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
	}
	.card-where {
		margin-left: auto; flex-shrink: 0; font-size: 0.68rem;
		color: var(--text-tertiary); white-space: nowrap;
	}
	.ext-tag { font-style: italic; margin-right: 4px; }

	.unblock-chip {
		flex-shrink: 0; padding: 1px 7px; border-radius: var(--radius-full);
		font-size: 0.64rem; font-weight: 700;
		background: rgba(16, 185, 129, 0.12); color: var(--accent-emerald);
		border: 1px solid rgba(16, 185, 129, 0.25);
	}
	.crit-chip {
		flex-shrink: 0; padding: 1px 7px; border-radius: var(--radius-full);
		font-size: 0.64rem; font-weight: 700;
		background: rgba(244, 63, 94, 0.12); color: var(--accent-rose);
		border: 1px solid rgba(244, 63, 94, 0.25);
	}

	.detach {
		flex-shrink: 0; width: 20px; height: 20px; padding: 0; align-self: center;
		display: flex; align-items: center; justify-content: center;
		background: none; border: none; cursor: pointer; font: inherit;
		font-size: 0.68rem; color: var(--text-tertiary); border-radius: var(--radius-sm);
		opacity: 0; transition: all var(--duration-fast) var(--ease-out);
	}
	.list-card:hover .detach { opacity: 1; }
	.detach:hover { background: rgba(244, 63, 94, 0.15); color: var(--accent-rose); }

	/* ─── Blocked groups ───────────────────────────────────────────────── */

	.blocked-group { display: flex; flex-direction: column; gap: 3px; margin-bottom: 6px; }
	.blocker-list { display: flex; flex-direction: column; gap: 2px; padding-left: var(--space-lg); }
	.blocker {
		display: flex; align-items: baseline; gap: 6px;
		padding: 3px 10px; text-decoration: none; border-radius: var(--radius-sm);
		font-size: 0.72rem; color: var(--text-tertiary);
		border-left: 2px solid rgba(245, 158, 11, 0.35);
		transition: background var(--duration-fast) var(--ease-out);
	}
	.blocker:hover { background: var(--bg-elevated); }
	.blocker-title {
		color: var(--text-secondary); min-width: 0;
		overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
	}

	/* ─── Graph ────────────────────────────────────────────────────────── */

	.graph-legend { display: flex; flex-wrap: wrap; gap: var(--space-md); margin-bottom: var(--space-md); }
	.legend-item {
		display: inline-flex; align-items: center; gap: 5px;
		font-size: 0.68rem; color: var(--text-tertiary); font-weight: 600;
	}
	.legend-swatch { width: 12px; height: 12px; border-radius: 3px; border: 1.5px solid; }
	.legend-swatch.critical { background: rgba(244, 63, 94, 0.15); border-color: #f43f5e; }
	.legend-swatch.complete { background: rgba(16, 185, 129, 0.12); border-color: var(--accent-emerald); }
	.legend-swatch.blocked { background: rgba(245, 158, 11, 0.12); border-color: #f59e0b; }
	.legend-swatch.ready { background: rgba(99, 102, 241, 0.12); border-color: var(--accent-indigo); }
	.legend-swatch.external { background: rgba(136, 136, 170, 0.1); border-color: rgba(136, 136, 170, 0.5); }

	/* Wide graphs scroll here, never on the page body. */
	.graph-scroll {
		overflow-x: auto; overflow-y: hidden; padding-bottom: var(--space-sm);
		border: 1px solid var(--glass-border); border-radius: var(--radius-sm);
		background: var(--bg-surface);
	}

	.node-link { text-decoration: none; }
	.node rect {
		fill: var(--bg-card); stroke: rgba(136, 136, 170, 0.35); stroke-width: 1.5;
		transition: stroke-width 0.12s ease-out;
	}
	.node:hover rect { stroke-width: 2.5; }

	.node-ready rect { stroke: var(--accent-indigo); fill: rgba(99, 102, 241, 0.07); }
	.node-blocked rect { stroke: #f59e0b; fill: rgba(245, 158, 11, 0.07); }
	.node-complete rect { stroke: var(--accent-emerald); fill: rgba(16, 185, 129, 0.07); }
	/* Greyed, as the card asks: done work should recede so the open chain reads. */
	.node-complete text { opacity: 0.55; }
	.node-external rect { stroke: rgba(136, 136, 170, 0.5); stroke-dasharray: 4 3; }
	.node-critical rect { stroke: #f43f5e; stroke-width: 2.5; fill: rgba(244, 63, 94, 0.07); }

	.node text { font-family: var(--font-family); }
	.node-id { font-size: 10px; font-weight: 700; fill: var(--text-tertiary); }
	.node-col { font-size: 9px; font-weight: 600; fill: var(--text-tertiary); }
	.node-title { font-size: 12px; font-weight: 600; fill: var(--text-primary); }
	.node-sub { font-size: 9.5px; fill: var(--text-tertiary); }

	.unordered { margin-top: var(--space-lg); }
	.unordered h3 {
		margin: 0 0 4px; font-size: 0.78rem; font-weight: 700;
		color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.05em;
	}
	.unordered .muted { margin-bottom: var(--space-sm); }

	@media (max-width: 720px) {
		.plan-header { flex-wrap: wrap; }
		.plan-body { padding: var(--space-md); }
		.stat-row { gap: var(--space-lg); }
	}
</style>
