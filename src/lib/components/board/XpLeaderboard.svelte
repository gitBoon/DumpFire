<!--
  XpLeaderboard.svelte — The board header's XP bars (card 2280, slice B3:
  moved from the board page).

  Each person's level and their progress towards the next, highest first,
  as the page last read them. Drawn only once someone has XP; hidden under
  768 px.
-->
<script lang="ts">
	import type { XpEntry } from '$lib/types';
	import { getLevel, getXpProgress } from '$lib/board/xp-utils';

	let { entries }: { entries: XpEntry[] } = $props();

	// A sorted copy (card 2304). Sorting `entries` itself writes to the page's
	// state while drawing, which Svelte refuses once there are two people.
	const ranked = $derived([...entries].sort((a, b) => b.xp - a.xp));
</script>

{#if entries.length > 0}
	<div class="xp-bar-container">
		{#each ranked as entry (entry.name)}
			{@const level = getLevel(entry.xp)}
			{@const progress = getXpProgress(entry.xp)}
			<div class="xp-entry" title="{entry.name}: {entry.xp} XP (Level {level})">
				<span class="xp-avatar">{entry.emoji}</span>
				<div class="xp-info">
					<div class="xp-name-row">
						<span class="xp-name">{entry.name}</span>
						<span class="xp-level">Lv.{level}</span>
					</div>
					<div class="xp-track">
						<div class="xp-fill" style="width: {progress}%"></div>
					</div>
				</div>
			</div>
		{/each}
	</div>
{/if}

<style>
	/* XP Bars */
	.xp-bar-container {
		display: flex; gap: var(--space-md); align-items: center;
		flex: 1; justify-content: center; max-width: 500px;
		min-width: 0; overflow-x: auto;
	}
	.xp-entry {
		display: flex; align-items: center; gap: 6px;
		padding: 4px 8px; border-radius: var(--radius-md);
		background: var(--glass-bg); border: 1px solid var(--glass-border);
		min-width: 120px; flex-shrink: 0;
	}
	.xp-avatar { font-size: 1rem; flex-shrink: 0; }
	.xp-info { flex: 1; min-width: 0; }
	.xp-name-row { display: flex; justify-content: space-between; align-items: center; gap: 4px; }
	.xp-name { font-size: 0.65rem; font-weight: 600; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.xp-level {
		font-size: 0.6rem; font-weight: 800; color: var(--accent-amber);
		background: rgba(245, 158, 11, 0.1); padding: 0 4px; border-radius: var(--radius-full);
		white-space: nowrap;
	}
	.xp-track {
		height: 4px; background: var(--bg-base); border-radius: var(--radius-full);
		margin-top: 3px; overflow: hidden;
	}
	.xp-fill {
		height: 100%; border-radius: var(--radius-full);
		background: linear-gradient(90deg, var(--accent-indigo), var(--accent-purple));
		transition: width var(--duration-normal) var(--ease-out);
	}

	/* ─── Mobile Responsive ──────────────────────────────────────────────── */

	@media (max-width: 768px) {
		.xp-bar-container { display: none; }
	}
</style>
