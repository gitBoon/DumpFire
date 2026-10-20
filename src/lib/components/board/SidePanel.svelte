<!--
  SidePanel.svelte — The frame of the board page's side panels: the Activity
  Log and Archived Cards (card 2280, slice B3: moved from the board page).

  Beside the board, not over it: the page's panels area pushes the columns
  over. The heading and its close button, and a body that scrolls; what is
  in the body is the panel's own.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	let { title, onClose, children }: { title: string; onClose: () => void; children: Snippet } = $props();
</script>

<aside class="board-side-panel">
	<div class="board-side-panel-header">
		<h3>{title}</h3>
		<button class="btn-ghost" onclick={() => onClose()} title="Close">✕</button>
	</div>
	<div class="board-side-panel-body">
		{@render children()}
	</div>
</aside>

<style>
	/* Side panels — push content */
	.board-side-panel {
		width: 340px; height: 100vh; flex-shrink: 0;
		background: var(--bg-surface); border-left: 1px solid var(--glass-border);
		display: flex; flex-direction: column;
		animation: panelSlideIn 0.2s ease-out;
	}
	@keyframes panelSlideIn { from { transform: translateX(100%); } to { transform: translateX(0); } }
	.board-side-panel-header {
		display: flex; align-items: center; justify-content: space-between;
		padding: var(--space-md) var(--space-lg); border-bottom: 1px solid var(--glass-border);
		flex-shrink: 0;
	}
	.board-side-panel-header h3 { font-size: 0.9rem; font-weight: 700; margin: 0; }
	.board-side-panel-body { flex: 1; overflow-y: auto; padding: var(--space-md); }

	/* ─── Mobile Responsive ──────────────────────────────────────────────── */

	@media (max-width: 768px) {
		/* Side panels become full-width on mobile */
		.board-side-panel {
			width: 100% !important;
			height: 50vh;
		}

		/* Touch-friendly buttons */
		.btn-ghost {
			min-height: 36px;
			min-width: 36px;
		}
	}
</style>
