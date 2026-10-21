<!--
  TasksActivityPanel.svelte — All Tasks' Activity Log: what was done on
  every board, newest first, an item that arrived since the last read
  pulsing for 30 seconds, an API badge for what was done through the API
  (card 2281, slice C3a-2: moved from src/routes/all/+page.svelte).

  Whether it is open is the page's (`activityOpen`, bound here), which the
  More menu shows and the page's live stream reads: a live event reads the
  list again while it is open. `toggleActivity` and `fetchActivity` are
  exported: the page reaches them with `bind:this`. Drawn always, so the
  list read is kept while the panel is shut, as before; drawn first in the
  page's panels area, where it was.
-->
<script lang="ts">
	import { onDestroy } from 'svelte';
	import { browser } from '$app/environment';
	import { parseUTC } from '$lib/utils/date-utils';
	import { activityLabel } from '$lib/utils/activity-labels';
	import { failureMessage } from '$lib/api';

	/** The page's: whether the Activity Log is open, remembered in this browser. */
	let { activityOpen = $bindable() }: { activityOpen: boolean } = $props();

	let activityItems = $state<any[]>([]);
	let activityLoading = $state(false);
	/** Why the latest read failed, shown in the panel until a read is answered (card 2317); '' when it did not. */
	let activityError = $state('');
	let knownActivityIds = new Set<number>();
	let newActivityIds = $state(new Set<number>());
	/**
	 * Whether a read has been answered: what was seen is seeded by the first
	 * one that is, not the first one sent. A first read that failed seeded
	 * nothing, and the next took every item as new (card 2356).
	 */
	let seeded = false;
	/** Each pulse's 30-second timer, ended with the panel, after which a read answered starts none (card 2356: they outlived it). */
	const pulseTimers = new Set<ReturnType<typeof setTimeout>>();
	let gone = false;

	onDestroy(() => {
		gone = true;
		for (const timer of pulseTimers) clearTimeout(timer);
		pulseTimers.clear();
	});

	export function toggleActivity() {
		activityOpen = !activityOpen;
		if (browser) localStorage.setItem('df-activity-open', String(activityOpen));
		if (activityOpen && activityItems.length === 0) fetchActivity(true);
	}

	/**
	 * Read the list. A refusal is said in the server's words, no answer as no
	 * answer, and an answer that is not the list (a proxy's page) as one that
	 * could not be read, in the panel in place of "No activity yet"; a list
	 * read before stays under it (card 2317: each was dropped without a word).
	 */
	export async function fetchActivity(initial = false) {
		activityLoading = true;
		try {
			let res: Response;
			try {
				res = await fetch('/api/activity');
			} catch {
				activityError = 'No answer from the server. The activity could not be loaded.';				return;
			}
			if (!res.ok) {
				activityError = await failureMessage(res, 'The activity could not be loaded.');
				return;
			}
			let items: any[];
			try {
				items = await res.json();
			} catch {
				activityError = "The server's answer could not be read. The activity could not be loaded.";
				return;
			}
			activityError = '';
			if (initial || !seeded) {
				// First load answered — seed known IDs, nothing is "new"
				knownActivityIds = new Set(items.map((i: any) => i.id));
				newActivityIds = new Set();
				seeded = true;
			} else {
				// Subsequent loads — detect new items
				const freshIds = new Set<number>();
				for (const item of items) {
					if (!knownActivityIds.has(item.id)) {
						freshIds.add(item.id);
						knownActivityIds.add(item.id);
					}
				}
				if (freshIds.size > 0 && !gone) {
					newActivityIds = new Set([...newActivityIds, ...freshIds]);
					// Clear the pulse after 30 seconds
					const timer = setTimeout(() => {
						pulseTimers.delete(timer);
						newActivityIds = new Set([...newActivityIds].filter(id => !freshIds.has(id)));
					}, 30000);
					pulseTimers.add(timer);
				}
			}
			activityItems = items;
		} finally {
			activityLoading = false;
		}
	}

	function formatActivityTime(dateStr: string) {
		if (!dateStr) return '';
		const d = parseUTC(dateStr);
		const now = new Date();
		const diffMs = now.getTime() - d.getTime();
		const mins = Math.floor(diffMs / 60000);
		if (mins < 1) return 'just now';
		if (mins < 60) return `${mins}m ago`;
		const hrs = Math.floor(mins / 60);
		if (hrs < 24) return `${hrs}h ago`;
		const days = Math.floor(hrs / 24);
		if (days < 7) return `${days}d ago`;
		return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
	}

	// An action's words are `activityLabel`'s, the board page's too (card 2212).
	// Whether it was done through the API is this panel's own badge.
	function isApiAction(action: string): boolean {
		return action.startsWith('api:');
	}
</script>

{#if activityOpen}
<div class="activity-panel">
	<div class="activity-panel-header">
		<h3>
			<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 3h10M2 5.5h7M2 8h8M2 10.5h5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
			Activity
		</h3>
		<div style="display:flex;gap:4px;">
			<button class="activity-refresh-btn" onclick={() => fetchActivity()} title="Refresh">
				<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2.5 7a4.5 4.5 0 0 1 8.5-2M11.5 7a4.5 4.5 0 0 1-8.5 2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M11 2v3h-3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 12V9h3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
			</button>
			<button class="activity-refresh-btn" onclick={toggleActivity} title="Close">
				<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
			</button>
		</div>
	</div>
	<div class="activity-list">
		{#if activityLoading}
			<div class="activity-loading">Loading activity...</div>
		{:else}
			{#if activityError}
				<div class="activity-error" role="alert">{activityError}</div>
			{/if}
			{#if activityItems.length === 0 && !activityError}
				<div class="activity-empty">No activity yet</div>
			{/if}
			{#each activityItems as item}
				<div class="activity-item" class:activity-new={newActivityIds.has(item.id)}>
					<div class="activity-avatar">{item.userEmoji || '👤'}</div>
					<div class="activity-body">
						<div class="activity-action-line">
							<span class="activity-action-label">{item.userName || 'System'}</span>
							{activityLabel(item.action)}
							{#if isApiAction(item.action)}
								<span class="activity-api-badge">API</span>
							{/if}
						</div>
						{#if item.detail}
							<div class="activity-detail">{item.detail}</div>
						{/if}
						<div class="activity-meta">
							<span>{formatActivityTime(item.createdAt)}</span>
							{#if item.boardName}
								<span class="activity-board-tag">{item.boardName}</span>
							{/if}
						</div>
					</div>
				</div>
			{/each}
		{/if}
	</div>
</div>
{/if}

<style>
	/* Activity Panel */
	.activity-panel-header h3 svg {
		opacity: 0.6;
	}
	.activity-item {
		display: flex;
		gap: 10px;
		padding: 10px 20px;
		transition: background 0.15s, border-color 0.15s;
		border-left: 3px solid transparent;
	}
	.activity-item:hover {
		background: var(--glass-hover);
	}
	.activity-item.activity-new {
		border-left-color: var(--accent-indigo, #6366f1);
		animation: activityPulse 2s ease-in-out infinite;
	}
	@keyframes activityPulse {
		0%, 100% { background: transparent; }
		50% { background: rgba(99, 102, 241, 0.08); }
	}
	.activity-avatar {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		background: var(--glass-hover);
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 14px;
		flex-shrink: 0;
		margin-top: 2px;
	}
	.activity-body {
		flex: 1;
		min-width: 0;
	}
	.activity-action-line {
		font-size: 0.78rem;
		color: var(--text-primary);
		line-height: 1.3;
	}
	.activity-action-label {
		font-weight: 600;
	}
	.activity-api-badge {
		display: inline-block;
		padding: 1px 5px;
		background: var(--glass-hover);
		color: var(--accent-indigo);
		border-radius: 3px;
		font-size: 0.6rem;
		font-weight: 700;
		text-transform: uppercase;
		margin-left: 4px;
		vertical-align: middle;
	}
	.activity-detail {
		font-size: 0.72rem;
		color: var(--text-secondary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		margin-top: 2px;
	}
	.activity-meta {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 3px;
		font-size: 0.68rem;
		color: var(--text-secondary);
	}
	.activity-board-tag {
		padding: 1px 5px;
		background: var(--bg-elevated);
		border-radius: 3px;
		font-size: 0.65rem;
		color: var(--text-secondary);
	}
</style>
