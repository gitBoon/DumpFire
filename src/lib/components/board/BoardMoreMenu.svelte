<!--
  BoardMoreMenu.svelte — The board header's More menu (card 2280, slice B3:
  moved from the board page).

  The panels (Activity Log, Statistics, Archived Cards), and what is done to
  the board as a whole: Burndown, Manage Categories, Bulk Select, Share Board
  for someone who manages it, and Delete Sub-board when the board is one.
  Each item closes the menu after it hands its choice to the page; Delete
  Sub-board closes it first, as the page's confirmation opens. The menu
  holds no state of its own: whether it is open is the page's, which closes
  it on any click outside.
-->
<script lang="ts">
	let {
		open = $bindable(),
		showActivityPanel,
		showStatsPanel,
		showArchivePanel,
		selectionMode,
		canManage,
		isSubBoard,
		boardId,
		onToggleActivity,
		onToggleStats,
		onToggleArchive,
		onManageCategories,
		onToggleSelection,
		onShare,
		onDeleteSubBoard
	}: {
		open: boolean;
		showActivityPanel: boolean;
		showStatsPanel: boolean;
		showArchivePanel: boolean;
		selectionMode: boolean;
		canManage: boolean;
		/** The board is a sub-board: Delete Sub-board is offered. */
		isSubBoard: boolean;
		boardId: number;
		onToggleActivity: () => void;
		onToggleStats: () => void;
		onToggleArchive: () => void;
		onManageCategories: () => void;
		onToggleSelection: () => void;
		onShare: () => void;
		/** Asks first, in the page's confirmation. */
		onDeleteSubBoard: () => void;
	} = $props();
</script>

<!-- More menu (progressive disclosure) -->
<div class="more-menu-wrapper">
	<button class="hdr-control hdr-action more-menu-trigger" class:active-panel-btn={open} onclick={(e) => { e.stopPropagation(); open = !open; }} title="More actions">
		<svg width="14" height="14" viewBox="0 0 16 16" fill="none">
			<circle cx="3" cy="8" r="1.5" fill="currentColor"/>
			<circle cx="8" cy="8" r="1.5" fill="currentColor"/>
			<circle cx="13" cy="8" r="1.5" fill="currentColor"/>
		</svg>
		More
	</button>
	{#if open}
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="more-dropdown" onclick={(e) => e.stopPropagation()}>
			<div class="more-dropdown-section">
				<div class="more-dropdown-label">Panels</div>
				<button class="more-dropdown-item" class:more-active={showActivityPanel} onclick={() => { onToggleActivity(); open = false; }}>
					<span class="more-item-icon">📋</span> Activity Log
					{#if showActivityPanel}<span class="more-check">✓</span>{/if}
				</button>
				<button class="more-dropdown-item" class:more-active={showStatsPanel} onclick={() => { onToggleStats(); open = false; }}>
					<span class="more-item-icon">📊</span> Statistics
					{#if showStatsPanel}<span class="more-check">✓</span>{/if}
				</button>
				<button class="more-dropdown-item" class:more-active={showArchivePanel} onclick={() => { onToggleArchive(); open = false; }}>
					<span class="more-item-icon">🗄️</span> Archived Cards
					{#if showArchivePanel}<span class="more-check">✓</span>{/if}
				</button>
			</div>

			<div class="more-dropdown-divider"></div>

			<div class="more-dropdown-section">
				<div class="more-dropdown-label">Board</div>
				<a class="more-dropdown-item" href="/burndown?boardIds={boardId}" onclick={() => (open = false)}>
					<span class="more-item-icon">📉</span> Burndown
				</a>
				<button class="more-dropdown-item" onclick={() => { onManageCategories(); open = false; }}>
					<span class="more-item-icon">🏷️</span> Manage Categories
				</button>
				<button class="more-dropdown-item" class:more-active={selectionMode} onclick={() => { onToggleSelection(); open = false; }}>
					<span class="more-item-icon">☑️</span> Bulk Select
					{#if selectionMode}<span class="more-check">✓</span>{/if}
				</button>
				{#if canManage}
					<button class="more-dropdown-item" onclick={() => { onShare(); open = false; }}>
						<span class="more-item-icon">🔗</span> Share Board
					</button>
				{/if}
				{#if isSubBoard}
					<button class="more-dropdown-item more-danger" onclick={() => { open = false; onDeleteSubBoard(); }}>
						<span class="more-item-icon">🗑️</span> Delete Sub-board
					</button>
				{/if}
			</div>
		</div>
	{/if}
</div>

<style>
	/* More menu dropdown */
	.more-menu-wrapper { position: relative; }
	.more-menu-trigger { display: flex; align-items: center; gap: 6px; }
	.more-dropdown {
		position: absolute; top: calc(100% + 6px); right: 0;
		background: var(--bg-card); border: 1px solid var(--glass-border);
		border-radius: var(--radius-lg); min-width: 220px;
		box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25), 0 0 0 1px rgba(255, 255, 255, 0.04);
		z-index: 200; padding: var(--space-xs) 0;
		animation: moreDropdownIn 0.15s ease-out;
		backdrop-filter: blur(12px);
	}
	@keyframes moreDropdownIn {
		from { opacity: 0; transform: translateY(-6px) scale(0.97); }
		to { opacity: 1; transform: translateY(0) scale(1); }
	}
	.more-dropdown-section { padding: var(--space-xs) 0; }
	.more-dropdown-label {
		font-size: 0.62rem; font-weight: 700; text-transform: uppercase;
		letter-spacing: 0.08em; color: var(--text-tertiary);
		padding: var(--space-xs) var(--space-md) 4px;
	}
	.more-dropdown-divider {
		height: 1px; background: var(--glass-border);
		margin: var(--space-xs) var(--space-md);
	}
	.more-dropdown-item {
		display: flex; align-items: center; gap: var(--space-sm);
		width: 100%; padding: 7px var(--space-md);
		border: none; background: transparent;
		color: var(--text-secondary); font-size: 0.82rem; font-weight: 500;
		font-family: var(--font-family); cursor: pointer;
		text-decoration: none; text-align: left;
		transition: all 0.1s ease;
	}
	.more-dropdown-item:hover {
		background: rgba(99, 102, 241, 0.08); color: var(--text-primary);
	}
	.more-dropdown-item.more-active {
		color: var(--accent-indigo); font-weight: 600;
	}
	.more-dropdown-item.more-danger { color: var(--text-tertiary); }
	.more-dropdown-item.more-danger:hover {
		color: var(--accent-rose); background: rgba(244, 63, 94, 0.08);
	}
	.more-item-icon { font-size: 0.9rem; width: 20px; text-align: center; flex-shrink: 0; }
	.more-check {
		margin-left: auto; font-size: 0.75rem; font-weight: 700;
		color: var(--accent-indigo);
	}

	/* Active panel button */
	.active-panel-btn { background: rgba(99, 102, 241, 0.12) !important; color: var(--accent-indigo) !important; }

	/* ─── Mobile Responsive ──────────────────────────────────────────────── */

	@media (max-width: 768px) {
		/* Touch-friendly buttons */
		.more-dropdown-item {
			padding: var(--space-md) var(--space-lg) !important;
			min-height: 40px;
		}
	}
</style>
