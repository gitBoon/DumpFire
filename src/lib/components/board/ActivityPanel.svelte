<!--
  ActivityPanel.svelte — Side panel showing the board's activity log.

  Slides in from the right when the activity button is toggled.
  Shows a chronological list of events (card created, moved, completed, etc.)
  with user avatars and relative timestamps.
-->
<script lang="ts">
  import type { ActivityType } from '$lib/types';
  import { getRelativeAge } from '$lib/utils/date-utils';
  import { getActionLabel } from '$lib/utils/card-utils';

  /**
   * @prop activities — The list of activity log entries to display
   * @prop loading — Whether activities are currently being fetched
   * @prop tick — Reactive tick counter for live-updating relative timestamps
   * @prop onClose — Callback to close the panel
   */
  let {
    activities = [],
    loading = false,
    tick = 0,
    onClose
  }: {
    activities: ActivityType[];
    loading: boolean;
    tick: number;
    onClose: () => void;
  } = $props();
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="panel-overlay" onclick={onClose}></div>
<aside class="side-panel glass">
  <div class="panel-header">
    <h3>📋 Activity Log</h3>
    <button class="btn-ghost close-btn" onclick={onClose}>✕</button>
  </div>
  <div class="panel-body">
    {#if loading}
      <p class="panel-empty">Loading...</p>
    {:else if activities.length === 0}
      <p class="panel-empty">No activity yet.</p>
    {:else}
      {#each activities as activity}
        <div class="activity-item">
          <span class="activity-emoji">{activity.userEmoji}</span>
          <div class="activity-info">
            <span class="activity-action">{getActionLabel(activity.action)}</span>
            <span class="activity-detail">{activity.detail}</span>
            <span class="activity-time">{getRelativeAge(activity.createdAt, tick)} · {activity.userName}</span>
          </div>
        </div>
      {/each}
    {/if}
  </div>
</aside>

<style>
  .panel-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.3);
    z-index: 90;
  }
  .side-panel {
    position: fixed; top: 0; right: 0; bottom: 0; width: 360px;
    z-index: 91; display: flex; flex-direction: column;
    border-left: 1px solid var(--glass-border);
    background: var(--bg-base) !important;
    animation: panelSlide 0.2s ease-out;
  }
  @keyframes panelSlide { from { transform: translateX(100%); } to { transform: translateX(0); } }
  .panel-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: var(--space-md) var(--space-lg); border-bottom: 1px solid var(--glass-border);
  }
  .panel-header h3 { font-size: 1rem; font-weight: 700; }
  .panel-body { flex: 1; overflow-y: auto; padding: var(--space-md); }
  .panel-empty { color: var(--text-tertiary); text-align: center; padding: var(--space-xl); font-size: 0.85rem; }

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
</style>
