<script lang="ts">
	/**
	 * Planning index — every goal, open ones first.
	 *
	 * This is the front door of a view that is deliberately separate from the
	 * Kanban board. The board answers "what is the state of this card"; the
	 * planning view answers "in what order does this have to happen, and what can
	 * I start today". Same cards, different question.
	 */
	import { invalidateAll, goto } from '$app/navigation';
	import { completionPercent } from '$lib/progress';

	let { data } = $props();

	let creating = $state(false);
	let newName = $state('');
	// Arriving from a board, that board is the likely scope for a new goal.
	let newBoardId = $state<number | ''>(data.filterBoard ?? '');
	let newTargetDate = $state('');
	let saving = $state(false);
	let error = $state('');

	// ─── The goals table ─────────────────────────────────────────────────────
	//
	// A grid of cards stopped being scannable at about five goals. Same treatment
	// as the work table inside a milestone, so the two screens behave alike.

	type Row = {
		id: number;
		name: string;
		boardId: number | null;
		boardName: string | null;
		boardIds: number[];
		targetDate: string | null;
		status: string;
		cardCount: number;
		readyToClose?: boolean;
		doneCount: number;
		percent: number;
		scope: string;
		daysLeft: number | null;
		overdue: boolean;
	};

	const rows = $derived.by<Row[]>(() =>
		(data.milestones as any[]).map((m) => {
			const percent = completionPercent(m.doneCount, m.cardCount);
			const days = daysUntil(m.targetDate);
			return {
				...m,
				percent,
				// Sortable and searchable as one string, and it is what the column shows.
				scope:
					m.boardId === null
						? `Cross-board${m.boardIds.length ? ` · ${m.boardIds.length} board${m.boardIds.length === 1 ? '' : 's'}` : ''}`
						: (m.boardName ?? 'Unknown board'),
				daysLeft: days,
				// Only late while work remains — a goal finished after its date is done.
				overdue: days !== null && days < 0 && m.doneCount < m.cardCount,
				// Everything carded is done, but the goal has not been closed. Closing
				// stays a deliberate act — all the cards you thought of being done is
				// not the same as the goal being delivered, and more can still be
				// added — but "Open" next to 23/23 reads as a bug, so say what it is.
				readyToClose: m.status === 'open' && m.cardCount > 0 && m.doneCount === m.cardCount
			};
		})
	);

	const statusCounts = $derived({
		all: rows.length,
		open: rows.filter((r) => r.status === 'open').length,
		closed: rows.filter((r) => r.status !== 'open').length
	});

	let search = $state('');
	let statusFilter = $state<'all' | 'open' | 'closed'>('open');
	let sortKey = $state<'id' | 'name' | 'scope' | 'targetDate' | 'percent' | 'status'>('id');
	let sortDir = $state<'asc' | 'desc'>('asc');

	function toggleSort(key: typeof sortKey) {
		if (sortKey === key) {
			sortDir = sortDir === 'asc' ? 'desc' : 'asc';
		} else {
			sortKey = key;
			// Progress reads best highest-first; everything else A–Z or oldest-first.
			sortDir = key === 'percent' ? 'desc' : 'asc';
		}
	}

	const visible = $derived.by(() => {
		const q = search.trim().toLowerCase();
		const idMatch = q.match(/^#?(\d+)$/);

		let out = rows.filter((r) => {
			if (statusFilter === 'open' && r.status !== 'open') return false;
			if (statusFilter === 'closed' && r.status === 'open') return false;
			if (!q) return true;
			if (idMatch) return r.id === Number(idMatch[1]);
			return r.name.toLowerCase().includes(q) || r.scope.toLowerCase().includes(q);
		});

		const dir = sortDir === 'asc' ? 1 : -1;
		return [...out].sort((a, b) => {
			let cmp: number;
			switch (sortKey) {
				case 'id':
					cmp = a.id - b.id;
					break;
				case 'percent':
					// Numeric, not lexical — a string sort puts 100 before 20.
					cmp = a.percent - b.percent;
					break;
				case 'targetDate':
					// Undated goals sort last whichever way the column is pointing:
					// "no date" is not earlier or later than a date, it is absent.
					if (!a.targetDate && !b.targetDate) cmp = 0;
					else if (!a.targetDate) return 1;
					else if (!b.targetDate) return -1;
					else cmp = a.targetDate.localeCompare(b.targetDate);
					break;
				case 'status':
					cmp = (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1);
					break;
				default:
					cmp = String(a[sortKey]).localeCompare(String(b[sortKey]));
			}
			// Ties fall back to id so the order never jitters between renders.
			return cmp !== 0 ? cmp * dir : a.id - b.id;
		});
	});

	async function createMilestone() {
		const name = newName.trim();
		if (!name) return;
		saving = true;
		error = '';
		try {
			const res = await fetch('/api/milestones', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name,
					boardId: newBoardId === '' ? null : Number(newBoardId),
					targetDate: newTargetDate || null
				})
			});
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				error = err.message || 'Could not create that milestone';
				return;
			}
			newName = '';
			newTargetDate = '';
			newBoardId = '';
			creating = false;
			await invalidateAll();
		} finally {
			saving = false;
		}
	}

	function formatDate(d: string | null): string {
		if (!d) return '';
		return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
	}

	/** Days until the target date — negative once it has gone past. */
	function daysUntil(d: string | null): number | null {
		if (!d) return null;
		const target = new Date(d).setHours(0, 0, 0, 0);
		const today = new Date().setHours(0, 0, 0, 0);
		return Math.round((target - today) / 86400000);
	}
</script>

<svelte:head>
	<title>Planning — DumpFire</title>
</svelte:head>

<div class="plan-page">
	<header class="plan-header">
		<div class="plan-header-left">
			<a href="/" class="back-btn" title="Back to Dashboard" aria-label="Back to Dashboard">
				<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
					<path d="M10 3L5 8l5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
				</svg>
			</a>
			<span class="plan-title-icon">🎯</span>
			<h1>Planning</h1>
			{#if data.filterBoardName}
				<span class="filter-chip">
					{data.filterBoardName}
					<a href="/plan" class="filter-clear" title="Show goals from every board">✕</a>
				</span>
			{:else}
				<span class="plan-subtitle">What has to happen, and in what order</span>
			{/if}
		</div>
		<div class="plan-header-right">
			<button class="hdr-btn primary" class:is-on={creating} onclick={() => (creating = !creating)}>
				<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
					<path d="M8 3.5v9M3.5 8h9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
				</svg>
				New milestone
			</button>
		</div>
	</header>

	<div class="plan-body">
		{#if creating}
			<div class="create-panel">
				<h2>New milestone</h2>
				<p class="create-hint">
					A milestone is a goal that spans many cards. Leave the board as
					<strong>Cross-board</strong> when the goal touches more than one project — that
					is the case the Kanban board cannot express on its own.
				</p>
				{#if error}<div class="create-error">{error}</div>{/if}
				<div class="create-row">
					<input
						class="create-input"
						type="text"
						placeholder="e.g. Azure VM migration, all environments"
						bind:value={newName}
						onkeydown={(e) => e.key === 'Enter' && createMilestone()}
					/>
					<select class="create-select" bind:value={newBoardId}>
						<option value="">Cross-board</option>
						{#each data.boards as b}
							<option value={b.id}>{b.emoji} {b.name}</option>
						{/each}
					</select>
					<input class="create-date" type="date" bind:value={newTargetDate} title="Target date (optional)" />
					<button class="btn-primary" onclick={createMilestone} disabled={!newName.trim() || saving}>
						{saving ? 'Creating…' : 'Create'}
					</button>
					<button class="btn-ghost" onclick={() => { creating = false; error = ''; }}>Cancel</button>
				</div>
			</div>
		{/if}

		<div class="table-controls">
			<div class="table-search">
				<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
					<circle cx="6" cy="6" r="4.5" stroke="currentColor" stroke-width="1.5"/>
					<path d="M9.5 9.5L13 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
				</svg>
				<input type="text" placeholder="Search goals by #id, name or board…" bind:value={search} />
				{#if search}
					<button class="search-clear" onclick={() => (search = '')} title="Clear search">✕</button>
				{/if}
			</div>

			<div class="state-filter">
				<button class:active={statusFilter === 'open'} onclick={() => (statusFilter = 'open')}>
					Open <span class="fc">{statusCounts.open}</span>
				</button>
				<button class:active={statusFilter === 'closed'} onclick={() => (statusFilter = 'closed')}>
					Closed <span class="fc">{statusCounts.closed}</span>
				</button>
				<button class:active={statusFilter === 'all'} onclick={() => (statusFilter = 'all')}>
					All <span class="fc">{statusCounts.all}</span>
				</button>
			</div>
		</div>

		{#if rows.length === 0 && data.filterBoardName}
			<div class="plan-empty">
				<span class="empty-icon">🎯</span>
				<h3>No goals on {data.filterBoardName}</h3>
				<p>
					Nothing on this board belongs to a milestone yet. Add its cards to a goal
					from the card modal, or create one here — a goal that spans several
					projects will still show up on this board once it has cards on it.
				</p>
				<div class="empty-actions">
					<button class="btn-primary" onclick={() => (creating = true)}>New milestone</button>
					<a href="/plan" class="btn-ghost">Show every goal</a>
				</div>
			</div>
		{:else if rows.length === 0}
			<div class="plan-empty">
				<span class="empty-icon">🎯</span>
				<h3>No milestones yet</h3>
				<p>
					Group the cards that make up one goal into a milestone, record which card
					blocks which, and this view will work out the critical path and what is
					actually startable today.
				</p>
				<button class="btn-primary" onclick={() => (creating = true)}>Create the first one</button>
			</div>
		{:else if visible.length === 0}
			<p class="muted">
				{#if search.trim()}
					Nothing matches “{search.trim()}”{#if statusFilter !== 'all'} among {statusFilter} goals{/if}.
				{:else if statusFilter === 'open'}
					No goals are open.
				{:else}
					No goals are closed.
				{/if}
			</p>
		{:else}
			<div class="table-scroll">
				<table class="goals-table">
					<thead>
						<tr>
							<th class="col-id">
								<button class="sort-btn" class:sorted={sortKey === 'id'} onclick={() => toggleSort('id')}>
									ID{#if sortKey === 'id'}<span class="sort-arrow">{sortDir === 'asc' ? '▲' : '▼'}</span>{/if}
								</button>
							</th>
							<th class="col-name">
								<button class="sort-btn" class:sorted={sortKey === 'name'} onclick={() => toggleSort('name')}>
									Milestone{#if sortKey === 'name'}<span class="sort-arrow">{sortDir === 'asc' ? '▲' : '▼'}</span>{/if}
								</button>
							</th>
							<th class="col-scope">
								<button class="sort-btn" class:sorted={sortKey === 'scope'} onclick={() => toggleSort('scope')}>
									Scope{#if sortKey === 'scope'}<span class="sort-arrow">{sortDir === 'asc' ? '▲' : '▼'}</span>{/if}
								</button>
							</th>
							<th class="col-target">
								<button class="sort-btn" class:sorted={sortKey === 'targetDate'} onclick={() => toggleSort('targetDate')}>
									Target{#if sortKey === 'targetDate'}<span class="sort-arrow">{sortDir === 'asc' ? '▲' : '▼'}</span>{/if}
								</button>
							</th>
							<th class="col-progress">
								<button class="sort-btn" class:sorted={sortKey === 'percent'} onclick={() => toggleSort('percent')}>
									Progress{#if sortKey === 'percent'}<span class="sort-arrow">{sortDir === 'asc' ? '▲' : '▼'}</span>{/if}
								</button>
							</th>
							<th class="col-status">
								<button class="sort-btn" class:sorted={sortKey === 'status'} onclick={() => toggleSort('status')}>
									Status{#if sortKey === 'status'}<span class="sort-arrow">{sortDir === 'asc' ? '▲' : '▼'}</span>{/if}
								</button>
							</th>
						</tr>
					</thead>
					<tbody>
						{#each visible as m (m.id)}
							<tr class:is-closed={m.status !== 'open'} onclick={() => goto(`/plan/${m.id}`)}>
								<td class="col-id"><a href="/plan/{m.id}">#{m.id}</a></td>
								<td class="col-name">
									<a class="name-link" href="/plan/{m.id}" title={m.name}>{m.name}</a>
								</td>
								<td class="col-scope">
									<span class="scope-chip" class:cross={m.boardId === null}>{m.scope}</span>
								</td>
								<td class="col-target">
									{#if m.targetDate}
										<span class="target-cell" class:overdue={m.overdue}>
											{formatDate(m.targetDate)}
											{#if m.daysLeft !== null}
												<span class="days">
													{#if m.overdue}{-m.daysLeft}d over{:else if m.daysLeft === 0}today{:else if m.daysLeft > 0}{m.daysLeft}d{/if}
												</span>
											{/if}
										</span>
									{:else}
										<span class="dash">—</span>
									{/if}
								</td>
								<td class="col-progress">
									<div class="progress-cell">
										<div class="progress-track"><div class="progress-fill" style="width: {m.percent}%"></div></div>
										<span class="progress-label">
											{#if m.cardCount === 0}no cards{:else}{m.doneCount}/{m.cardCount}{/if}
										</span>
									</div>
								</td>
								<td class="col-status">
									<span
										class="status-chip"
										class:open={m.status === 'open' && !m.readyToClose}
										class:ready={m.readyToClose}
										class:closed={m.status !== 'open'}
										title={m.readyToClose ? 'Every card in this goal is complete — close it when you are satisfied it is delivered' : ''}
									>
										{#if m.readyToClose}Ready{:else if m.status === 'open'}Open{:else}Closed{/if}
									</span>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>
</div>

<style>
	.plan-page {
		display: flex;
		flex-direction: column;
		min-height: 100vh;
		background: var(--bg-deep);
	}

	.plan-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-md);
		padding: var(--space-md) var(--space-xl);
		background: var(--bg-surface);
		border-bottom: 1px solid var(--glass-border);
		position: sticky;
		top: 0;
		z-index: 10;
	}

	.plan-header-left { display: flex; align-items: center; gap: var(--space-md); min-width: 0; }
	.plan-header-right { display: flex; align-items: center; gap: var(--space-sm); flex-shrink: 0; }

	.back-btn {
		display: flex; align-items: center; justify-content: center;
		width: 32px; height: 32px; border-radius: var(--radius-sm);
		color: var(--text-secondary); transition: all 0.15s; flex-shrink: 0;
	}
	.back-btn:hover { background: var(--glass-hover); color: var(--text-primary); }

	.plan-title-icon { font-size: 1.3rem; }

	.plan-header h1 {
		font-size: 1.1rem; font-weight: 700;
		color: var(--text-primary); letter-spacing: -0.02em; white-space: nowrap;
	}

	.filter-chip {
		display: inline-flex; align-items: center; gap: 6px;
		padding: 3px 6px 3px 11px; border-radius: var(--radius-full);
		font-size: 0.74rem; font-weight: 600; white-space: nowrap;
		background: rgba(99, 102, 241, 0.12); color: #818cf8;
		border: 1px solid rgba(99, 102, 241, 0.3);
	}
	.filter-clear {
		display: flex; align-items: center; justify-content: center;
		width: 17px; height: 17px; border-radius: 50%;
		font-size: 0.62rem; text-decoration: none; color: inherit;
		background: rgba(99, 102, 241, 0.2);
		transition: all var(--duration-fast) var(--ease-out);
	}
	.filter-clear:hover { background: var(--accent-indigo); color: #fff; }

	.empty-actions { display: flex; gap: var(--space-sm); align-items: center; }

	.plan-subtitle {
		font-size: 0.75rem; color: var(--text-tertiary);
		padding-left: var(--space-sm); border-left: 1px solid var(--glass-border);
		white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
	}

	.plan-body { padding: var(--space-xl); max-width: 1100px; width: 100%; margin: 0 auto; }

	/* ─── Create panel ─────────────────────────────────────────────────── */

	.create-panel {
		background: var(--bg-card); border: 1px solid var(--glass-border);
		border-radius: var(--radius-md); padding: var(--space-lg);
		margin-bottom: var(--space-xl);
	}
	.create-panel h2 {
		font-size: 0.95rem; font-weight: 700; color: var(--text-primary);
		margin: 0 0 6px;
	}
	.create-hint {
		margin: 0 0 var(--space-md); font-size: 0.78rem; line-height: 1.5;
		color: var(--text-secondary);
	}
	.create-error {
		margin-bottom: var(--space-md); padding: 8px 12px;
		font-size: 0.78rem; border-radius: var(--radius-sm);
		background: rgba(244, 63, 94, 0.1); color: var(--accent-rose);
		border: 1px solid rgba(244, 63, 94, 0.25);
	}
	.create-row { display: flex; gap: var(--space-sm); flex-wrap: wrap; }

	.create-input {
		flex: 1 1 260px; min-width: 0; padding: 8px 12px;
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		border-radius: var(--radius-sm); color: var(--text-primary);
		font-family: var(--font-family); font-size: 0.85rem;
	}
	.create-input:focus { outline: none; border-color: var(--accent-indigo); }

	.create-select, .create-date {
		padding: 8px 12px; background: var(--bg-surface);
		border: 1px solid var(--glass-border); border-radius: var(--radius-sm);
		color: var(--text-primary); font-family: var(--font-family);
		font-size: 0.85rem; cursor: pointer;
	}
	.create-select:focus, .create-date:focus { outline: none; border-color: var(--accent-indigo); }

	/* ─── Empty state ──────────────────────────────────────────────────── */

	.plan-empty {
		display: flex; flex-direction: column; align-items: center;
		text-align: center; padding: 80px var(--space-xl); gap: var(--space-md);
	}
	.empty-icon { font-size: 2.5rem; }
	.plan-empty h3 { font-size: 1.05rem; font-weight: 700; color: var(--text-primary); margin: 0; }
	.plan-empty p {
		margin: 0; max-width: 480px; font-size: 0.85rem;
		line-height: 1.6; color: var(--text-secondary);
	}

	/* ─── Header controls ──────────────────────────────────────────────── */

	.hdr-btn {
		display: inline-flex; align-items: center; gap: 5px; white-space: nowrap;
		height: 30px; padding: 0 11px;
		background: var(--bg-elevated); border: 1px solid var(--glass-border);
		border-radius: var(--radius-sm); color: var(--text-secondary);
		font-family: var(--font-family); font-size: 0.76rem; font-weight: 600;
		cursor: pointer; text-decoration: none;
		transition: all var(--duration-fast) var(--ease-out);
	}
	.hdr-btn:hover { color: var(--text-primary); border-color: var(--text-tertiary); }
	.hdr-btn.primary {
		background: var(--accent-indigo); border-color: var(--accent-indigo); color: #fff;
	}
	.hdr-btn.primary:hover { filter: brightness(1.08); }

	/* ─── Search and filter ────────────────────────────────────────────── */

	.table-controls {
		display: flex; align-items: center; gap: var(--space-md);
		flex-wrap: wrap; margin-bottom: var(--space-md);
	}

	.table-search { position: relative; display: flex; align-items: center; flex: 1 1 260px; min-width: 0; }
	.table-search svg { position: absolute; left: 10px; color: var(--text-tertiary); pointer-events: none; }
	.table-search input {
		width: 100%; padding: 7px 30px 7px 32px;
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		border-radius: var(--radius-full); color: var(--text-primary);
		font-family: var(--font-family); font-size: 0.82rem;
	}
	.table-search input:focus { outline: none; border-color: var(--accent-indigo); }
	.search-clear {
		position: absolute; right: 8px; width: 18px; height: 18px; padding: 0;
		display: flex; align-items: center; justify-content: center;
		background: none; border: none; cursor: pointer; font: inherit;
		font-size: 0.66rem; color: var(--text-tertiary); border-radius: 50%;
	}
	.search-clear:hover { background: var(--bg-elevated); color: var(--text-primary); }

	.state-filter {
		display: flex; flex-shrink: 0; border-radius: var(--radius-full);
		border: 1px solid var(--glass-border); overflow: hidden;
	}
	.state-filter button {
		display: inline-flex; align-items: center; gap: 5px;
		padding: 6px 12px; background: var(--bg-surface); border: none;
		border-right: 1px solid var(--glass-border);
		color: var(--text-secondary); font-family: var(--font-family);
		font-size: 0.75rem; font-weight: 600; cursor: pointer; white-space: nowrap;
		transition: all var(--duration-fast) var(--ease-out);
	}
	.state-filter button:last-child { border-right: none; }
	.state-filter button:hover { background: var(--bg-elevated); color: var(--text-primary); }
	.state-filter button.active { background: var(--accent-indigo); color: #fff; }
	.fc { font-variant-numeric: tabular-nums; font-size: 0.68rem; opacity: 0.75; font-weight: 700; }

	/* ─── The table ────────────────────────────────────────────────────── */

	.table-scroll {
		overflow-x: auto;
		background: var(--bg-card);
		border: 1px solid var(--glass-border); border-radius: var(--radius-md);
	}

	.goals-table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }

	.goals-table thead th {
		position: sticky; top: 0; z-index: 1;
		background: var(--bg-surface); text-align: left;
		border-bottom: 1px solid var(--glass-border);
		padding: 0; white-space: nowrap;
	}

	.sort-btn {
		display: inline-flex; align-items: center; gap: 4px;
		width: 100%; padding: 9px 12px;
		background: none; border: none; cursor: pointer; font: inherit;
		font-size: 0.68rem; font-weight: 700; text-transform: uppercase;
		letter-spacing: 0.04em; color: var(--text-tertiary); text-align: left;
		transition: color var(--duration-fast) var(--ease-out);
	}
	.sort-btn:hover { color: var(--text-primary); }
	.sort-btn.sorted { color: var(--accent-indigo); }
	.sort-arrow { font-size: 0.55rem; }

	.goals-table tbody tr {
		border-bottom: 1px solid var(--glass-border); cursor: pointer;
		transition: background var(--duration-fast) var(--ease-out);
	}
	.goals-table tbody tr:last-child { border-bottom: none; }
	.goals-table tbody tr:hover { background: var(--bg-elevated); }
	.goals-table tbody tr.is-closed { opacity: 0.55; }
	.goals-table td { padding: 10px 12px; vertical-align: middle; }

	.col-id { width: 66px; }
	.col-id a {
		font-size: 0.74rem; font-weight: 700; color: var(--text-tertiary);
		font-variant-numeric: tabular-nums; text-decoration: none;
	}
	.col-id a:hover { color: var(--accent-indigo); }

	.col-name { max-width: 0; width: 40%; }
	.name-link {
		display: block; font-weight: 600; color: var(--text-primary); text-decoration: none;
		overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
	}
	.goals-table tbody tr:hover .name-link { color: var(--accent-indigo); }

	.col-scope { width: 170px; }
	.scope-chip {
		display: inline-block; padding: 1px 9px; border-radius: var(--radius-full);
		font-size: 0.68rem; font-weight: 600; white-space: nowrap;
		max-width: 100%; overflow: hidden; text-overflow: ellipsis;
		background: rgba(136, 136, 170, 0.1); color: var(--text-secondary);
		border: 1px solid rgba(136, 136, 170, 0.2);
	}
	.scope-chip.cross {
		background: rgba(139, 92, 246, 0.1); color: #a78bfa;
		border-color: rgba(139, 92, 246, 0.25);
	}

	.col-target { width: 150px; white-space: nowrap; }
	.target-cell {
		display: inline-flex; align-items: baseline; gap: 6px;
		font-size: 0.76rem; color: var(--text-secondary);
	}
	.target-cell .days { font-size: 0.66rem; color: var(--text-tertiary); }
	/* Late only while work remains — see `overdue` in the row model. */
	.target-cell.overdue { color: var(--accent-rose); font-weight: 600; }
	.target-cell.overdue .days { color: var(--accent-rose); opacity: 0.8; }
	.dash { color: var(--text-tertiary); opacity: 0.5; }

	.col-progress { width: 190px; }
	.progress-cell { display: flex; align-items: center; gap: var(--space-sm); }
	.progress-track {
		flex: 1; height: 6px; border-radius: var(--radius-full);
		background: rgba(136, 136, 170, 0.15); overflow: hidden; min-width: 60px;
	}
	.progress-fill {
		height: 100%; border-radius: var(--radius-full); background: var(--accent-emerald);
		transition: width var(--duration-normal) var(--ease-out);
	}
	.progress-label {
		flex-shrink: 0; font-size: 0.7rem; font-weight: 600;
		color: var(--text-tertiary); font-variant-numeric: tabular-nums; white-space: nowrap;
	}

	.col-status { width: 90px; }
	.status-chip {
		display: inline-block; padding: 1px 9px; border-radius: var(--radius-full);
		font-size: 0.64rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
	}
	.status-chip.open {
		background: rgba(16, 185, 129, 0.12); color: var(--accent-emerald);
		border: 1px solid rgba(16, 185, 129, 0.25);
	}
	.status-chip.ready {
		background: rgba(99, 102, 241, 0.14); color: #818cf8;
		border: 1px solid rgba(99, 102, 241, 0.3);
		cursor: help;
	}
	.status-chip.closed {
		background: rgba(136, 136, 170, 0.12); color: var(--text-tertiary);
		border: 1px solid rgba(136, 136, 170, 0.25);
	}

	.muted { margin: var(--space-lg) 0; font-size: 0.85rem; color: var(--text-secondary); }

	@media (max-width: 860px) {
		/* Scope and target give way first — id, name and progress are what the
		   table is for. */
		.col-scope, .col-target { display: none; }
	}

	@media (max-width: 720px) {
		.plan-header { flex-wrap: wrap; }
		.plan-subtitle { display: none; }
		.plan-body { padding: var(--space-md); }
	}
</style>
