<!--
  BoardViewSwitch.svelte — The board header's Board | List control (card 2079).

  Board is every column side by side; List is one column at a time at full
  width, for a portrait monitor. Under 480 px it shows its icons only.
-->
<script lang="ts">
	import type { BoardViewName } from '$lib/board/board-view';

	let { view, onChange }: { view: BoardViewName; onChange: (view: BoardViewName) => void } = $props();
</script>

<div class="view-switch" role="group" aria-label="Board layout">
	<button
		class:active={view === 'board'}
		aria-pressed={view === 'board'}
		aria-label="Board"
		title="Board: every column side by side"
		onclick={() => onChange('board')}
	>
		<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<rect x="1.5" y="2" width="3.5" height="12" rx="1" stroke="currentColor" stroke-width="1.3"/>
			<rect x="6.25" y="2" width="3.5" height="8" rx="1" stroke="currentColor" stroke-width="1.3"/>
			<rect x="11" y="2" width="3.5" height="10" rx="1" stroke="currentColor" stroke-width="1.3"/>
		</svg>
		<span class="view-label">Board</span>
	</button>
	<button
		class:active={view === 'list'}
		aria-pressed={view === 'list'}
		aria-label="List"
		title="List: one column at a time, at full width"
		onclick={() => onChange('list')}
	>
		<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<rect x="2" y="2" width="12" height="3" rx="1" stroke="currentColor" stroke-width="1.3"/>
			<rect x="2" y="6.5" width="12" height="3" rx="1" stroke="currentColor" stroke-width="1.3"/>
			<rect x="2" y="11" width="12" height="3" rx="1" stroke="currentColor" stroke-width="1.3"/>
		</svg>
		<span class="view-label">List</span>
	</button>
</div>

<style>
	/* The height of the header's other controls (.hdr-control in app.css). */
	.view-switch {
		display: inline-flex; flex-shrink: 0; height: 32px;
		border-radius: var(--radius-full); border: 1px solid var(--glass-border); overflow: hidden;
	}
	.view-switch button {
		display: inline-flex; align-items: center; gap: 6px;
		padding: 0 12px; background: var(--bg-surface); border: none;
		border-right: 1px solid var(--glass-border);
		color: var(--text-secondary); font-family: var(--font-family);
		font-size: 0.78rem; font-weight: 600; cursor: pointer; white-space: nowrap;
		transition: all var(--duration-fast) var(--ease-out);
	}
	.view-switch button:last-child { border-right: none; }
	.view-switch button:hover { background: var(--bg-elevated); color: var(--text-primary); }
	.view-switch button.active { background: var(--accent-indigo); color: #fff; }
	.view-switch button:focus-visible { outline: 2px solid var(--accent-indigo); outline-offset: -2px; }
	.view-switch svg { flex-shrink: 0; }

	@media (max-width: 480px) {
		.view-label { display: none; }
		.view-switch button { padding: 0 10px; }
	}
</style>
