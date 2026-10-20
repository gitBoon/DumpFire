<!--
  BackupHistory.svelte — The Scheduled Backups panel's history of backups
  run: the last five, or all of them (card 2281, slice C1a: moved from
  src/routes/admin/+page.svelte).

  Whether all are shown is the panel's, bound here, so that it is kept while
  the panel reads its settings again (after Run Now) and this is drawn anew.
-->
<script lang="ts">
	import { formatBytes, formatDuration, formatRelativeTime, type BackupHistoryEntry } from '$lib/admin/format';

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
		<div style="display: flex; align-items: center; justify-content: space-between; margin: var(--space-xl) 0 var(--space-md)">
			<h3 style="font-size: 0.85rem; margin: 0">📜 Backup History</h3>
			<div style="display: flex; gap: var(--space-sm); align-items: center">
				<span style="font-size: 0.7rem; color: var(--text-tertiary)">{backupHistory.length} entries</span>
			</div>
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
								<span class="dest-type-badge-sm dest-type-{entry.destinationType}">{entry.destinationType}</span>
								{entry.destinationName}
							</td>
							<td>
								{#if entry.status === 'success'}
									<span class="status-success">✅</span>
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
			<button class="btn-ghost btn-sm" style="margin-top: var(--space-sm); font-size: 0.72rem" onclick={() => showAllHistory = !showAllHistory}>
				{showAllHistory ? '▲ Show less' : `▼ Show all ${backupHistory.length} entries`}
			</button>
		{/if}
	</div>
{/if}

<style>
	.dest-type-badge-sm {
		font-size: 0.6rem; font-weight: 700; padding: 1px 5px;
		border-radius: 3px; white-space: nowrap;
	}

	/* History table */
	.history-table-wrap {
		overflow-x: auto; border-radius: var(--radius-md);
		border: 1px solid var(--glass-border);
	}
	.history-table {
		width: 100%; border-collapse: collapse; font-size: 0.75rem;
	}
	.history-table th {
		text-align: left; padding: var(--space-sm) var(--space-md);
		font-weight: 600; font-size: 0.68rem; text-transform: uppercase;
		letter-spacing: 0.05em; color: var(--text-tertiary);
		background: var(--bg-base); border-bottom: 1px solid var(--glass-border);
	}
	.history-table td {
		padding: var(--space-xs) var(--space-md);
		border-bottom: 1px solid var(--glass-border);
		vertical-align: middle;
	}
	.history-row:last-child td { border-bottom: none; }
	.history-failed { opacity: 0.85; }
	.history-failed td:first-child { border-left: 3px solid var(--accent-rose); }

	.status-success { color: var(--accent-emerald); }
	.status-failed { color: var(--accent-rose); font-size: 0.68rem; }
</style>
