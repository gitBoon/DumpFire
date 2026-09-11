<script lang="ts">
	/**
	 * Planning index — every goal, open ones first.
	 *
	 * This is the front door of a view that is deliberately separate from the
	 * Kanban board. The board answers "what is the state of this card"; the
	 * planning view answers "in what order does this have to happen, and what can
	 * I start today". Same cards, different question.
	 */
	import { invalidateAll } from '$app/navigation';

	let { data } = $props();

	let creating = $state(false);
	let newName = $state('');
	// Arriving from a board, that board is the likely scope for a new goal.
	let newBoardId = $state<number | ''>(data.filterBoard ?? '');
	let newTargetDate = $state('');
	let saving = $state(false);
	let error = $state('');
	let showClosed = $state(false);

	const visible = $derived(
		data.milestones.filter((m: { status: string }) => showClosed || m.status === 'open')
	);
	const closedCount = $derived(
		data.milestones.filter((m: { status: string }) => m.status !== 'open').length
	);

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
			{#if closedCount > 0}
				<button class="btn-ghost" onclick={() => (showClosed = !showClosed)}>
					{showClosed ? 'Hide' : 'Show'} closed ({closedCount})
				</button>
			{/if}
			<button class="btn-primary" onclick={() => (creating = !creating)}>+ New milestone</button>
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

		{#if visible.length === 0 && data.filterBoardName}
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
		{:else if visible.length === 0}
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
		{:else}
			<div class="milestone-grid">
				{#each visible as m (m.id)}
					{@const due = daysUntil(m.targetDate)}
					<a class="milestone-card" class:is-closed={m.status !== 'open'} href="/plan/{m.id}">
						<div class="milestone-card-head">
							<h3>{m.name}</h3>
							{#if m.status !== 'open'}<span class="status-chip closed">Closed</span>{/if}
						</div>

						<div class="milestone-scope">
							{#if m.boardId === null}
								<span class="scope-chip cross">
									Cross-board{#if m.boardIds.length > 0}&nbsp;· {m.boardIds.length} board{m.boardIds.length === 1 ? '' : 's'}{/if}
								</span>
							{:else}
								<span class="scope-chip">{m.boardName}</span>
							{/if}
							{#if m.targetDate}
								<span class="scope-chip date" class:overdue={due !== null && due < 0 && m.doneCount < m.cardCount}>
									{formatDate(m.targetDate)}
									{#if due !== null}
										<span class="date-rel">
											{#if due < 0}{-due}d over{:else if due === 0}today{:else}{due}d{/if}
										</span>
									{/if}
								</span>
							{/if}
						</div>

						<div class="progress-row">
							<div class="progress-track">
								<div
									class="progress-fill"
									style="width: {m.cardCount === 0 ? 0 : Math.round((m.doneCount / m.cardCount) * 100)}%"
								></div>
							</div>
							<span class="progress-label">
								{#if m.cardCount === 0}
									No cards yet
								{:else}
									{m.doneCount}/{m.cardCount}
								{/if}
							</span>
						</div>
					</a>
				{/each}
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

	/* ─── Milestone cards ──────────────────────────────────────────────── */

	.milestone-grid {
		display: grid; gap: var(--space-md);
		grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
	}

	.milestone-card {
		display: flex; flex-direction: column; gap: var(--space-sm);
		padding: var(--space-lg); text-decoration: none;
		background: var(--bg-card); border: 1px solid var(--glass-border);
		border-radius: var(--radius-md);
		transition: all var(--duration-normal) var(--ease-out);
	}
	.milestone-card:hover {
		transform: translateY(-2px);
		border-color: rgba(139, 92, 246, 0.4);
		box-shadow: var(--shadow-md);
	}
	.milestone-card.is-closed { opacity: 0.6; }

	.milestone-card-head { display: flex; align-items: flex-start; gap: var(--space-sm); }
	.milestone-card-head h3 {
		flex: 1; margin: 0; font-size: 0.95rem; font-weight: 700;
		line-height: 1.35; color: var(--text-primary);
	}

	.status-chip {
		flex-shrink: 0; padding: 1px 8px; border-radius: var(--radius-full);
		font-size: 0.62rem; font-weight: 700; text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.status-chip.closed {
		background: rgba(136, 136, 170, 0.12); color: var(--text-tertiary);
		border: 1px solid rgba(136, 136, 170, 0.25);
	}

	.milestone-scope { display: flex; flex-wrap: wrap; gap: 5px; }

	.scope-chip {
		display: inline-flex; align-items: center; gap: 4px;
		padding: 1px 8px; border-radius: var(--radius-full);
		font-size: 0.66rem; font-weight: 600;
		background: rgba(136, 136, 170, 0.1); color: var(--text-secondary);
		border: 1px solid rgba(136, 136, 170, 0.2);
	}
	.scope-chip.cross {
		background: rgba(139, 92, 246, 0.1); color: #a78bfa;
		border-color: rgba(139, 92, 246, 0.25);
	}
	.scope-chip.date .date-rel { opacity: 0.7; }
	/* Only overdue when there is still work left — a goal finished late is done. */
	.scope-chip.date.overdue {
		background: rgba(244, 63, 94, 0.1); color: var(--accent-rose);
		border-color: rgba(244, 63, 94, 0.25);
	}

	.progress-row { display: flex; align-items: center; gap: var(--space-sm); margin-top: auto; }

	.progress-track {
		flex: 1; height: 6px; border-radius: var(--radius-full);
		background: rgba(136, 136, 170, 0.15); overflow: hidden;
	}
	.progress-fill {
		height: 100%; border-radius: var(--radius-full);
		background: var(--accent-emerald);
		transition: width var(--duration-normal) var(--ease-out);
	}
	.progress-label {
		flex-shrink: 0; font-size: 0.7rem; font-weight: 600;
		color: var(--text-tertiary); font-variant-numeric: tabular-nums;
	}

	@media (max-width: 720px) {
		.plan-header { flex-wrap: wrap; }
		.plan-subtitle { display: none; }
		.plan-body { padding: var(--space-md); }
	}
</style>
