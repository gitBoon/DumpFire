<!--
  AdminOverview.svelte — The admin page's Database Overview: how many boards,
  columns, cards, categories, users and teams there are, and the size of the
  database file (card 2281, slice C1b: moved from
  src/routes/admin/+page.svelte). And the free space on the uploads volume,
  the line below which uploads are refused, and whether they are (card 2920).

  Shown to every administrator, from what the page's load gave it.

  Card 3076: a kit card at the page's #overview, the figures as Stat tiles
  (the counts count up only where the browser draws the page; the sizes are
  shown as they are), and the uploads line in the kit's notice look.
-->
<script lang="ts">
	import type { PageData } from '../../../routes/admin/$types';
	import { formatBytes } from '$lib/admin/format';
	import Card from '$lib/components/ui/Card.svelte';
	import CardContent from '$lib/components/ui/CardContent.svelte';
	import CardHeader from '$lib/components/ui/CardHeader.svelte';
	import CardTitle from '$lib/components/ui/CardTitle.svelte';
	import Stat from '$lib/components/ui/Stat.svelte';

	/** What the admin page's load gave it, passed on as it is. */
	let { data }: { data: PageData } = $props();

	const GB = 1024 * 1024 * 1024;
	/** A disk's size: in GB from one GB up, as formatBytes below it; a full disk is 0 B, and only a figure not read is "—". */
	const diskSize = (bytes: number | null) =>
		bytes === null ? '—' : bytes === 0 ? '0 B' : bytes >= GB ? `${(bytes / GB).toFixed(1)} GB` : formatBytes(bytes);
	const space = $derived(data.uploadsSpace);
</script>

<!-- Database stats -->
<Card as="section" id="overview" class="admin-section" aria-labelledby="overview-title">
	<CardHeader>
		<CardTitle level={2} id="overview-title">Database Overview</CardTitle>
	</CardHeader>
	<CardContent>
		<div class="stats-grid">
			<div class="stat-tile"><Stat label="Boards" value={data.boards.length} /></div>
			<div class="stat-tile"><Stat label="Columns" value={data.boards.reduce((s, b) => s + b.columnCount, 0)} /></div>
			<div class="stat-tile"><Stat label="Cards" value={data.boards.reduce((s, b) => s + b.cardCount, 0)} /></div>
			<div class="stat-tile"><Stat label="Categories" value={data.boards.reduce((s, b) => s + b.categoryCount, 0)} /></div>
			<div class="stat-tile"><Stat label="Users" value={data.users.length} /></div>
			<div class="stat-tile"><Stat label="Teams" value={data.teams.length} /></div>
			<div class="stat-tile"><Stat label="DB Size" value={formatBytes(data.dbSizeBytes)} /></div>
			<div class="stat-tile"><Stat label="Uploads Disk Free" value={diskSize(space.freeBytes)} /></div>
		</div>
		{#if space.state === 'room'}
			<p class="space-line admin-note">
				Uploads disk: {diskSize(space.freeBytes)} free of {diskSize(space.totalBytes)}. Uploads are refused when less than {diskSize(space.refusedBelowBytes)} is free.
			</p>
		{:else if space.state === 'low' && space.lowBecause === 'inodes'}
			<p class="space-line space-alert admin-notice admin-notice-destructive" role="alert">
				Uploads are refused: the uploads disk has {space.freeInodes} free inodes (file entries), below 1,000. Delete files or grow the volume.
			</p>
		{:else if space.state === 'low' && space.lowBecause === 'full'}
			<p class="space-line space-alert admin-notice admin-notice-destructive" role="alert">
				Uploads are refused: an upload found the uploads disk full. {diskSize(space.freeBytes)} free of {diskSize(space.totalBytes)} now; uploads are accepted again when more is free than before it filled, or 5 minutes after.
			</p>
		{:else if space.state === 'low'}
			<p class="space-line space-alert admin-notice admin-notice-destructive" role="alert">
				Uploads are refused: {diskSize(space.freeBytes)} free of {diskSize(space.totalBytes)}, below {diskSize(space.refusedBelowBytes)} (1 GB plus twice the database's size, and room for a 25 MB upload). Free some space or grow the volume.
			</p>
		{:else}
			<p class="space-line space-alert admin-notice admin-notice-destructive" role="alert">
				Uploads are refused: the free space on the uploads disk could not be read. The system log says why.
			</p>
		{/if}
	</CardContent>
</Card>

<style>
	.stats-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr));
		gap: var(--space-sm);
	}
	.stat-tile {
		min-width: 0;
		padding: var(--space-md);
		border: 1px solid var(--ui-border);
		border-radius: var(--ui-radius);
		background: var(--ui-background);
	}
	.space-line {
		margin-top: var(--space-md);
	}
	.space-alert {
		font-weight: 500;
	}
</style>