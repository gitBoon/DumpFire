<!--
  ActivityPanel.svelte — The board page's Activity Log panel (card 2280, slice
  B3: moved from the board page).

  The board's entries as the page read them when the panel was opened, each
  named in All Tasks' words, from one table (card 2212). It reads nothing
  itself: the page does, and closes it.
-->
<script lang="ts">
	import type { ActivityType } from '$lib/types';
	import { parseStamp } from '$lib/timestamps';
	import { activityLabel } from '$lib/utils/activity-labels';
	import SidePanel from './SidePanel.svelte';

	let { activities, loading, onClose }: { activities: ActivityType[]; loading: boolean; onClose: () => void } = $props();
</script>

<SidePanel title="📋 Activity Log" {onClose}>
	{#if loading}
		<p class="panel-empty">Loading...</p>
	{:else if activities.length === 0}
		<p class="panel-empty">No activity yet.</p>
	{:else}
		{#each activities as activity}
			<div class="activity-item">
				<span class="activity-emoji">{activity.userEmoji}</span>
				<div class="activity-info">
					<!-- All Tasks' words, from one table (card 2212). -->
					<span class="activity-action">{activityLabel(activity.action)}</span>
					<span class="activity-detail">{activity.detail}</span>
					<span class="activity-time">{parseStamp(activity.createdAt)?.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) ?? ''} · {activity.userName}</span>
				</div>
			</div>
		{/each}
	{/if}
</SidePanel>

<style>
	/* Activity items (inline in board page now) */
	.activity-item {
		display: flex; gap: var(--space-sm); padding: var(--space-sm);
		border-radius: var(--radius-sm); transition: background 0.15s;
	}
	.activity-item:hover { background: var(--glass-bg); }
	.activity-emoji { font-size: 1.2rem; flex-shrink: 0; }
	.activity-info { display: flex; flex-direction: column; min-width: 0; }
	.activity-action { font-weight: 600; font-size: 0.78rem; }
	.activity-detail { font-size: 0.75rem; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.activity-time { font-size: 0.65rem; color: var(--text-tertiary); }
	.panel-empty { color: var(--text-tertiary); text-align: center; padding: var(--space-xl); font-size: 0.85rem; }
</style>
