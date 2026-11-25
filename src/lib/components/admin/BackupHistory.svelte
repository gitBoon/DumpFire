<!--
  BackupHistory.svelte — The Scheduled Backups panel's history of backups
  run: the last five, or all of them (card 2281, slice C1a: moved from
  src/routes/admin/+page.svelte).

  Whether all are shown is the panel's, bound here, so that it is kept while
  the panel reads its settings again (after Run Now) and this is drawn anew.

  A success with an error is an upload whose older copies retention could not
  remove (card 2941): ✅ then ⚠️ and the reason.

  Card 3076: the destination's type a kit outline badge (no fixed colours),
  Show all a kit button; the words in the text colours, the tone in the
  icons and the failed row's edge.
-->

<script lang="ts">
	import { formatBytes, formatDuration, formatRelativeTime, type BackupHistoryEntry } from '$lib/admin/format';
	import Badge from '$lib/components/ui/Badge.svelte';
	import Button from '$lib/components/ui/Button.svelte';

	let {
		backupHistory,
		showAllHistory = $bindable()
	}: {
		backupHistory: BackupHistoryEntry[];
		showAllHistory: boolean;
	} = $props();
</script>

{#if backupHistory.length > 0}
	<div class="backup-history">
		<div class="history-head">
			<h3 class="history-title">📜 Backup History</h3>
			<span class="history-count">{backupHistory.length} entries</span>
		</div>
		<div class="history-table-wrap">
			<table class="history-table">
				<thead>
					<tr>
						<th>When</th>
						<th>Destination</th>
						<th>Status</th>
						<th>Size</th>
						<th>Time</th>
					</tr>
				</thead>
				<tbody>
					{#each (showAllHistory ? backupHistory : backupHistory.slice(0, 5)) as entry (entry.id)}
						<tr class="history-row" class:history-failed={entry.status === 'failed'}>
							<td title={entry.createdAt}>{formatRelativeTime(entry.createdAt)}</td>
							<td>
								<Badge variant="outline" class="dest-type-badge-sm dest-type-{entry.destinationType}">{entry.destinationType}</Badge>
								{entry.destinationName}
							</td>
							<td>
								{#if entry.status === 'success'}
									<span class="status-success">✅</span>
									<!-- Uploaded, but its older copies were not removed (card 2941): what retention could not do. -->
									{#if entry.error}
										<span class="status-warning" title={entry.error}>⚠️ {entry.error.slice(0, 40)}{entry.error.length > 40 ? '...' : ''}</span>
									{/if}
								{:else}
									<span class="status-failed" title={entry.error || ''}>❌ {entry.error?.slice(0, 40)}{(entry.error?.length ?? 0) > 40 ? '...' : ''}</span>
								{/if}
							</td>
							<td>{formatBytes(entry.sizeBytes)}</td>
							<td>{formatDuration(entry.durationMs)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		{#if backupHistory.length > 5}
			<div class="history-more">
				<Button variant="ghost" size="sm" onclick={() => showAllHistory = !showAllHistory}>
					{showAllHistory ? '▲ Show less' : `▼ Show all ${backupHistory.length} entries`}
				</Button>
			</div>
		{/if}
	</div>
{/if}

<style>
	.history-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-sm);
		margin: var(--space-xl) 0 var(--space-sm);
	}
	.history-title {
		margin: 0;
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--ui-foreground);
	}
	.history-count {
		font-size: 0.75rem;
		color: var(--ui-muted-foreground);
	}

	/* History table */
	.history-table-wrap {
		overflow-x: auto;
		border: 1px solid var(--ui-border);
		border-radius: var(--ui-radius);
	}
	.history-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.8125rem;
	}
	.history-table th {
		height: 2.25rem;
		padding: 0 var(--space-md);
		border-bottom: 1px solid var(--ui-border);
		text-align: left;
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--ui-muted-foreground);
		white-space: nowrap;
	}
	.history-table td {
		padding: var(--space-xs) var(--space-md);
		border-bottom: 1px solid var(--ui-border);
		vertical-align: middle;
	}
	.history-row:last-child td {
		border-bottom: none;
	}
	.history-failed td:first-child {
		box-shadow: inset 3px 0 0 var(--ui-destructive);
	}

	.status-failed,
	.status-warning {
		font-size: 0.75rem;
		color: var(--ui-foreground);
	}
	.history-more {
		margin-top: var(--space-xs);
	}
</style>