<!--
  AdminOverview.svelte — The admin page's Database Overview: how many boards,
  columns, cards, categories, users and teams there are, and the size of the
  database file (card 2281, slice C1b: moved from
  src/routes/admin/+page.svelte).

  Shown to every administrator, from what the page's load gave it.
-->
<script lang="ts">
	import type { PageData } from '../../../routes/admin/$types';
	import { formatBytes } from '$lib/admin/format';

	/** What the admin page's load gave it, passed on as it is. */
	let { data }: { data: PageData } = $props();
</script>

<!-- Database stats -->
<section class="admin-card glass fade-in-up" style="animation-delay: 0ms">
	<h2>📊 Database Overview</h2>
	<div class="stats-row">
		<div class="stat-item">
			<span class="stat-value">{data.boards.length}</span>
			<span class="stat-label">Boards</span>
		</div>
		<div class="stat-item">
			<span class="stat-value">{data.boards.reduce((s, b) => s + b.columnCount, 0)}</span>
			<span class="stat-label">Columns</span>
		</div>
		<div class="stat-item">
			<span class="stat-value">{data.boards.reduce((s, b) => s + b.cardCount, 0)}</span>
			<span class="stat-label">Cards</span>
		</div>
		<div class="stat-item">
			<span class="stat-value">{data.boards.reduce((s, b) => s + b.categoryCount, 0)}</span>
			<span class="stat-label">Categories</span>
		</div>
		<div class="stat-item">
			<span class="stat-value">{data.users.length}</span>
			<span class="stat-label">Users</span>
		</div>
		<div class="stat-item">
			<span class="stat-value">{data.teams.length}</span>
			<span class="stat-label">Teams</span>
		</div>
		<div class="stat-item">
			<span class="stat-value">{formatBytes(data.dbSizeBytes)}</span>
			<span class="stat-label">DB Size</span>
		</div>
	</div>
</section>

<style>
	.stats-row {
		display: flex; gap: var(--space-lg); flex-wrap: wrap;
	}
	.stat-item {
		display: flex; flex-direction: column; align-items: center; gap: 2px;
		padding: var(--space-md) var(--space-xl);
		background: var(--bg-base); border-radius: var(--radius-md);
		border: 1px solid var(--glass-border); flex: 1; min-width: 100px;
		transition: transform 0.2s ease, border-color 0.2s ease;
	}
	.stat-item:hover {
		transform: scale(1.03);
		border-color: var(--accent-indigo);
	}
	.stat-value { font-size: 1.8rem; font-weight: 800; color: var(--accent-indigo); }
	.stat-label { font-size: 0.72rem; text-transform: uppercase; font-weight: 600; color: var(--text-tertiary); letter-spacing: 0.05em; }
</style>
