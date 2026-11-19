<!--
  AdminOverview.svelte — The admin page's Database Overview: how many boards,
  columns, cards, categories, users and teams there are, and the size of the
  database file (card 2281, slice C1b: moved from
  src/routes/admin/+page.svelte). And the free space on the uploads volume,
  the line below which uploads are refused, and whether they are (card 2920).

  Shown to every administrator, from what the page's load gave it.
-->
<script lang="ts">
	import type { PageData } from '../../../routes/admin/$types';
	import { formatBytes } from '$lib/admin/format';

	/** What the admin page's load gave it, passed on as it is. */
	let { data }: { data: PageData } = $props();

	const GB = 1024 * 1024 * 1024;
	/** A disk's size: in GB from one GB up, as formatBytes below it; a full disk is 0 B, and only a figure not read is "—". */
	const diskSize = (bytes: number | null) =>
		bytes === null ? '—' : bytes === 0 ? '0 B' : bytes >= GB ? `${(bytes / GB).toFixed(1)} GB` : formatBytes(bytes);
	const space = $derived(data.uploadsSpace);
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
		<div class="stat-item">
			<span class="stat-value">{diskSize(space.freeBytes)}</span>
			<span class="stat-label">Uploads Disk Free</span>
		</div>
	</div>
	{#if space.state === 'room'}
		<p class="space-line">
			Uploads disk: {diskSize(space.freeBytes)} free of {diskSize(space.totalBytes)}. Uploads are refused when less than {diskSize(space.refusedBelowBytes)} is free.
		</p>
	{:else if space.state === 'low' && space.lowBecause === 'inodes'}
		<p class="space-line space-alert" role="alert">
			Uploads are refused: the uploads disk has {space.freeInodes} free inodes (file entries), below 1,000. Delete files or grow the volume.
		</p>
	{:else if space.state === 'low' && space.lowBecause === 'full'}
		<p class="space-line space-alert" role="alert">
			Uploads are refused: an upload found the uploads disk full. {diskSize(space.freeBytes)} free of {diskSize(space.totalBytes)} now; uploads are accepted again when more is free than before it filled, or 5 minutes after.
		</p>
	{:else if space.state === 'low'}
		<p class="space-line space-alert" role="alert">
			Uploads are refused: {diskSize(space.freeBytes)} free of {diskSize(space.totalBytes)}, below {diskSize(space.refusedBelowBytes)} (1 GB plus twice the database's size, and room for a 25 MB upload). Free some space or grow the volume.
		</p>
	{:else}
		<p class="space-line space-alert" role="alert">
			Uploads are refused: the free space on the uploads disk could not be read. The system log says why.
		</p>
	{/if}
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
	.space-line { margin: var(--space-md) 0 0; font-size: 0.85rem; color: var(--text-secondary); }
	.space-alert { color: var(--accent-rose); font-weight: 600; }
	.stat-label { font-size: 0.72rem; text-transform: uppercase; font-weight: 600; color: var(--text-tertiary); letter-spacing: 0.05em; }
</style>
